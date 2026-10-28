import {
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionJournal from "./ProviderSessionJournal.ts";

export class ProviderSessionHostError extends Schema.TaggedError<ProviderSessionHostError>()(
  "ProviderSessionHostError",
  {
    operation: Schema.Literals([
      "open",
      "ownership",
      "events",
      "acknowledge",
      "close",
      "turn-operation",
    ]),
    sessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session host failed during ${this.operation}.`;
  }
}

export const HostedTurnOperationKey = Schema.Struct({
  consumer: ProviderAdapter.ProviderAdapterV2RunConsumer,
  kind: Schema.Literals(["start", "compact"]),
});
export type HostedTurnOperationKey = typeof HostedTurnOperationKey.Type;

export const HostedTurnOperation = Schema.Union([
  Schema.Struct({
    ...HostedTurnOperationKey.fields,
    state: Schema.Literals(["pending", "succeeded"]),
  }),
  Schema.Struct({
    ...HostedTurnOperationKey.fields,
    state: Schema.Literal("failed"),
    error: ProviderAdapter.ProviderAdapterV2Error,
  }),
]);
type HostedTurnOperation = typeof HostedTurnOperation.Type;

const isAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);
const operationKey = ({ consumer, kind }: HostedTurnOperationKey) =>
  `${kind}:${consumer.runId.length}:${consumer.runId}:${consumer.attemptId}`;

export const HostedProviderSession = Schema.Struct({
  providerSession: OrchestrationV2ProviderSession,
  incarnation: Schema.String,
  journalHead: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  acknowledgedThrough: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  lease: Schema.String,
  attached: Schema.Boolean,
  ended: Schema.Boolean,
  backgroundTasksEndWithProcess: Schema.Boolean,
  methods: Schema.Array(Schema.String),
  lastTerminals: Schema.Array(ProviderAdapter.ProviderAdapterV2TerminalEvent),
  runConsumers: Schema.Array(ProviderAdapter.ProviderAdapterV2RunConsumer),
  turnOperations: Schema.Array(HostedTurnOperation),
});
export type HostedProviderSession = typeof HostedProviderSession.Type;

export class ProviderSessionHost extends Context.Service<
  ProviderSessionHost,
  {
    readonly open: (
      instanceId: ProviderInstanceId,
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) => Effect.Effect<HostedProviderSession, ProviderSessionHostError>;
    readonly list: Effect.Effect<ReadonlyArray<HostedProviderSession>>;
    readonly attach: (
      sessionId: ProviderSessionId,
      expectedLease: string,
    ) => Effect.Effect<HostedProviderSession, ProviderSessionHostError>;
    readonly detach: (
      sessionId: ProviderSessionId,
      lease: string,
    ) => Effect.Effect<void, ProviderSessionHostError>;
    readonly withRuntime: <A, E>(
      sessionId: ProviderSessionId,
      lease: string,
      use: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ProviderSessionHostError>;
    readonly withTurn: (
      sessionId: ProviderSessionId,
      lease: string,
      operation: HostedTurnOperationKey,
      use: (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error | ProviderSessionHostError>;
    readonly awaitTurn: (
      sessionId: ProviderSessionId,
      lease: string,
      operation: HostedTurnOperationKey,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error | ProviderSessionHostError>;
    readonly events: (
      sessionId: ProviderSessionId,
      lease: string,
      after: number,
    ) => Stream.Stream<ProviderSessionJournal.ProviderSessionEnvelope, ProviderSessionHostError>;
    readonly acknowledge: (
      sessionId: ProviderSessionId,
      lease: string,
      through: number,
    ) => Effect.Effect<void, ProviderSessionHostError>;
    readonly setRunConsumer: (
      sessionId: ProviderSessionId,
      lease: string,
      consumer: ProviderAdapter.ProviderAdapterV2RunConsumer,
      retained: boolean,
    ) => Effect.Effect<void, ProviderSessionHostError>;
    readonly close: (
      sessionId: ProviderSessionId,
      lease: string,
    ) => Effect.Effect<void, ProviderSessionHostError>;
  }
>()("t3/provider/ProviderSessionHost") {}

interface HostedSession {
  incarnation: string;
  journalHead: number;
  acknowledgedThrough: number;
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  providerSession: OrchestrationV2ProviderSession;
  scope: Scope.Closeable;
  changed: PubSub.PubSub<void>;
  lease: string;
  attached: boolean;
  ended: boolean;
  failure: unknown;
  lastTerminals: Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TerminalEvent>;
  runConsumers: Map<string, ProviderAdapter.ProviderAdapterV2RunConsumer>;
  turnOperations: Map<
    string,
    {
      snapshot: HostedTurnOperation;
      completion: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterV2Error>;
      retired: boolean;
    }
  >;
}

function describe(entry: HostedSession): HostedProviderSession {
  return {
    providerSession: entry.providerSession,
    incarnation: entry.incarnation,
    journalHead: entry.journalHead,
    acknowledgedThrough: entry.acknowledgedThrough,
    lease: entry.lease,
    attached: entry.attached,
    ended: entry.ended,
    lastTerminals: [...entry.lastTerminals.values()],
    runConsumers: [...entry.runConsumers.values()],
    turnOperations: [...entry.turnOperations.values()].map((operation) => operation.snapshot),
    backgroundTasksEndWithProcess: entry.runtime.backgroundTasksEndWithProcess === true,
    methods: [
      ...Object.keys(entry.runtime).filter(
        (key) => typeof Reflect.get(entry.runtime, key) === "function",
      ),
      "readContextPolicy",
      ...(entry.runtime.hasPendingBackgroundWork ? ["hasPendingBackgroundWork"] : []),
      ...(entry.runtime.mcpApps ? ["listTools", "callTool", "readResource"] : []),
    ],
  };
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const crypto = yield* Crypto.Crypto;
  const journal = yield* ProviderSessionJournal.ProviderSessionJournal;
  const scope = yield* Scope.Scope;
  const sessions = new Map<ProviderSessionId, HostedSession>();
  const lock = yield* KeyedLock.make<ProviderSessionId>();
  const requireSession = Effect.fn("ProviderSessionHost.requireSession")(function* (
    sessionId: ProviderSessionId,
    lease: string,
  ) {
    const entry = sessions.get(sessionId);
    if (!entry || !entry.attached || entry.lease !== lease)
      return yield* new ProviderSessionHostError({ operation: "ownership", sessionId });
    return entry;
  });

  const open = Effect.fn("ProviderSessionHost.open")(
    function* (
      instanceId: ProviderInstanceId,
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const existing = sessions.get(input.providerSessionId);
      if (existing) {
        if (existing.runtime.instanceId !== instanceId)
          return yield* new ProviderSessionHostError({
            operation: "open",
            sessionId: input.providerSessionId,
          });
        return describe(existing);
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const incarnation = yield* crypto.randomUUIDv4().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionHostError({
                  operation: "open",
                  sessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          yield* journal.drop(input.providerSessionId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionHostError({
                  operation: "open",
                  sessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const childScope = yield* Scope.fork(scope);
          const runtime = yield* restore(
            registry.get(instanceId).pipe(
              Effect.flatMap((adapter) => adapter.openSession(input)),
              Effect.provideService(Scope.Scope, childScope),
            ),
          ).pipe(
            Effect.onError(() => Scope.close(childScope, Exit.void)),
            Effect.mapError(
              (cause) =>
                new ProviderSessionHostError({
                  operation: "open",
                  sessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const changed = yield* PubSub.sliding<void>(1).pipe(
            Effect.provideService(Scope.Scope, childScope),
          );
          yield* Scope.addFinalizer(childScope, PubSub.shutdown(changed));
          const entry: HostedSession = {
            incarnation,
            journalHead: 0,
            acknowledgedThrough: 0,
            runtime,
            providerSession: runtime.providerSession,
            scope: childScope,
            changed,
            lease: incarnation,
            attached: false,
            ended: false,
            failure: undefined,
            lastTerminals: new Map(),
            runConsumers: new Map(),
            turnOperations: new Map(),
          };
          sessions.set(input.providerSessionId, entry);
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              journal.append(input.providerSessionId, event).pipe(
                Effect.tap((envelope) =>
                  Effect.sync(() => {
                    entry.journalHead = envelope.sequence;
                    if (event.type === "turn.terminal")
                      entry.lastTerminals.set(event.providerTurnId, event);
                    if (event.type === "provider_session.updated")
                      entry.providerSession = event.providerSession;
                  }),
                ),
                Effect.andThen(PubSub.publish(changed, undefined)),
                (effect) => lock.withLock(input.providerSessionId, effect),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                entry.failure = cause;
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                entry.ended = true;
              }).pipe(Effect.andThen(PubSub.publish(changed, undefined))),
            ),
            Effect.forkIn(childScope),
          );
          return describe(entry);
        }),
      );
    },
    (effect, _instanceId, input) => lock.withLock(input.providerSessionId, effect),
  );

  const attach = Effect.fn("ProviderSessionHost.attach")(
    function* (sessionId: ProviderSessionId, expectedLease: string) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.lease !== expectedLease)
        return yield* new ProviderSessionHostError({ operation: "ownership", sessionId });
      entry.lease = yield* crypto
        .randomUUIDv4()
        .pipe(
          Effect.mapError(
            (cause) => new ProviderSessionHostError({ operation: "ownership", sessionId, cause }),
          ),
        );
      entry.attached = true;
      yield* PubSub.publish(entry.changed, undefined);
      return describe(entry);
    },
    Effect.uninterruptible,
    (effect, sessionId) => lock.withLock(sessionId, effect),
  );

  const detach = Effect.fn("ProviderSessionHost.detach")(
    function* (sessionId: ProviderSessionId, lease: string) {
      const entry = yield* requireSession(sessionId, lease);
      entry.lease = yield* crypto
        .randomUUIDv4()
        .pipe(
          Effect.mapError(
            (cause) => new ProviderSessionHostError({ operation: "ownership", sessionId, cause }),
          ),
        );
      entry.attached = false;
      yield* PubSub.publish(entry.changed, undefined);
    },
    Effect.uninterruptible,
    (effect, sessionId) => lock.withLock(sessionId, effect),
  );

  const withRuntime: ProviderSessionHost["Service"]["withRuntime"] = Effect.fn(
    "ProviderSessionHost.withRuntime",
  )(function* <A, E>(
    sessionId: ProviderSessionId,
    lease: string,
    use: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) => Effect.Effect<A, E>,
  ) {
    const admitted = yield* lock.withLock(
      sessionId,
      Effect.gen(function* () {
        const entry = yield* requireSession(sessionId, lease);
        return yield* use(entry.runtime).pipe(Effect.forkIn(entry.scope));
      }),
    );
    return yield* Fiber.join(admitted);
  });

  const withTurn: ProviderSessionHost["Service"]["withTurn"] = Effect.fn(
    "ProviderSessionHost.withTurn",
  )(function* (
    sessionId: ProviderSessionId,
    lease: string,
    operation: HostedTurnOperationKey,
    use: (
      runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
  ) {
    const completion = yield* lock.withLock(
      sessionId,
      Effect.gen(function* () {
        const entry = yield* requireSession(sessionId, lease);
        const key = operationKey(operation);
        const existing = entry.turnOperations.get(key);
        if (existing !== undefined) {
          if (existing.snapshot.consumer.threadId !== operation.consumer.threadId)
            return yield* new ProviderSessionHostError({ operation: "turn-operation", sessionId });
          return existing.completion;
        }
        const completion = yield* Deferred.make<void, ProviderAdapter.ProviderAdapterV2Error>();
        const record: {
          snapshot: HostedTurnOperation;
          completion: typeof completion;
          retired: boolean;
        } = {
          snapshot: { ...operation, state: "pending" },
          completion,
          retired: false,
        };
        entry.turnOperations.set(key, record);
        yield* use(entry.runtime).pipe(
          Effect.interruptible,
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause);
            return Effect.fail(
              Option.isSome(error) && isAdapterError(error.value)
                ? error.value
                : new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: entry.runtime.driver,
                    detail: "The admitted provider turn could not complete startup.",
                    cause,
                  }),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              record.snapshot = Exit.isSuccess(exit)
                ? { ...operation, state: "succeeded" }
                : {
                    ...operation,
                    state: "failed",
                    error: Option.getOrThrow(Cause.findErrorOption(exit.cause)),
                  };
              if (record.retired) entry.turnOperations.delete(key);
            }).pipe(Effect.andThen(Deferred.done(completion, exit))),
          ),
          Effect.forkIn(entry.scope),
        );
        return completion;
      }).pipe(Effect.uninterruptible),
    );
    yield* Deferred.await(completion);
  });

  const awaitTurn: ProviderSessionHost["Service"]["awaitTurn"] = Effect.fn(
    "ProviderSessionHost.awaitTurn",
  )(function* (sessionId: ProviderSessionId, lease: string, operation: HostedTurnOperationKey) {
    const entry = yield* requireSession(sessionId, lease);
    const pending = entry.turnOperations.get(operationKey(operation));
    if (pending === undefined || pending.snapshot.consumer.threadId !== operation.consumer.threadId)
      return yield* new ProviderSessionHostError({ operation: "turn-operation", sessionId });
    yield* Deferred.await(pending.completion);
  });

  const events = (sessionId: ProviderSessionId, lease: string, after: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entry = yield* requireSession(sessionId, lease);
        const changed = yield* PubSub.subscribe(entry.changed);
        let cursor = after;
        return Stream.fromEffectRepeat(
          Effect.gen(function* () {
            yield* requireSession(sessionId, lease);
            const batch = yield* journal
              .read(sessionId, cursor)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderSessionHostError({ operation: "events", sessionId, cause }),
                ),
              );
            if (batch.length) {
              cursor = batch.at(-1)!.sequence;
              return batch;
            }
            if (entry.ended) {
              if (entry.failure)
                return yield* new ProviderSessionHostError({
                  operation: "events",
                  sessionId,
                  cause: entry.failure,
                });
              return null;
            }
            yield* PubSub.take(changed);
            return [];
          }),
        ).pipe(
          Stream.takeUntil((batch) => batch === null),
          Stream.filter((batch) => batch !== null),
          Stream.flattenIterable,
        );
      }),
    );

  const acknowledge = Effect.fn("ProviderSessionHost.acknowledge")(
    function* (sessionId: ProviderSessionId, lease: string, through: number) {
      const entry = yield* requireSession(sessionId, lease);
      if (through > entry.journalHead)
        return yield* new ProviderSessionHostError({ operation: "acknowledge", sessionId });
      yield* journal
        .acknowledge(sessionId, through)
        .pipe(
          Effect.mapError(
            (cause) => new ProviderSessionHostError({ operation: "acknowledge", sessionId, cause }),
          ),
        );
      entry.acknowledgedThrough = Math.max(entry.acknowledgedThrough, through);
    },
    (effect, sessionId) => lock.withLock(sessionId, effect),
  );

  const setRunConsumer = Effect.fn("ProviderSessionHost.setRunConsumer")(
    function* (
      sessionId: ProviderSessionId,
      lease: string,
      consumer: ProviderAdapter.ProviderAdapterV2RunConsumer,
      retained: boolean,
    ) {
      const entry = yield* requireSession(sessionId, lease);
      const key = `${consumer.runId.length}:${consumer.runId}:${consumer.attemptId}`;
      if (retained) entry.runConsumers.set(key, consumer);
      else {
        entry.runConsumers.delete(key);
        if (consumer.providerTurnId !== undefined)
          entry.lastTerminals.delete(consumer.providerTurnId);
        if (entry.runConsumers.size === 0) entry.lastTerminals.clear();
        // Consumer release follows durable terminal ingestion, so this attempt cannot start again.
        for (const [id, operation] of entry.turnOperations) {
          if (
            operation.snapshot.consumer.runId !== consumer.runId ||
            operation.snapshot.consumer.attemptId !== consumer.attemptId
          )
            continue;
          operation.retired = true;
          if (operation.snapshot.state !== "pending") entry.turnOperations.delete(id);
        }
      }
    },
    (effect, sessionId) => lock.withLock(sessionId, effect),
  );

  const close = Effect.fn("ProviderSessionHost.close")(
    function* (sessionId: ProviderSessionId, lease: string) {
      const entry = yield* requireSession(sessionId, lease);
      sessions.delete(sessionId);
      yield* Scope.close(entry.scope, Exit.void);
      yield* journal
        .drop(sessionId)
        .pipe(
          Effect.mapError(
            (cause) => new ProviderSessionHostError({ operation: "close", sessionId, cause }),
          ),
        );
    },
    (effect, sessionId) => lock.withLock(sessionId, effect),
  );

  return ProviderSessionHost.of({
    withTurn,
    awaitTurn,
    setRunConsumer,
    open,
    list: Effect.sync(() => [...sessions.values()].map(describe)),
    attach,
    detach,
    withRuntime,
    events,
    acknowledge,
    close,
  });
});

export const layer = Layer.effect(ProviderSessionHost, make);
