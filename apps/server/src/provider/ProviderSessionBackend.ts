import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export class ProviderSessionBackend extends Context.Reference<{
  readonly open?: (request: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly input: Adapter.ProviderAdapterV2OpenSessionInput;
  }) => Effect.Effect<
    Adapter.ProviderAdapterV2SessionRuntime,
    Adapter.ProviderAdapterV2Error,
    Scope.Scope
  >;
  readonly retains: (runtime: Adapter.ProviderAdapterV2SessionRuntime) => boolean;
  readonly terminate: (
    runtime: Adapter.ProviderAdapterV2SessionRuntime,
  ) => Effect.Effect<void, Adapter.ProviderAdapterV2Error>;
}>("t3/provider/ProviderSessionBackend", {
  defaultValue: () => ({ retains: () => false, terminate: () => Effect.void }),
}) {}
