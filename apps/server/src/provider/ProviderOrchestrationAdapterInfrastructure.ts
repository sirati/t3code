import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import * as SessionKeeper from "./SessionKeeper.ts";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | CursorKeychain.CursorKeychain
  | IdAllocator.IdAllocatorV2
  | SessionKeeper.SessionKeeper;

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(
  ClaudeAdapterV2.layerQueryRunner,
  CodexAdapterV2.layerAppServerClientFactory,
  CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  CursorKeychain.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
  // The Claude runner and Codex factory spawn through the keeper, so it sits underneath them.
).pipe(Layer.provideMerge(SessionKeeper.layer));
