import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import * as ProviderSessionRpc from "./ProviderSessionRpc.ts";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";
export const layerServer = RpcServer.layer(ProviderSessionRpc.ProviderSessionRpc).pipe(
  Layer.provide(ProviderSessionRpc.layer),
  Layer.provide(ProviderPrivateTransport.layerAuthorization),
  Layer.provide(ProviderPrivateTransport.layerProtocolServer),
);
export class ProviderSessionClient extends Context.Service<
  ProviderSessionClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof ProviderSessionRpc.ProviderSessionRpc>, RpcClientError>
>()("t3/provider/ProviderSessionTransport/ProviderSessionClient") {}

export const layerClient = Layer.effect(
  ProviderSessionClient,
  RpcClient.make(ProviderSessionRpc.ProviderSessionRpc),
).pipe(
  Layer.provide(ProviderPrivateTransport.layerClientAuthorization),
  Layer.provide(ProviderPrivateTransport.layerProtocolClient),
);
