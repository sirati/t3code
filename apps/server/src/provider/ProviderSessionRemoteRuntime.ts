import type { ProviderSessionId } from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HostedProviderSession } from "./ProviderSessionHost.ts";
import { sessionMethods } from "./ProviderSessionMethods.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";

const isAdapterError = Schema.is(Adapter.ProviderAdapterV2Error);

export const connect = Effect.fn("ProviderSessionRemoteRuntime.connect")(function* (
  descriptor: HostedProviderSession,
  options: { readonly startPaused?: boolean } = {},
) {
  const client = yield* ProviderSessionTransport.ProviderSessionClient;
  const sessionId: ProviderSessionId = descriptor.providerSession.id;
  const owned = { sessionId, lease: descriptor.lease };
  const driver = descriptor.providerSession.driver;
  let latestSession = descriptor.providerSession;
  const failure = (cause: unknown) =>
    isAdapterError(cause)
      ? cause
      : new Adapter.ProviderAdapterProtocolError({
          driver,
          detail: "The persistent provider session could not complete the operation.",
          cause,
        });
  const bind = <I, A>(
    name: keyof typeof sessionMethods,
    definition: {
      readonly input: Schema.Codec<I, unknown>;
      readonly output: Schema.Codec<A, unknown>;
    },
  ) => {
    const encode = Schema.encodeEffect(definition.input);
    const decode = Schema.decodeUnknownEffect(definition.output);
    return Effect.fn(`ProviderSessionRemoteRuntime.${name}`)(function* (argument: I) {
      const encoded = yield* encode(argument);
      const response = yield* client["session.invoke"]({
        ...owned,
        method: name,
        argument: encoded,
      });
      return yield* decode(response);
    }, Effect.mapError(failure));
  };
  const deliveryStarted = yield* Deferred.make<void>();
  if (!options.startPaused) yield* Deferred.succeed(deliveryStarted, undefined);
  const receipts = new WeakMap<
    Adapter.ProviderAdapterV2Event,
    { incarnation: string; sequence: number }
  >();
  const envelopes = Stream.fromEffect(Deferred.await(deliveryStarted)).pipe(
    Stream.flatMap(() => client["session.events"]({ ...owned, after: 0 })),
    Stream.map((envelope) => {
      const event = { ...envelope.event };
      if (event.type === "provider_session.updated") latestSession = event.providerSession;
      receipts.set(event, { incarnation: descriptor.incarnation, sequence: envelope.sequence });
      return { ...envelope, event };
    }),
    Stream.mapError(failure),
  );
  const acknowledge = (through: number) =>
    client["session.acknowledge"]({ ...owned, through }).pipe(Effect.mapError(failure));
  const has = (method: string) => descriptor.methods.includes(method);
  // A transport outage must not make idle cleanup discard live provider work.
  const retainOnProbeFailure = <E>(probe: Effect.Effect<boolean, E>) =>
    probe.pipe(
      Effect.tapError(() =>
        Effect.logWarning("Could not query hosted provider background work", { sessionId }),
      ),
      Effect.orElseSucceed(() => true),
    );
  const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
    instanceId: descriptor.providerSession.providerInstanceId,
    driver,
    providerSessionId: sessionId,
    get providerSession() {
      return latestSession;
    },
    readContextPolicy: bind("readContextPolicy", sessionMethods.readContextPolicy),
    ...(descriptor.backgroundTasksEndWithProcess ? { backgroundTasksEndWithProcess: true } : {}),
    events: envelopes.pipe(Stream.map((envelope) => envelope.event)),
    eventDelivery: {
      receiptFor: (event) => receipts.get(event),
      acknowledge,
      resume: Deferred.succeed(deliveryStarted, undefined).pipe(Effect.asVoid),
    },
    ensureThread: bind("ensureThread", sessionMethods.ensureThread),
    resumeThread: bind("resumeThread", sessionMethods.resumeThread),
    startTurn: bind("startTurn", sessionMethods.startTurn),
    steerTurn: bind("steerTurn", sessionMethods.steerTurn),
    interruptTurn: bind("interruptTurn", sessionMethods.interruptTurn),
    respondToRuntimeRequest: bind(
      "respondToRuntimeRequest",
      sessionMethods.respondToRuntimeRequest,
    ),
    readThreadSnapshot: bind("readThreadSnapshot", sessionMethods.readThreadSnapshot),
    rollbackThread: bind("rollbackThread", sessionMethods.rollbackThread),
    forkThread: bind("forkThread", sessionMethods.forkThread),
    ...(has("compactThread")
      ? { compactThread: bind("compactThread", sessionMethods.compactThread) }
      : {}),
    ...(has("unloadThread")
      ? { unloadThread: bind("unloadThread", sessionMethods.unloadThread) }
      : {}),
    ...(has("uploadFeedback")
      ? { uploadFeedback: bind("uploadFeedback", sessionMethods.uploadFeedback) }
      : {}),
    ...(has("stopTask") ? { stopTask: bind("stopTask", sessionMethods.stopTask) } : {}),
    ...(has("awaitBackgroundTasks")
      ? { awaitBackgroundTasks: bind("awaitBackgroundTasks", sessionMethods.awaitBackgroundTasks) }
      : {}),
    ...(has("hasPendingBackgroundWork")
      ? {
          hasPendingBackgroundWork: retainOnProbeFailure(
            bind("hasPendingBackgroundWork", sessionMethods.hasPendingBackgroundWork)({}),
          ),
        }
      : {}),
    ...(has("hasPendingBackgroundWorkForThread")
      ? {
          hasPendingBackgroundWorkForThread: (providerThread, options) =>
            retainOnProbeFailure(
              bind(
                "hasPendingBackgroundWorkForThread",
                sessionMethods.hasPendingBackgroundWorkForThread,
              )({ providerThread, ...options }),
            ),
        }
      : {}),
    ...(has("stopSubagent")
      ? { stopSubagent: bind("stopSubagent", sessionMethods.stopSubagent) }
      : {}),
    ...(has("injectHistory")
      ? { injectHistory: bind("injectHistory", sessionMethods.injectHistory) }
      : {}),
    ...(has("listTools") && has("callTool") && has("readResource")
      ? {
          mcpApps: {
            listTools: bind("listTools", sessionMethods.listTools),
            callTool: bind("callTool", sessionMethods.callTool),
            readResource: bind("readResource", sessionMethods.readResource),
          },
        }
      : {}),
  };
  return {
    runtime,
    envelopes,
    readContextPolicy: bind("readContextPolicy", sessionMethods.readContextPolicy),
    acknowledge,
    detach: client["session.detach"](owned).pipe(Effect.mapError(failure)),
    close: client["session.close"](owned).pipe(Effect.mapError(failure)),
  };
});
