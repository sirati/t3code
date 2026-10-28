import {
  CheckpointId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderSession,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  ProviderUserInputAnswers,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OpenHostedSessionInput = Schema.Struct({
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  modelSelection: ModelSelection,
  runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
  resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
  initialNativeThreadId: Schema.optionalKey(Schema.String),
  initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
});

const ensureThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optionalKey(Schema.String),
  modelSelection: ModelSelection,
  runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
  providerSessionId: Schema.optionalKey(ProviderSessionId),
  existingProviderThread: Schema.optionalKey(OrchestrationV2ProviderThread),
  forceNewNativeThread: Schema.optionalKey(Schema.Boolean),
});
const turn = Schema.Struct({
  appThread: OrchestrationV2AppThread,
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(RunId),
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThread: OrchestrationV2ProviderThread,
  message: Adapter.ProviderAdapterV2TurnMessage,
  modelSelection: ModelSelection,
  runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});
const threadInput = Schema.Struct({ providerThread: OrchestrationV2ProviderThread });
const snapshot = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});

function method<I, A>(
  input: Schema.Codec<I, unknown>,
  output: Schema.Codec<A, unknown>,
  run: (
    runtime: Adapter.ProviderAdapterV2SessionRuntime,
    input: I,
  ) => Effect.Effect<A, Adapter.ProviderAdapterV2Error>,
) {
  const inputJson = Schema.toCodecJson(input);
  const outputJson = Schema.toCodecJson(output);
  return {
    input: inputJson,
    output: outputJson,
    invoke: (runtime: Adapter.ProviderAdapterV2SessionRuntime, argument: unknown) =>
      Schema.decodeUnknownEffect(inputJson)(argument).pipe(
        Effect.flatMap((input) => run(runtime, input)),
        Effect.flatMap(Schema.encodeEffect(outputJson)),
      ),
  };
}

function unsupported(runtime: Adapter.ProviderAdapterV2SessionRuntime) {
  return new Adapter.ProviderAdapterProtocolError({
    driver: runtime.driver,
    detail: "The hosted provider does not support this operation.",
  });
}

export const sessionMethods = {
  ensureThread: method(ensureThread, OrchestrationV2ProviderThread, (runtime, input) =>
    runtime.ensureThread(input),
  ),
  resumeThread: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      threadId: Schema.optionalKey(ThreadId),
      modelSelection: Schema.optionalKey(ModelSelection),
      runtimePolicy: Schema.optionalKey(Adapter.ProviderAdapterV2RuntimePolicy),
    }),
    OrchestrationV2ProviderThread,
    (runtime, input) => runtime.resumeThread(input),
  ),
  startTurn: method(turn, Schema.Void, (runtime, input) => runtime.startTurn(input)),
  compactThread: method(
    turn,
    Schema.Void,
    (runtime, input) => runtime.compactThread?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  steerTurn: method(
    Schema.Struct({
      threadId: ThreadId,
      runId: RunId,
      providerThread: OrchestrationV2ProviderThread,
      providerTurnId: ProviderTurnId,
      message: Adapter.ProviderAdapterV2TurnMessage,
    }),
    Schema.Void,
    (runtime, input) => runtime.steerTurn(input),
  ),
  interruptTurn: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      providerTurnId: ProviderTurnId,
      requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Void,
    (runtime, input) => runtime.interruptTurn(input),
  ),
  respondToRuntimeRequest: method(
    Schema.Struct({
      requestId: RuntimeRequestId,
      decision: Schema.optionalKey(ProviderApprovalDecision),
      feedback: Schema.optionalKey(Schema.String),
      answers: Schema.optionalKey(ProviderUserInputAnswers),
    }),
    Schema.Void,
    (runtime, input) => runtime.respondToRuntimeRequest(input),
  ),
  readThreadSnapshot: method(threadInput, snapshot, (runtime, input) =>
    runtime.readThreadSnapshot(input),
  ),
  unloadThread: method(
    threadInput,
    Schema.Void,
    (runtime, input) => runtime.unloadThread?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  uploadFeedback: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      reason: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({ feedbackId: Schema.String }),
    (runtime, input) => runtime.uploadFeedback?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  stopTask: method(
    Schema.Struct({ providerThread: OrchestrationV2ProviderThread, taskId: Schema.String }),
    Schema.Void,
    (runtime, input) => runtime.stopTask?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  awaitBackgroundTasks: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      taskIds: Schema.Array(Schema.String),
      awaited: Schema.Boolean,
    }),
    Schema.Struct({ matched: Schema.Array(Schema.String) }),
    (runtime, input) => runtime.awaitBackgroundTasks?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  hasPendingBackgroundWork: method(
    Schema.Struct({}),
    Schema.Boolean,
    (runtime) => runtime.hasPendingBackgroundWork ?? Effect.succeed(false),
  ),
  hasPendingBackgroundWorkForThread: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      includeSubagents: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Boolean,
    (runtime, input) =>
      runtime.hasPendingBackgroundWorkForThread?.(
        input.providerThread,
        input.includeSubagents === undefined ? {} : { includeSubagents: input.includeSubagents },
      ) ?? Effect.succeed(false),
  ),
  stopSubagent: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      nativeTaskId: Schema.String,
      requestedAt: Schema.optionalKey(Schema.DateTimeUtc),
    }),
    Schema.Union([
      Schema.Void,
      Schema.Struct({
        status: Schema.Literals(["completed", "failed", "cancelled"]),
        completedAt: Schema.DateTimeUtc,
        result: OrchestrationV2Subagent.fields.result,
      }),
    ]),
    (runtime, input) => runtime.stopSubagent?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  readContextPolicy: method(
    Schema.Struct({
      previous: Schema.NullOr(ModelSelection),
      next: ModelSelection,
      cwd: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ reusable: Schema.Boolean, modelWindow: Schema.NullOr(Schema.Number) }),
    (runtime, input) =>
      Effect.sync(() => ({
        reusable:
          input.previous !== null &&
          runtime.canReuseContextUsage?.(input.previous, input.next) === true,
        modelWindow: runtime.getModelContextWindow?.(input.next, input.cwd) ?? null,
      })),
  ),
  rollbackThread: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      target: Schema.Union([
        Schema.Struct({
          type: Schema.Literal("thread_start"),
          checkpointId: CheckpointId,
          appRunOrdinal: Schema.Literal(0),
        }),
        Schema.Struct({
          type: Schema.Literal("provider_turn"),
          checkpointId: CheckpointId,
          appRunOrdinal: Schema.Number,
          providerTurn: OrchestrationV2ProviderTurn,
        }),
      ]),
      providerThreadTurns: Schema.Array(OrchestrationV2ProviderTurn),
    }),
    snapshot,
    (runtime, input) => runtime.rollbackThread(input),
  ),
  forkThread: method(
    Schema.Struct({
      sourceProviderThread: OrchestrationV2ProviderThread,
      sourceProviderTurns: Schema.optionalKey(Schema.Array(OrchestrationV2ProviderTurn)),
      providerTurnId: Schema.optionalKey(ProviderTurnId),
      targetThreadId: ThreadId,
      ownerNodeId: Schema.optionalKey(NodeId),
      modelSelection: Schema.optionalKey(ModelSelection),
      runtimePolicy: Schema.optionalKey(Adapter.ProviderAdapterV2RuntimePolicy),
    }),
    OrchestrationV2ProviderThread,
    (runtime, input) => runtime.forkThread(input),
  ),
  injectHistory: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      messages: Schema.Array(OrchestrationV2HistoricalMessage),
      context: Schema.String,
    }),
    Schema.Boolean,
    (runtime, input) => runtime.injectHistory?.(input) ?? Effect.fail(unsupported(runtime)),
  ),
  listTools: method(
    Schema.Struct({ providerThread: OrchestrationV2ProviderThread, server: Schema.String }),
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        _meta: Schema.optionalKey(Schema.Unknown),
        annotations: Schema.optionalKey(Schema.Unknown),
      }),
    ),
    (runtime, input) => runtime.mcpApps?.listTools(input) ?? Effect.fail(unsupported(runtime)),
  ),
  callTool: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      server: Schema.String,
      tool: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.Unknown),
    }),
    Schema.Struct({
      content: Schema.Array(Schema.Unknown),
      structuredContent: Schema.optionalKey(Schema.Unknown),
      isError: Schema.optionalKey(Schema.Boolean),
      _meta: Schema.optionalKey(Schema.Unknown),
    }),
    (runtime, input) => runtime.mcpApps?.callTool(input) ?? Effect.fail(unsupported(runtime)),
  ),
  readResource: method(
    Schema.Struct({
      providerThread: OrchestrationV2ProviderThread,
      server: Schema.String,
      uri: Schema.String,
    }),
    Schema.Struct({ contents: Schema.Array(Schema.Unknown) }),
    (runtime, input) => runtime.mcpApps?.readResource(input) ?? Effect.fail(unsupported(runtime)),
  ),
} as const;
