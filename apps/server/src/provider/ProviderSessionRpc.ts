import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";
import * as ProviderContinuationHost from "./ProviderContinuationHost.ts";
import * as ProviderSessionHost from "./ProviderSessionHost.ts";
import * as ProviderMcpIngress from "./ProviderMcpIngress.ts";
import { McpCredentialSnapshot } from "../mcp/McpCredentialSnapshot.ts";
import { ProviderSessionEnvelope } from "./ProviderSessionJournal.ts";
import { OpenHostedSessionInput, sessionMethods } from "./ProviderSessionMethods.ts";

const decodeRunConsumer = Schema.decodeUnknownEffect(Adapter.ProviderAdapterV2RunConsumer);

const isAdapterError = Schema.is(Adapter.ProviderAdapterV2Error);
const sequenceCursor = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const ownedSession = { sessionId: ProviderSessionId, lease: Schema.String };
const error = Schema.Union([
  ProviderSessionHost.ProviderSessionHostError,
  Adapter.ProviderAdapterV2Error,
]);
const methodNames = Object.keys(sessionMethods) as Array<keyof typeof sessionMethods>;
const mcpConfig = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  endpoint: Schema.String,
  authorizationHeader: Schema.String,
  browserToolsAvailable: Schema.Boolean,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  agentDeviceEnvironment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export const ProviderSessionRpc = RpcGroup.make(
  Rpc.make("continuations.route", {
    payload: Schema.Struct({ endpoint: Schema.String, token: Schema.String }),
    success: Schema.Void,
    error: ProviderContinuationHost.ProviderContinuationHostError,
  }),
  Rpc.make("continuations.pause", { payload: Schema.Struct({}), success: Schema.Void }),
  Rpc.make("continuations.drain", { payload: Schema.Struct({}), success: Schema.Void }),
  Rpc.make("mcp.checkpoint", {
    payload: Schema.Struct({ credentials: Schema.Array(McpCredentialSnapshot) }),
    success: Schema.Void,
  }),
  Rpc.make("mcp.configurations", {
    payload: Schema.Struct({}),
    success: Schema.Array(mcpConfig),
  }),
  Rpc.make("mcp.credentials", {
    payload: Schema.Struct({}),
    success: Schema.Array(McpCredentialSnapshot),
  }),
  Rpc.make("mcp.status", {
    payload: Schema.Struct({}),
    success: Schema.Struct({ endpoint: Schema.String, state: ProviderMcpIngress.IngressSnapshot }),
  }),
  Rpc.make("mcp.route", {
    payload: Schema.Struct({ endpoint: Schema.String }),
    success: Schema.Void,
    error: ProviderMcpIngress.ProviderMcpIngressError,
  }),
  Rpc.make("mcp.pause", { payload: Schema.Struct({}), success: Schema.Void }),
  Rpc.make("mcp.drain", { payload: Schema.Struct({}), success: Schema.Void }),
  Rpc.make("session.open", {
    payload: Schema.Struct({
      instanceId: ProviderInstanceId,
      input: Schema.toCodecJson(OpenHostedSessionInput),
      mcp: Schema.optionalKey(mcpConfig),
    }),
    success: Schema.toCodecJson(ProviderSessionHost.HostedProviderSession),
    error,
  }),
  Rpc.make("session.list", {
    payload: Schema.Struct({}),
    success: Schema.Array(Schema.toCodecJson(ProviderSessionHost.HostedProviderSession)),
    error,
  }),
  Rpc.make("session.attach", {
    payload: Schema.Struct(ownedSession),
    success: Schema.toCodecJson(ProviderSessionHost.HostedProviderSession),
    error,
  }),
  Rpc.make("session.detach", { payload: Schema.Struct(ownedSession), success: Schema.Void, error }),
  Rpc.make("session.runConsumer", {
    payload: Schema.Struct({
      ...ownedSession,
      consumer: Adapter.ProviderAdapterV2RunConsumer,
      retained: Schema.Boolean,
    }),
    success: Schema.Void,
    error,
  }),
  Rpc.make("session.close", { payload: Schema.Struct(ownedSession), success: Schema.Void, error }),
  Rpc.make("session.acknowledge", {
    payload: Schema.Struct({ ...ownedSession, through: sequenceCursor }),
    success: Schema.Void,
    error,
  }),
  Rpc.make("session.awaitTurn", {
    payload: Schema.Struct({
      ...ownedSession,
      operation: ProviderSessionHost.HostedTurnOperationKey,
    }),
    success: Schema.Void,
    error,
  }),
  Rpc.make("session.events", {
    payload: Schema.Struct({ ...ownedSession, after: sequenceCursor }),
    success: Schema.toCodecJson(ProviderSessionEnvelope),
    error,
    stream: true,
  }),
  Rpc.make("session.invoke", {
    payload: Schema.Struct({
      ...ownedSession,
      method: Schema.Literals(methodNames),
      argument: Schema.Unknown,
      mcp: Schema.optionalKey(Schema.Array(mcpConfig)),
    }),
    success: Schema.Unknown,
    error,
  }),
).middleware(ProviderPrivateTransport.HostAuthorization);

export const layer = ProviderSessionRpc.toLayer(
  Effect.gen(function* () {
    const host = yield* ProviderSessionHost.ProviderSessionHost;
    const continuations = yield* ProviderContinuationHost.ProviderContinuationHost;
    const ingress = yield* ProviderMcpIngress.ProviderMcpIngress;
    const mcp = yield* McpProviderSessions.McpProviderSessions;
    let credentials: ReadonlyArray<McpCredentialSnapshot> = [];
    const configureMcp = (config: typeof mcpConfig.Type) => {
      const { capabilities, ...fields } = config;
      return mcp.set({
        ...fields,
        endpoint: ingress.endpoint,
        ...(capabilities === undefined ? {} : { capabilities: new Set(capabilities) }),
      });
    };
    return ProviderSessionRpc.of({
      "continuations.route": (config) => continuations.route(config),
      "continuations.pause": () => continuations.pause,
      "continuations.drain": () => continuations.awaitDrained,
      "mcp.checkpoint": (request) =>
        Effect.sync(() => {
          credentials = request.credentials;
        }),
      "mcp.credentials": () => Effect.sync(() => credentials),
      "mcp.configurations": () =>
        mcp.snapshot.pipe(
          Effect.map((configs) =>
            configs.map((config) => ({
              ...config,
              capabilities: [...(config.capabilities ?? [])],
            })),
          ),
        ),
      "mcp.status": () =>
        Effect.map(ingress.snapshot, (state) => ({ endpoint: ingress.endpoint, state })),
      "mcp.route": ({ endpoint }) => ingress.route(endpoint),
      "mcp.pause": () => ingress.pause,
      "mcp.drain": () => ingress.awaitDrained,
      // The RPC middleware owns the request span.
      "session.open": Effect.fnUntraced(function* (request) {
        if (request.mcp) yield* configureMcp(request.mcp);
        return yield* host.open(request.instanceId, request.input);
      }),
      "session.list": () => host.list,
      "session.attach": (request) => host.attach(request.sessionId, request.lease),
      "session.detach": (request) => host.detach(request.sessionId, request.lease),
      "session.runConsumer": (request) =>
        host.setRunConsumer(request.sessionId, request.lease, request.consumer, request.retained),
      "session.close": (request) => host.close(request.sessionId, request.lease),
      "session.acknowledge": (request) =>
        host.acknowledge(request.sessionId, request.lease, request.through),
      "session.awaitTurn": (request) =>
        host.awaitTurn(request.sessionId, request.lease, request.operation),
      "session.events": (request) => host.events(request.sessionId, request.lease, request.after),
      // The RPC middleware owns the request span.
      "session.invoke": Effect.fnUntraced(function* (request) {
        const invoke = Effect.fnUntraced(function* (
          runtime: Adapter.ProviderAdapterV2SessionRuntime,
        ) {
          for (const config of request.mcp ?? []) yield* configureMcp(config);
          return yield* sessionMethods[request.method].invoke(runtime, request.argument).pipe(
            Effect.mapError((cause) =>
              isAdapterError(cause)
                ? cause
                : new Adapter.ProviderAdapterProtocolError({
                    driver: runtime.driver,
                    detail: "Invalid hosted provider operation payload.",
                    cause,
                  }),
            ),
          );
        });
        if (request.method === "startTurn" || request.method === "compactThread") {
          const consumer = yield* decodeRunConsumer(request.argument).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionHost.ProviderSessionHostError({
                  operation: "turn-operation",
                  sessionId: request.sessionId,
                  cause,
                }),
            ),
          );
          yield* host.withTurn(
            request.sessionId,
            request.lease,
            {
              consumer,
              kind: request.method === "startTurn" ? "start" : "compact",
            },
            (runtime) => invoke(runtime).pipe(Effect.asVoid),
          );
          return null;
        }
        return yield* host.withRuntime(request.sessionId, request.lease, invoke);
      }),
    });
  }),
);
