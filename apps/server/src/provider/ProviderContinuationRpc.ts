import {
  MessageId,
  OrchestrationV2Notification,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import * as ProviderContinuationDispatcher from "../orchestration-v2/ProviderContinuationDispatcher.ts";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";

export const ContinuationRequest = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  driver: ProviderDriverKind,
  detail: Schema.NullOr(Schema.String),
  notification: Schema.optionalKey(OrchestrationV2Notification),
  delegatedCompletion: Schema.optionalKey(
    Schema.Struct({
      parentRunId: RunId,
      generation: Schema.Number,
      messageId: MessageId,
    }),
  ),
  delivery: Schema.optionalKey(Schema.Literals(["adapter_buffered", "message_text"])),
  messageId: MessageId,
});

const group = RpcGroup.make(
  Rpc.make("continuation.dispatch", {
    payload: Schema.toCodecJson(ContinuationRequest),
    success: Schema.Struct({ clear: Schema.Boolean }),
    error: ProviderContinuationDispatcher.ProviderContinuationDispatchError,
  }),
).middleware(ProviderPrivateTransport.HostAuthorization);

const handlers = group.toLayer(
  Effect.gen(function* () {
    const dispatcher = yield* ProviderContinuationDispatcher.ProviderContinuationDispatcher;
    return group.of({
      // The RPC middleware owns this operation's span; the provider host owns its guard.
      "continuation.dispatch": Effect.fnUntraced(function* (request) {
        let clear = false;
        yield* dispatcher.dispatch({
          ...request,
          clearIfCurrent: () =>
            Effect.sync(() => {
              clear = true;
            }),
        });
        return { clear };
      }),
    });
  }),
);

export const layerServer = RpcServer.layer(group).pipe(
  Layer.provide(handlers),
  Layer.provide(ProviderPrivateTransport.layerAuthorization),
  Layer.provide(ProviderPrivateTransport.layerProtocolServer),
);

export class ProviderContinuationClient extends Context.Service<
  ProviderContinuationClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof group>, RpcClientError>
>()("t3/provider/ProviderContinuationRpc/ProviderContinuationClient") {}

export const layerClient = Layer.effect(ProviderContinuationClient, RpcClient.make(group)).pipe(
  Layer.provide(ProviderPrivateTransport.layerClientAuthorization),
  Layer.provide(ProviderPrivateTransport.layerProtocolClient),
);
