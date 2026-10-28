import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class BackendDaemonReady extends Context.Reference<Effect.Effect<void>>(
  "t3/BackendDaemonReady",
  { defaultValue: () => Effect.void },
) {}
