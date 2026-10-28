import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const McpCredentialSnapshot = Schema.Struct({
  tokenHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  environmentId: EnvironmentId,
  requestNamespace: Schema.String,
  thread: Schema.Struct({
    threadId: ThreadId,
    providerSessionId: Schema.String,
    providerInstanceId: ProviderInstanceId,
    subagent: Schema.Boolean,
  }),
  capabilities: Schema.Array(
    Schema.Literals(["preview", "orchestration", "worktree", "device", "pull-requests"]),
  ),
  issuedAt: Schema.Number,
  lastAliveAt: Schema.Number,
});
export type McpCredentialSnapshot = typeof McpCredentialSnapshot.Type;
