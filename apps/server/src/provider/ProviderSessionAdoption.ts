import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";

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
  }
>()("t3/provider/ProviderSessionAdoption") {}

const make = Effect.gen(function* () {
  const client = yield* ProviderSessionTransport.ProviderSessionClient;
  const credentials = yield* McpSessionRegistry.McpSessionRegistry;
  const configurations = yield* McpProviderSessions.McpProviderSessions;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const turns = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* Scope.Scope;
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
      return {
        resumeReplay: Effect.gen(function* () {
          for (const runtime of runtimes) yield* runtime.eventDelivery!.resume;
          for (const runtime of runtimes)
            yield* runtime.eventDelivery!.awaitCaughtUp ?? Effect.void;
        }).pipe(Effect.mapError(failure)),
        awaitStartup: Effect.forEach(workers, (worker) => Fiber.join(worker), {
          discard: true,
        }).pipe(Effect.mapError(failure)),
      };
    }).pipe(Effect.mapError(failure)),
  );
  return ProviderSessionAdoption.of({ prepare });
});

export const layer = Layer.effect(ProviderSessionAdoption, make);
