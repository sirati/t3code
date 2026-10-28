import { MessageId } from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ProviderContinuationRpc from "./ProviderContinuationRpc.ts";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";

export class ProviderContinuationHostError extends Schema.TaggedError<ProviderContinuationHostError>()(
  "ProviderContinuationHostError",
  {
    operation: Schema.Literals(["route", "busy", "dispatch"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Provider continuation host failed during ${this.operation}.`;
  }
}

export class ProviderContinuationHost extends Context.Service<
  ProviderContinuationHost,
  {
    readonly route: (
      config: ProviderPrivateTransport.HostTransportConfig["Service"],
    ) => Effect.Effect<void, ProviderContinuationHostError>;
    readonly pause: Effect.Effect<void>;
    readonly awaitDrained: Effect.Effect<void>;
    readonly dispatch: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void, ProviderContinuationHostError>;
  }
>()("t3/provider/ProviderContinuationHost") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const changed = yield* PubSub.unbounded<void>();
  const routeLock = yield* Semaphore.make(1);
  type Connection = {
    readonly scope: Scope.Closeable;
    readonly client: ProviderContinuationRpc.ProviderContinuationClient["Service"];
    active: number;
  };
  let connection: Connection | undefined;
  let paused = true;
  const drains = new Set<() => void>();
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => (connection ? Scope.close(connection.scope, Exit.void) : Effect.void)),
  );
  const signalDrained = () => {
    if (connection?.active) return;
    for (const notify of drains) notify();
    drains.clear();
  };
  const invokeOnce = Effect.fn("ProviderContinuationHost.invokeOnce")(function* (
    request: typeof ProviderContinuationRpc.ContinuationRequest.Type,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.subscribe(changed);
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (paused || connection === undefined) yield* restore(PubSub.take(changes));
            const current = connection;
            current.active++;
            const result = yield* restore(current.client["continuation.dispatch"](request)).pipe(
              Effect.result,
              Effect.ensuring(
                Effect.sync(() => {
                  current.active--;
                  signalDrained();
                }),
              ),
            );
            return { current, result };
          }),
        );
      }),
    );
  });
  const deliver = Effect.fn("ProviderContinuationHost.deliver")(function* (
    request: typeof ProviderContinuationRpc.ContinuationRequest.Type,
  ) {
    while (true) {
      const { current, result } = yield* invokeOnce(request);
      if (result._tag === "Success") return result.success;
      if (
        result.failure._tag !== "RpcClientError" ||
        result.failure.reason._tag === "RpcClientDefect"
      )
        return yield* new ProviderContinuationHostError({
          operation: "dispatch",
          cause: result.failure,
        });
      // Reconnect only after a replacement route. The same message id makes a lost reply safe.
      if (connection === current) paused = true;
      yield* Effect.logWarning("provider-host.continuation.transport-disconnected");
    }
  });
  return ProviderContinuationHost.of({
    route: Effect.fn("ProviderContinuationHost.route")(function* (config) {
      if (config.endpoint.length === 0 || config.token.length < 32)
        return yield* new ProviderContinuationHostError({ operation: "route" });
      if (connection && (!paused || connection.active > 0))
        return yield* new ProviderContinuationHostError({ operation: "busy" });
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const nextScope = yield* Scope.make();
          const built = yield* restore(
            Layer.buildWithScope(
              ProviderContinuationRpc.layerClient.pipe(
                Layer.provide(Layer.succeed(ProviderPrivateTransport.HostTransportConfig, config)),
              ),
              nextScope,
            ),
          ).pipe(
            Effect.mapError(
              (cause) => new ProviderContinuationHostError({ operation: "route", cause }),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(nextScope, exit) : Effect.void,
            ),
          );
          const previous = connection;
          connection = {
            scope: nextScope,
            client: Context.get(built, ProviderContinuationRpc.ProviderContinuationClient),
            active: 0,
          };
          paused = false;
          yield* PubSub.publish(changed, undefined);
          if (previous) yield* Scope.close(previous.scope, Exit.void);
        }),
      );
    }, routeLock.withPermits(1)),
    pause: Effect.sync(() => {
      paused = true;
    }),
    awaitDrained: Effect.callback<void>((resume) => {
      const notify = () => resume(Effect.void);
      drains.add(notify);
      signalDrained();
      return Effect.sync(() => {
        drains.delete(notify);
      });
    }),
    dispatch: Effect.fn("ProviderContinuationHost.dispatch")(function* (request) {
      const messageId =
        request.messageId ?? MessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const wire = {
        threadId: request.threadId,
        providerThreadId: request.providerThreadId,
        driver: request.driver,
        detail: request.detail,
        messageId,
        ...(request.notification === undefined ? {} : { notification: request.notification }),
        ...(request.delegatedCompletion === undefined
          ? {}
          : { delegatedCompletion: request.delegatedCompletion }),
        ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
      };
      const delivered =
        request.dispatchIfCurrent === undefined
          ? yield* deliver(wire).pipe(Effect.asSome)
          : yield* request.dispatchIfCurrent(deliver(wire));
      if (Option.isSome(delivered) && delivered.value.clear && request.clearIfCurrent)
        yield* request.clearIfCurrent();
    }),
  });
});

export const layer = Layer.effect(ProviderContinuationHost, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* ProviderContinuationHost;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        host
          .dispatch(request)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider-host.continuation.dispatch-failed", { cause }),
            ),
          ),
      ),
      Effect.forever,
      Effect.forkIn(yield* Scope.Scope),
    );
  }),
);
