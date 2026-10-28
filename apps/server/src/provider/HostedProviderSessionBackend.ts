import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderSessionBackend from "./ProviderSessionBackend.ts";
import * as ProviderSessionRemoteRuntime from "./ProviderSessionRemoteRuntime.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";

export const layer = Layer.effect(
  ProviderSessionBackend.ProviderSessionBackend,
  Effect.gen(function* () {
    const client = yield* ProviderSessionTransport.ProviderSessionClient;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const controls = new WeakMap<
      Adapter.ProviderAdapterV2SessionRuntime,
      {
        readonly close: Effect.Effect<void, Adapter.ProviderAdapterV2Error>;
        closed: boolean;
      }
    >();
    return {
      retains: (runtime: Adapter.ProviderAdapterV2SessionRuntime) => controls.has(runtime),
      terminate: Effect.fn("HostedProviderSessionBackend.terminate")(function* (
        runtime: Adapter.ProviderAdapterV2SessionRuntime,
      ) {
        const control = controls.get(runtime);
        if (control === undefined || control.closed) return;
        yield* control.close;
        control.closed = true;
      }),
      open: Effect.fn("HostedProviderSessionBackend.open")(function* (
        request: Parameters<
          NonNullable<
            Context.Service.Shape<typeof ProviderSessionBackend.ProviderSessionBackend>["open"]
          >
        >[0],
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const existing = yield* restore(client["session.list"]({}));
            const retained = existing.find(
              (entry) => entry.providerSession.id === request.input.providerSessionId,
            );
            const config = yield* mcpSessions.read(request.input.threadId);
            const opened =
              retained ??
              (yield* restore(
                client["session.open"]({
                  instanceId: request.instanceId,
                  input: request.input,
                  ...(config === undefined
                    ? {}
                    : {
                        mcp: {
                          ...config,
                          capabilities: [...(config.capabilities ?? [])],
                        },
                      }),
                }),
              ));
            const attached = yield* client["session.attach"]({
              sessionId: opened.providerSession.id,
              lease: opened.lease,
            });
            const remote = yield* ProviderSessionRemoteRuntime.connect(attached, {
              startPaused: retained !== undefined,
            }).pipe(
              Effect.provideService(ProviderSessionTransport.ProviderSessionClient, client),
              Effect.provideService(McpProviderSessions.McpProviderSessions, mcpSessions),
              Effect.onError(() =>
                client["session.detach"]({
                  sessionId: attached.providerSession.id,
                  lease: attached.lease,
                }).pipe(Effect.ignore),
              ),
            );
            const control = { close: remote.close, closed: false };
            controls.set(remote.runtime, control);
            yield* Effect.addFinalizer(() =>
              control.closed
                ? Effect.void
                : remote.detach.pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("provider-host.session-detach-failed", {
                        sessionId: opened.providerSession.id,
                        cause,
                      }),
                    ),
                  ),
            );
            return remote.runtime;
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new Adapter.ProviderAdapterProtocolError({
                driver: request.driver,
                detail: "Cannot attach the persistent provider session.",
                cause,
              }),
          ),
        );
      }),
    } satisfies Context.Service.Shape<typeof ProviderSessionBackend.ProviderSessionBackend>;
  }),
);
