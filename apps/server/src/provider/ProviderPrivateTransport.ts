// @effect-diagnostics nodeBuiltinImport:off - Private local process IPC authentication.
import * as NodeCrypto from "node:crypto";
import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Headers from "effect/http/Headers";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
export class HostAuthorizationError extends Schema.TaggedError<HostAuthorizationError>()(
  "HostAuthorizationError",
  {},
) {}

export class HostAuthorization extends RpcMiddleware.Service<HostAuthorization>()(
  "t3/provider/HostAuthorization",
  { error: HostAuthorizationError },
) {}
export class HostTransportConfig extends Context.Service<
  HostTransportConfig,
  {
    readonly endpoint: string;
    readonly token: string;
  }
>()("t3/provider/ProviderPrivateTransport/HostTransportConfig") {}

export const layerAuthorization = Layer.effect(
  HostAuthorization,
  Effect.gen(function* () {
    const { token } = yield* HostTransportConfig;
    const expected = Buffer.from(token);
    return HostAuthorization.of((effect, { headers }) => {
      const received = Buffer.from(headers["x-t3-host-token"] ?? "");
      return received.length === expected.length &&
        expected.length >= 32 &&
        NodeCrypto.timingSafeEqual(received, expected)
        ? effect
        : Effect.fail(new HostAuthorizationError());
    });
  }),
);

export const layerClientAuthorization = RpcMiddleware.layerClient(
  HostAuthorization,
  Effect.gen(function* () {
    const { token } = yield* HostTransportConfig;
    return ({ request, next }) =>
      next({ ...request, headers: Headers.set(request.headers, "x-t3-host-token", token) });
  }),
);

export const layerProtocolServer = RpcServer.layerProtocolSocketServer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.map(HostTransportConfig, ({ endpoint }) => NodeSocketServer.layer({ path: endpoint })),
    ),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
);
export const layerProtocolClient = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.map(HostTransportConfig, ({ endpoint }) => NodeSocket.layerNet({ path: endpoint })),
    ),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
);
