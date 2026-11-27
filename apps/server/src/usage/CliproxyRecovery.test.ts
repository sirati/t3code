import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { make, RecoveryFetch, routeAvailableInAuthFiles } from "./CliproxyRecovery.ts";

const id = "K5wVx3M9Sq1zAx7B";
const config = {
  kind: "cliproxy",
  enabled: true,
  url: "https://hub.test/v0/management",
  managementKey: "test-key",
} as const;

it.effect(
  "uses v8 bearer authentication and parses fragmented SSE without a 15 second watch timeout",
  () =>
    Effect.gen(function* () {
      let connected!: () => void;
      const connection = new Promise<void>((resolve) => {
        connected = resolve;
      });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const service = yield* make.pipe(
        Effect.provideService(RecoveryFetch, async (input, init) => {
          assert.equal(
            String(input),
            `https://hub.test/v8/management/routing/recovery/${id}?watch=true`,
          );
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
          assert.equal(init?.redirect, "error");
          const body = new ReadableStream<Uint8Array>({
            start: (value) => {
              controller = value;
            },
          });
          connected();
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }),
      );
      const watcher = yield* service.watch(config, id).pipe(Effect.forkChild);
      yield* Effect.promise(() => connection);
      yield* Effect.sync(() => {
        controller.enqueue(
          encoder.encode(
            `: heartbeat\r\nevent: waiting\r\ndata: {"id":"${id}","state":"waiting"}\r\n\r\n`,
          ),
        );
      });
      yield* TestClock.adjust("30 seconds");
      yield* Effect.sync(() => {
        controller.enqueue(encoder.encode(`event: available\ndata: {"id":"${id}",`));
        controller.enqueue(encoder.encode('"state":"available"}\n\n'));
      });
      assert.equal(yield* Fiber.join(watcher), "available");
    }),
);

it.effect("treats missing tickets as timed fallback and rejects mismatched session events", () =>
  Effect.gen(function* () {
    const missing = yield* make.pipe(
      Effect.provideService(RecoveryFetch, async () => new Response(null, { status: 404 })),
    );
    assert.equal(yield* missing.lookup(config, id), "expired");
    assert.equal(yield* missing.watch(config, id), "expired");
    const wrong = yield* make.pipe(
      Effect.provideService(
        RecoveryFetch,
        async () =>
          new Response('event: available\ndata: {"id":"other","state":"available"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    assert.equal((yield* wrong.watch(config, id).pipe(Effect.result))._tag, "Failure");
  }),
);

it.effect("matches the issuing hub and reconnects notifications after transport failure", () =>
  Effect.gen(function* () {
    let disconnected!: () => void;
    const disconnection = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const requests: string[] = [];
    let subscriptions = 0;
    const service = yield* make.pipe(
      Effect.provideService(RecoveryFetch, async (input) => {
        const url = new URL(String(input));
        requests.push(url.host + url.search);
        if (url.host === "other.test") return new Response(null, { status: 404 });
        if (!url.search) return Response.json({ id, state: "waiting" });
        subscriptions += 1;
        if (subscriptions === 1) {
          disconnected();
          throw new Error("Connection reset");
        }
        return new Response(`event: available\ndata: {"id":"${id}","state":"available"}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const waiting = yield* service
      .wait([{ ...config, url: "https://other.test" }, config], id)
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => disconnection);
    yield* TestClock.adjust("5 seconds");
    assert.equal(yield* Fiber.join(waiting), "available");
    assert.equal(subscriptions, 2);
    assert.notInclude(requests, "other.test?watch=true");
  }),
);

it("finds a free route in the proxy's account cooldowns", () => {
  const now = Date.parse("2026-11-19T07:00:00Z");
  const route = { provider: "claude", model: "claude-opus-5-5" };
  const later = "2026-11-19T09:00:00Z";
  const earlier = "2026-11-19T06:00:00Z";
  const listing = (files: ReadonlyArray<unknown>) => ({ files });
  assert.isFalse(
    routeAvailableInAuthFiles(
      listing([{ provider: "claude", cooldowns: [{ scope: "credential", retry_at: later }] }]),
      route,
      now,
    ),
  );
  assert.isTrue(
    routeAvailableInAuthFiles(
      listing([{ provider: "claude", cooldowns: [{ scope: "credential", retry_at: earlier }] }]),
      route,
      now,
    ),
  );
  // A cooldown on another model leaves this one free; one on this model does not.
  const modelCooldown = (model: string) =>
    listing([
      { provider: "claude", cooldowns: [{ scope: "model", model_key: model, retry_at: later }] },
    ]);
  assert.isTrue(routeAvailableInAuthFiles(modelCooldown("claude-fable-5-2"), route, now));
  assert.isFalse(routeAvailableInAuthFiles(modelCooldown("claude-opus-5-5"), route, now));
  assert.isFalse(
    routeAvailableInAuthFiles(
      modelCooldown("claude-opus-5-5"),
      { ...route, model: "claude-opus-5-5[1m]" },
      now,
    ),
  );
  // Other providers, disabled and unavailable accounts never count.
  assert.isFalse(
    routeAvailableInAuthFiles(listing([{ provider: "codex", cooldowns: [] }]), route, now),
  );
  assert.isFalse(
    routeAvailableInAuthFiles(
      listing([{ provider: "claude", disabled: true, cooldowns: [] }]),
      route,
      now,
    ),
  );
  assert.isFalse(
    routeAvailableInAuthFiles(listing([{ provider: "claude", unavailable: true }]), route, now),
  );
  assert.isTrue(
    routeAvailableInAuthFiles(
      listing([
        { provider: "claude", cooldowns: [{ scope: "credential", retry_at: later }] },
        { provider: "claude", status: "active", cooldowns: [] },
      ]),
      route,
      now,
    ),
  );
  assert.throws(() => routeAvailableInAuthFiles({ error: "nope" }, route, now));
});

it.effect("waits on the account listing once the proxy has forgotten a ticket", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* make.pipe(
      Effect.provideService(RecoveryFetch, async (input, init) => {
        assert.equal(String(input), "https://hub.test/v0/management/auth-files");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
        reads++;
        const cooling = reads < 2;
        return Response.json({
          files: [
            {
              provider: "claude",
              cooldowns: cooling ? [{ scope: "credential", retry_at: "2999-01-01T00:00:00Z" }] : [],
            },
          ],
        });
      }),
    );
    const fiber = yield* service
      .waitForRoute([config], { provider: "claude", model: "claude-opus-5-5" })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("16 seconds");
    assert.equal(yield* Fiber.join(fiber), "available");
    assert.equal(reads, 2);
  }),
);
