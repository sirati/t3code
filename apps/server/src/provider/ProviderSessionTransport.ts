// @effect-diagnostics nodeBuiltinImport:off - Private process IPC authentication.
import * as NodeCrypto from "node:crypto";
import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as ProviderSessionRpc from "./ProviderSessionRpc.ts";

export class HostTransportConfig extends Context.Service<
  HostTransportConfig,
  {
    readonly endpoint: string;
    readonly token: string;
  }
>()("t3/provider/ProviderSessionTransport/HostTransportConfig") {}

const authorization = Layer.effect(
  ProviderSessionRpc.HostAuthorization,
  Effect.gen(function* () {
    const { token } = yield* HostTransportConfig;
    const expected = Buffer.from(token);
    return ProviderSessionRpc.HostAuthorization.of((effect, { headers }) => {
      const received = Buffer.from(headers["x-t3-host-token"] ?? "");
      return received.length === expected.length &&
        expected.length >= 32 &&
        NodeCrypto.timingSafeEqual(received, expected)
        ? effect
        : Effect.fail(new ProviderSessionRpc.HostAuthorizationError());
    });
  }),
);

export const layerServer = RpcServer.layer(ProviderSessionRpc.ProviderSessionRpc).pipe(
  Layer.provide(ProviderSessionRpc.layer),
  Layer.provide(authorization),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(
    Layer.unwrap(
      Effect.map(HostTransportConfig, ({ endpoint }) => NodeSocketServer.layer({ path: endpoint })),
    ),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
);

export class ProviderSessionClient extends Context.Service<
  ProviderSessionClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof ProviderSessionRpc.ProviderSessionRpc>, RpcClientError>
>()("t3/provider/ProviderSessionTransport/ProviderSessionClient") {}

const clientAuthorization = RpcMiddleware.layerClient(
  ProviderSessionRpc.HostAuthorization,
  Effect.gen(function* () {
    const { token } = yield* HostTransportConfig;
    return ({ request, next }) =>
      next({ ...request, headers: Headers.set(request.headers, "x-t3-host-token", token) });
  }),
);

export const layerClient = Layer.effect(
  ProviderSessionClient,
  RpcClient.make(ProviderSessionRpc.ProviderSessionRpc),
).pipe(
  Layer.provide(clientAuthorization),
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(
    Layer.unwrap(
      Effect.map(HostTransportConfig, ({ endpoint }) => NodeSocket.layerNet({ path: endpoint })),
    ),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
);
