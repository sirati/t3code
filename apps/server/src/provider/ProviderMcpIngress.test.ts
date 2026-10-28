// @effect-diagnostics nodeBuiltinImport:off - Isolated loopback servers exercise actual streaming and disconnects.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ProviderMcpIngress from "./ProviderMcpIngress.ts";

const upstream = (handler: (body: string, response: NodeHttp.ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => handler(body, response));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      return { server, endpoint: `http://127.0.0.1:${address.port}/mcp` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

const request = (endpoint: string, body: string) =>
  Effect.callback<{ status: number; body: string }, Error>((resume) => {
    const outgoing = NodeHttp.request(endpoint, { method: "POST" }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.once("end", () =>
        resume(Effect.succeed({ status: response.statusCode ?? 0, body: text })),
      );
      response.once("error", (cause) => resume(Effect.fail(cause)));
    });
    outgoing.once("error", (cause) => resume(Effect.fail(cause)));
    outgoing.end(body);
    return Effect.sync(() => {
      outgoing.destroy();
    });
  });

it.live("drains an admitted tool call and sends queued calls only to the replacement server", () =>
  Effect.gen(function* () {
    const ingress = yield* ProviderMcpIngress.ProviderMcpIngress;
    const oldBodies: string[] = [];
    const newBodies: string[] = [];
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const old = yield* upstream((body, response) => {
      oldBodies.push(body);
      release = () => response.end(`old:${body}`);
      started!();
    });
    const replacement = yield* upstream((body, response) => {
      newBodies.push(body);
      response.end(`new:${body}`);
    });
    yield* ingress.route(old.endpoint);
    const first = yield* request(ingress.endpoint, "running").pipe(Effect.forkChild);
    yield* Effect.promise(() => firstStarted);
    yield* ingress.pause;
    const drained = yield* ingress.awaitDrained.pipe(Effect.forkChild);
    const second = yield* request(ingress.endpoint, "queued").pipe(Effect.forkChild);
    yield* ingress.changes.pipe(
      Stream.filter((state) => state.queued === 1),
      Stream.runHead,
    );
    assert.isUndefined(drained.pollUnsafe());
    assert.deepEqual(oldBodies, ["running"]);
    assert.deepEqual(newBodies, []);
    release!();
    assert.deepEqual(yield* Fiber.join(first), { status: 200, body: "old:running" });
    yield* Fiber.join(drained);
    yield* ingress.route(replacement.endpoint);
    assert.deepEqual(yield* Fiber.join(second), { status: 200, body: "new:queued" });
    assert.deepEqual(oldBodies, ["running"]);
    assert.deepEqual(newBodies, ["queued"]);
  }).pipe(Effect.provide(ProviderMcpIngress.layer)),
);

it.live("releases abandoned queued requests and refuses external or recursive routes", () =>
  Effect.gen(function* () {
    const ingress = yield* ProviderMcpIngress.ProviderMcpIngress;
    for (const endpoint of [
      ingress.endpoint,
      "https://127.0.0.1/mcp",
      "http://example.com/mcp",
      "http://127.0.0.1/wrong",
    ]) {
      assert.equal((yield* ingress.route(endpoint).pipe(Effect.result))._tag, "Failure");
    }
    const pending = yield* request(ingress.endpoint, "cancelled").pipe(
      Effect.exit,
      Effect.forkChild,
    );
    yield* ingress.changes.pipe(
      Stream.filter((state) => state.queued === 1),
      Stream.runHead,
    );
    yield* Fiber.interrupt(pending);
    yield* ingress.changes.pipe(
      Stream.filter((state) => state.queued === 0),
      Stream.runHead,
    );
  }).pipe(Effect.provide(ProviderMcpIngress.layer)),
);

it.live("ends GET event streams on pause so they reconnect to the replacement", () =>
  Effect.gen(function* () {
    const ingress = yield* ProviderMcpIngress.ProviderMcpIngress;
    const old = yield* upstream((_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: original\n\n");
    });
    yield* ingress.route(old.endpoint);
    const stream = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<{ request: NodeHttp.ClientRequest; ended: Promise<void> }>(
            (resolve, reject) => {
              const outgoing = NodeHttp.get(ingress.endpoint, (response) => {
                const ended = new Promise<void>((done, fail) => {
                  response.once("end", done);
                  response.once("error", fail);
                });
                response.once("data", () => resolve({ request: outgoing, ended }));
                response.resume();
              });
              outgoing.once("error", reject);
            },
          ),
      ),
      (stream) =>
        Effect.sync(() => {
          stream.request.destroy();
        }),
    );
    assert.equal((yield* ingress.snapshot).active, 1);
    yield* ingress.pause;
    yield* Effect.promise(() => stream.ended);
    yield* ingress.awaitDrained;
    yield* ingress.changes.pipe(
      Stream.filter((state) => state.active === 0),
      Stream.runHead,
    );
    const replacement = yield* upstream((body, response) => response.end(`replacement:${body}`));
    yield* ingress.route(replacement.endpoint);
    assert.deepEqual(yield* request(ingress.endpoint, "after-stream"), {
      status: 200,
      body: "replacement:after-stream",
    });
  }).pipe(Effect.provide(ProviderMcpIngress.layer)),
);
