import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { RpcServer } from "effect/rpc";

import * as ProxyLimitRecoveryWire from "./ProxyLimitRecoveryWire.ts";

const timed = { runId: "run:timed", resetAt: "2026-11-26T20:00:00.000Z", autoResume: false };
const waiting = {
  runId: "run:proxy",
  resetAt: null,
  proxyRecoveryId: "VPtGt5Jw_bjye8rJ",
  autoResume: true,
};
// Encoded wire data: a shell, a thread event with a recovery update, and a provider failure.
const wire = () => ({
  threads: [
    { id: "timed", limitRecovery: timed },
    { id: "waiting", limitRecovery: waiting, proxyRecoveryId: "VPtGt5Jw_bjye8rJ" },
  ],
  events: [{ type: "thread.updated", payload: { thread: { limitRecovery: { ...waiting } } } }],
  failure: { class: "usage_limit", resetAt: null },
});

it("replaces only recoveries that wait for a proxy and copies only the path to them", () => {
  const input = wire();
  const before = structuredClone(input);
  const output = ProxyLimitRecoveryWire.withoutProxyLimitRecoveries(input);

  expect(input).toEqual(before);
  expect(output.threads[0]).toBe(input.threads[0]);
  expect(output.threads[1]).toEqual({
    id: "waiting",
    limitRecovery: null,
    proxyRecoveryId: "VPtGt5Jw_bjye8rJ",
  });
  expect(output.events[0]?.payload.thread.limitRecovery).toBeNull();
  // A provider failure without a reset time is upstream's own shape.
  expect(output.failure).toBe(input.failure);

  const plain = { threads: [{ id: "timed", limitRecovery: timed }] };
  expect(ProxyLimitRecoveryWire.withoutProxyLimitRecoveries(plain)).toBe(plain);
});

it("rewrites JSON text only when it holds such a recovery", () => {
  const failureOnly = JSON.stringify({ failure: { resetAt: null } });
  expect(ProxyLimitRecoveryWire.withoutProxyLimitRecoveriesInJson(failureOnly)).toBe(failureOnly);
  expect(
    JSON.parse(ProxyLimitRecoveryWire.withoutProxyLimitRecoveriesInJson(JSON.stringify(wire()))),
  ).toEqual(ProxyLimitRecoveryWire.withoutProxyLimitRecoveries(wire()));
});

it("reads the capability from a socket URL or a request path", () => {
  expect(ProxyLimitRecoveryWire.declaresProxyLimitRecovery("/api/orchestration/shell")).toBe(false);
  expect(
    ProxyLimitRecoveryWire.declaresProxyLimitRecovery(
      "/api/orchestration/shell?omitIdleSubagents=1&clientCapabilities=proxyLimitRecovery",
    ),
  ).toBe(true);
  expect(
    ProxyLimitRecoveryWire.declaresProxyLimitRecovery(
      new URL(
        "ws://localhost/ws?orchestrationProtocol=2&clientCapabilities=settingsSecretReferences,proxyLimitRecovery",
      ),
    ),
  ).toBe(true);
  expect(
    ProxyLimitRecoveryWire.declaresProxyLimitRecovery(
      new URL(
        "ws://localhost/ws?clientCapabilities=settingsSecretReferences,httpUsageLimitSources",
      ),
    ),
  ).toBe(false);
});

it.effect("a socket strips its frames unless its URL declares the capability", () =>
  Effect.gen(function* () {
    const sent: Array<unknown> = [];
    const protocol = {
      send: (_clientId: number, response: unknown) => Effect.sync(() => void sent.push(response)),
    } as unknown as RpcServer.Protocol["Service"];
    const chunk = { _tag: "Chunk", requestId: "1", values: [wire()] } as const;
    const send = (url: string) =>
      ProxyLimitRecoveryWire.forClientUrl(new URL(url), protocol).send(
        0,
        chunk as unknown as Parameters<RpcServer.Protocol["Service"]["send"]>[1],
      );

    yield* send("ws://localhost/ws?orchestrationProtocol=2");
    yield* send("ws://localhost/ws?orchestrationProtocol=2&clientCapabilities=proxyLimitRecovery");
    expect(sent[0]).toEqual({
      ...chunk,
      values: [ProxyLimitRecoveryWire.withoutProxyLimitRecoveries(wire())],
    });
    expect(sent[1]).toBe(chunk);
  }),
);

it.effect("API answers lose such recoveries in whole and streamed JSON bodies only", () =>
  Effect.gen(function* () {
    const body = JSON.stringify(wire());
    const routes = Layer.mergeAll(
      HttpRouter.add("GET", "/whole", Effect.succeed(HttpServerResponse.jsonUnsafe(wire()))),
      HttpRouter.add(
        "GET",
        "/streamed",
        Effect.succeed(
          HttpServerResponse.stream(
            Stream.make(body.slice(0, 40), body.slice(40)).pipe(Stream.encodeText),
            {
              contentType: "application/json",
            },
          ),
        ),
      ),
      HttpRouter.add("GET", "/text", Effect.succeed(HttpServerResponse.text(body))),
    ).pipe(Layer.provide(ProxyLimitRecoveryWire.layerApiResponses));
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const read = (path: string) =>
      Effect.promise(async () => (await handler(new Request(`http://localhost${path}`))).text());
    const stripped = ProxyLimitRecoveryWire.withoutProxyLimitRecoveries(wire());

    for (const path of ["/whole", "/streamed"]) {
      expect(JSON.parse(yield* read(path))).toEqual(stripped);
      expect(JSON.parse(yield* read(`${path}?clientCapabilities=proxyLimitRecovery`))).toEqual(
        wire(),
      );
    }
    assert.strictEqual(yield* read("/text"), body);
  }).pipe(Effect.scoped),
);
