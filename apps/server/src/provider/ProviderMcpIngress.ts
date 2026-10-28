// @effect-diagnostics nodeBuiltinImport:off - Stable loopback HTTP transport across replaceable server generations.
import * as NodeHttp from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export class ProviderMcpIngressError extends Schema.TaggedError<ProviderMcpIngressError>()(
  "ProviderMcpIngressError",
  {
    operation: Schema.Literals(["listen", "route"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Provider MCP ingress failed during ${this.operation}.`;
  }
}

export const IngressSnapshot = Schema.Struct({
  paused: Schema.Boolean,
  queued: Schema.Number,
  active: Schema.Number,
});

export class ProviderMcpIngress extends Context.Service<
  ProviderMcpIngress,
  {
    readonly endpoint: string;
    readonly route: (endpoint: string) => Effect.Effect<void, ProviderMcpIngressError>;
    readonly pause: Effect.Effect<void>;
    readonly awaitDrained: Effect.Effect<void>;
    readonly snapshot: Effect.Effect<typeof IngressSnapshot.Type>;
    readonly changes: Stream.Stream<typeof IngressSnapshot.Type>;
  }
>()("t3/provider/ProviderMcpIngress") {}

const MAX_REQUESTS = 64;
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
function forwardedHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.connection?.split(",").map((name) => name.trim().toLowerCase()) ?? []),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

const make = Effect.gen(function* () {
  let target: URL | undefined;
  let closing = false;
  const queued = new Map<NodeHttp.ServerResponse, NodeHttp.IncomingMessage>();
  const active = new Map<
    NodeHttp.ServerResponse,
    { request: NodeHttp.ClientRequest; method: string }
  >();
  const drained = new Set<() => void>();
  const observers = new Set<(state: typeof IngressSnapshot.Type) => void>();
  const snapshot = () => ({
    paused: target === undefined,
    queued: queued.size,
    active: active.size,
  });
  const changed = () => {
    const state = snapshot();
    for (const notify of observers) notify(state);
  };
  const notifyDrained = () => {
    if ([...active.values()].some((entry) => entry.method !== "GET")) return;
    for (const resume of drained) resume();
    drained.clear();
  };
  const finishUnavailable = (response: NodeHttp.ServerResponse) => {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(503);
      response.end();
    }
  };
  const forward = (
    incoming: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    upstream: URL,
  ) => {
    const destination = new URL(upstream);
    const queryStart = incoming.url?.indexOf("?") ?? -1;
    destination.search = queryStart < 0 ? "" : incoming.url!.slice(queryStart);
    const request = NodeHttp.request(destination, {
      method: incoming.method,
      headers: forwardedHeaders(incoming.headers),
    });
    active.set(response, { request, method: incoming.method ?? "POST" });
    const dispose = () => {
      active.delete(response);
      request.destroy();
      notifyDrained();
      changed();
    };
    response.once("close", dispose);
    incoming.once("error", () => request.destroy());
    request.once("error", () => finishUnavailable(response));
    request.once("response", (reply) => {
      if (response.destroyed || response.writableEnded) {
        reply.destroy();
        return;
      }
      response.writeHead(reply.statusCode ?? 502, forwardedHeaders(reply.headers));
      reply.once("error", () => response.destroy());
      reply.pipe(response);
    });
    incoming.pipe(request);
    changed();
  };
  const server = NodeHttp.createServer((incoming, response) => {
    response.on("error", () => {});
    if (
      incoming.url?.split("?")[0] !== "/mcp" ||
      !["POST", "GET", "DELETE"].includes(incoming.method ?? "")
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (closing || queued.size + active.size >= MAX_REQUESTS) {
      finishUnavailable(response);
      return;
    }
    if (target !== undefined) {
      forward(incoming, response, target);
      return;
    }
    queued.set(response, incoming);
    response.once("close", () => {
      queued.delete(response);
      changed();
    });
    changed();
  });
  server.requestTimeout = 0;
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          closing = true;
          for (const response of queued.keys()) finishUnavailable(response);
          queued.clear();
          for (const [response, entry] of active) {
            entry.request.destroy();
            response.destroy();
          }
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  yield* Effect.callback<void, ProviderMcpIngressError>((resume) => {
    const fail = (cause: Error) =>
      resume(Effect.fail(new ProviderMcpIngressError({ operation: "listen", cause })));
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
    return Effect.sync(() => server.off("error", fail));
  });
  server.on("error", () => {});
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* new ProviderMcpIngressError({ operation: "listen" });
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  return ProviderMcpIngress.of({
    endpoint,
    route: Effect.fn("ProviderMcpIngress.route")(function* (nextEndpoint: string) {
      const upstream = yield* Effect.try({
        try: () => new URL(nextEndpoint),
        catch: (cause) => new ProviderMcpIngressError({ operation: "route", cause }),
      });
      if (
        upstream.protocol !== "http:" ||
        upstream.hostname !== "127.0.0.1" ||
        upstream.pathname !== "/mcp" ||
        upstream.search ||
        upstream.hash ||
        upstream.username ||
        upstream.password ||
        upstream.href === endpoint ||
        closing
      )
        return yield* new ProviderMcpIngressError({ operation: "route" });
      target = upstream;
      for (const [response, incoming] of queued) {
        queued.delete(response);
        if (!response.destroyed) forward(incoming, response, upstream);
      }
      changed();
    }),
    pause: Effect.sync(() => {
      target = undefined;
      // GET event streams reconnect; POST tool calls finish before their server exits.
      for (const [response, entry] of active)
        if (entry.method === "GET") {
          entry.request.destroy();
          response.end();
        }
      changed();
    }),
    awaitDrained: Effect.callback<void>((resume) => {
      const complete = () => resume(Effect.void);
      drained.add(complete);
      notifyDrained();
      return Effect.sync(() => {
        drained.delete(complete);
      });
    }),
    snapshot: Effect.sync(snapshot),
    changes: Stream.callback<typeof IngressSnapshot.Type>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const notify = (state: typeof IngressSnapshot.Type) => {
              Queue.offerUnsafe(queue, state);
            };
            observers.add(notify);
            notify(snapshot());
            return notify;
          }),
          (notify) =>
            Effect.sync(() => {
              observers.delete(notify);
            }),
        ),
      { bufferSize: 1, strategy: "sliding" },
    ),
  });
});

export const layer = Layer.effect(ProviderMcpIngress, make);
