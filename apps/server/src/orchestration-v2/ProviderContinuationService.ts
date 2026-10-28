import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderContinuationDispatcher from "./ProviderContinuationDispatcher.ts";
import { currentDelegatedCompletionDelivery } from "./ProviderContinuationDispatcher.ts";

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequests.ProviderContinuationRequest,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const dispatcher = yield* ProviderContinuationDispatcher.ProviderContinuationDispatcher;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const retryAttempts = yield* Ref.make(new Map<string, number>());

    const clearRetryAttempt = (key: string) =>
      Ref.update(retryAttempts, (current) => {
        if (!current.has(key)) return current;
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });

    const nextRetryDelay = (key: string) =>
      Ref.modify(retryAttempts, (current) => {
        const attempt = current.get(key) ?? 0;
        const updated = new Map(current);
        updated.set(key, attempt + 1);
        return [Math.min(100 * 2 ** Math.min(attempt, 6), 5_000), updated] as const;
      });

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatcher.dispatch(request).pipe(
          Effect.tap(() =>
            request.delegatedCompletion === undefined
              ? Effect.void
              : clearRetryAttempt(
                  delegatedCompletionRetryKey(request, request.delegatedCompletion),
                ),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              });
              if (request.delegatedCompletion !== undefined) {
                const completion = request.delegatedCompletion;
                const retryKey = delegatedCompletionRetryKey(request, completion);
                const retryDelay = yield* nextRetryDelay(retryKey);
                yield* Effect.gen(function* () {
                  yield* Effect.sleep(`${retryDelay} millis`);
                  const projection = yield* threads.getThreadRecords(
                    request.threadId,
                    ["messages", "runs", "providerTurns"],
                    {
                      messageIds:
                        request.delegatedCompletion === undefined
                          ? []
                          : [request.delegatedCompletion.messageId],
                    },
                  );
                  if (currentDelegatedCompletionDelivery(projection, completion) !== undefined) {
                    yield* requests.offer(request);
                  } else {
                    yield* clearRetryAttempt(retryKey);
                  }
                }).pipe(
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("orchestration-v2.provider-continuation.retry-check-failed", {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      cause: retryCause,
                    }).pipe(Effect.andThen(requests.offer(request))),
                  ),
                  Effect.forkScoped,
                );
              }
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(ProviderContinuationDispatcher.layer));
