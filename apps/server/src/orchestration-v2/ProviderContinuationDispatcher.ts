import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { ThreadId, ProviderThreadId } from "@t3tools/contracts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

function delegatedCompletionText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}

export function currentDelegatedCompletionDelivery(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
) {
  const sourceRun = projection.runs.find((candidate) => candidate.id === completion.parentRunId);
  const delivery = sourceRun?.delegatedCompletion?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    sourceRun?.delegatedCompletion?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    (alreadyDispatched && !isUndeliveredMailboxSteer(projection, completion.messageId))
  ) {
    return undefined;
  }
  return delivery;
}

export class ProviderContinuationDispatchError extends Schema.TaggedError<ProviderContinuationDispatchError>()(
  "ProviderContinuationDispatchError",
  { threadId: ThreadId, providerThreadId: ProviderThreadId, cause: Schema.Defect() },
) {
  override get message() {
    return "Failed to dispatch a provider continuation.";
  }
}

export class ProviderContinuationDispatcher extends Context.Service<
  ProviderContinuationDispatcher,
  {
    readonly dispatch: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void, ProviderContinuationDispatchError>;
  }
>()("t3/orchestration-v2/ProviderContinuationDispatcher") {}

export const layer = Layer.effect(
  ProviderContinuationDispatcher,
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const dispatch = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequests.ProviderContinuationRequest) {
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
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          if (request.clearIfCurrent !== undefined) {
            yield* request.clearIfCurrent();
          } else if (request.dispatchIfCurrent !== undefined) {
            yield* request.dispatchIfCurrent(Effect.void);
          }
          return;
        }
        if (request.delegatedCompletion !== undefined) {
          const delivery = currentDelegatedCompletionDelivery(
            projection,
            request.delegatedCompletion,
          );
          if (delivery === undefined) {
            return;
          }
          const commandId = yield* ids.allocate.command({
            fixtureName: "delegated-completion",
            commandName: "dispatch",
          });
          yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId,
              threadId: request.threadId,
              messageId: delivery.messageId,
              text: delegatedCompletionText(delivery.taskIds),
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: {
                parentRunId: request.delegatedCompletion.parentRunId,
                generation: delivery.generation,
                taskIds: delivery.taskIds,
              },
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: (error) =>
                  Effect.logInfo(
                    "orchestration-v2.provider-continuation.delegated-completion-disabled",
                    {
                      threadId: request.threadId,
                      projectId: error.projectId,
                      instanceId: error.instanceId,
                    },
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        delivery.taskIds,
                        (taskId) =>
                          ids.allocate
                            .command({
                              fixtureName: "delegated-completion",
                              commandName: "acknowledge-disabled",
                            })
                            .pipe(
                              Effect.flatMap((ackCommandId) =>
                                threads.dispatch({
                                  type: "delegated_task.completion-delivery.acknowledge",
                                  commandId: ackCommandId,
                                  parentThreadId: request.threadId,
                                  taskId,
                                  observedByRunId: null,
                                }),
                              ),
                            ),
                        { discard: true },
                      ),
                    ),
                    Effect.andThen(
                      request.clearIfCurrent !== undefined
                        ? request.clearIfCurrent()
                        : request.dispatchIfCurrent !== undefined
                          ? request.dispatchIfCurrent(Effect.void)
                          : Effect.void,
                    ),
                  ),
              }),
            );
          return;
        }
        const messageId =
          request.messageId ??
          (yield* ids.allocate.message({
            threadId: request.threadId,
            ordinal: projection.messages.length + 1,
          }));
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: request.threadId,
          messageId,
          text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
          notification: request.notification ?? {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          // Only buffered wakes use creationSource "provider"; Claude would drain an empty buffer instead of prompting message_text.
          creationSource: request.delivery === "message_text" ? "server" : "provider",
        });
        // Catch after dispatchIfCurrent so adapters see raw failures first; clearIfCurrent is idempotent and covers others.
        const logInstanceDisabled = (
          error: ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
        ) =>
          Effect.logInfo("orchestration-v2.provider-continuation.instance-disabled", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            projectId: error.projectId,
            instanceId: error.instanceId,
          }).pipe(
            Effect.andThen(
              request.clearIfCurrent !== undefined ? request.clearIfCurrent() : Effect.void,
            ),
          );
        if (request.dispatchIfCurrent === undefined) {
          yield* dispatch.pipe(
            Effect.catchTags({
              ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
            }),
          );
          return;
        }
        yield* request.dispatchIfCurrent(dispatch).pipe(
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
          }),
        );
      },
      (effect, request) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderContinuationDispatchError({
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              }),
          ),
        ),
    );

    return ProviderContinuationDispatcher.of({ dispatch });
  }),
);
