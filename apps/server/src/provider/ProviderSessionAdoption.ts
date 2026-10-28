import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RetainedProviderWork from "../orchestration-v2/RetainedProviderWork.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";

export class ProviderSessionAdoptionError extends Schema.TaggedError<ProviderSessionAdoptionError>()(
  "ProviderSessionAdoptionError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Cannot restore the retained provider sessions.";
  }
}

export class ProviderSessionAdoption extends Context.Service<
  ProviderSessionAdoption,
  {
    readonly prepare: Effect.Effect<
      {
        readonly resumeReplay: Effect.Effect<void, ProviderSessionAdoptionError>;
        readonly awaitStartup: Effect.Effect<void, ProviderSessionAdoptionError>;
      },
      ProviderSessionAdoptionError
    >;
    readonly prepareForShutdown: Effect.Effect<void, ProviderSessionAdoptionError>;
    readonly activate: (mcpEndpoint: string) => Effect.Effect<void, ProviderSessionAdoptionError>;
  }
>()("t3/provider/ProviderSessionAdoption") {}

const make = Effect.gen(function* () {
  const client = yield* ProviderSessionTransport.ProviderSessionClient;
  const credentials = yield* McpSessionRegistry.McpSessionRegistry;
  const configurations = yield* McpProviderSessions.McpProviderSessions;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const turns = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const transport = yield* Effect.serviceOption(ProviderPrivateTransport.HostTransportConfig);
  const scope = yield* Scope.Scope;
  const retainedWork = yield* Effect.serviceOption(RetainedProviderWork.RetainedProviderWork);
  const failure = (cause: unknown) => new ProviderSessionAdoptionError({ cause });
  const prepare = yield* Effect.cached(
    Effect.gen(function* () {
      const retained = yield* client["session.list"]({});
      const snapshots = yield* client["mcp.credentials"]({});
      const configs = yield* client["mcp.configurations"]({});
      yield* credentials.restore(snapshots);
      for (const config of configs) {
        const { capabilities, ...fields } = config;
        yield* configurations.set({
          ...fields,
          ...(capabilities === undefined ? {} : { capabilities: new Set(capabilities) }),
        });
      }
      const runtimes: Adapter.ProviderAdapterV2SessionRuntime[] = [];
      const workers: Fiber.Fiber<void, ProviderTurnStartService.ProviderTurnStartError>[] = [];
      for (const descriptor of retained) {
        const runtime = yield* sessions.open(descriptor.openInput);
        if (runtime.eventDelivery === undefined)
          return yield* failure("A retained session opened without hosted event delivery.");
        runtimes.push(runtime);
        for (const consumer of descriptor.runConsumers) {
          const projection = yield* projections.getThreadProjection(consumer.threadId);
          const attempt = projection.attempts.find(
            (attempt) => attempt.id === consumer.attemptId && attempt.runId === consumer.runId,
          );
          if (attempt === undefined)
            return yield* failure("A retained consumer has no persisted attempt.");
          const terminal = descriptor.lastTerminals.find(
            (terminal) => terminal.providerTurnId === attempt.providerTurnId,
          );
          const persistedTerminal =
            terminal !== undefined &&
            projection.providerTurns.some(
              (turn) =>
                turn.id === terminal.providerTurnId &&
                turn.runAttemptId === attempt.id &&
                turn.status === terminal.status,
            );
          const admitted = descriptor.turnOperations.some(
            (operation) =>
              operation.consumer.runId === consumer.runId &&
              operation.consumer.attemptId === consumer.attemptId,
          );
          if (!admitted && !persistedTerminal)
            return yield* failure("A retained consumer has no admitted startup operation.");
          const ready = yield* Deferred.make<
            void,
            ProviderTurnStartService.ProviderTurnStartError
          >();
          const worker = yield* turns
            .adopt({
              threadId: consumer.threadId,
              runId: consumer.runId,
              attemptId: consumer.attemptId,
              session: runtime,
              ...(persistedTerminal ? { terminal } : {}),
              consumerReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
            })
            .pipe(
              Effect.tapCause((cause) => Deferred.failCause(ready, cause)),
              Effect.forkIn(scope),
            );
          workers.push(worker);
          yield* Deferred.await(ready);
        }
      }
      if (Option.isSome(retainedWork))
        yield* retainedWork.value.replace({
          sessionIds: retained.map((session) => session.providerSession.id),
          attemptIds: retained.flatMap((session) =>
            session.runConsumers.map((consumer) => consumer.attemptId),
          ),
        });
      return {
        resumeReplay: Effect.gen(function* () {
          for (const runtime of runtimes) yield* runtime.eventDelivery!.resume;
          for (const runtime of runtimes)
            yield* runtime.eventDelivery!.awaitCaughtUp ?? Effect.void;
        }).pipe(Effect.mapError(failure)),
        awaitStartup: Effect.forEach(workers, (worker) => Fiber.join(worker), {
          discard: true,
        }).pipe(
          Effect.andThen(outbox.settleRetainedStarts),
          Effect.asVoid,
          Effect.mapError(failure),
        ),
      };
    }).pipe(Effect.mapError(failure)),
  );
  const prepareForShutdown = Effect.gen(function* () {
    yield* client["mcp.pause"]({});
    yield* client["continuations.pause"]({});
    yield* client["mcp.drain"]({});
    yield* client["continuations.drain"]({});
    yield* client["mcp.checkpoint"]({ credentials: yield* credentials.checkpoint });
    const retained = yield* client["session.list"]({});
    if (Option.isSome(retainedWork))
      yield* retainedWork.value.replace({
        sessionIds: retained.map((session) => session.providerSession.id),
        attemptIds: retained.flatMap((session) =>
          session.runConsumers.map((consumer) => consumer.attemptId),
        ),
      });
  }).pipe(Effect.mapError(failure));
  const activate = Effect.fn("ProviderSessionAdoption.activate")(function* (mcpEndpoint: string) {
    if (Option.isNone(transport))
      return yield* failure("The provider host has no continuation transport.");
    yield* client["continuations.route"](
      ProviderPrivateTransport.continuationConfig(transport.value),
    );
    yield* client["mcp.route"]({ endpoint: mcpEndpoint });
  }, Effect.mapError(failure));
  return ProviderSessionAdoption.of({ prepare, prepareForShutdown, activate });
});

export const layer = Layer.effect(ProviderSessionAdoption, make);
