import type { UsageLimitSourceConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

export class CliproxyRecoveryError extends Schema.TaggedError<CliproxyRecoveryError>()(
  "CliproxyRecoveryError",
  {
    operation: Schema.Literals(["lookup", "watch", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The proxy recovery notification connection failed.";
  }
}

export const RecoveryFetch = Context.Reference<typeof fetch>("t3/usage/RecoveryFetch", {
  defaultValue: () => globalThis.fetch,
});

export class CliproxyRecovery extends Context.Service<
  CliproxyRecovery,
  {
    readonly lookup: (
      config: UsageLimitSourceConfig,
      id: string,
    ) => Effect.Effect<"waiting" | "available" | "expired", CliproxyRecoveryError>;
    readonly watch: (
      config: UsageLimitSourceConfig,
      id: string,
    ) => Effect.Effect<"available" | "expired", CliproxyRecoveryError>;
    readonly wait: (
      sources: ReadonlyArray<UsageLimitSourceConfig>,
      id: string,
    ) => Effect.Effect<"available" | "expired", CliproxyRecoveryError>;
  }
>()("t3/usage/CliproxyRecovery") {}

function recoveryUrl(config: UsageLimitSourceConfig, id: string, watch = false) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) throw new Error("Invalid recovery identifier");
  const url = new URL(config.url);
  url.pathname = `${url.pathname.replace(/\/(?:v[08]\/management)?\/?$/, "")}/v8/management/routing/recovery/${id}`;
  url.search = watch ? "?watch=true" : "";
  url.hash = "";
  return url;
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function recoveryState(value: unknown, id: string) {
  if (typeof value !== "object" || value === null || !("id" in value) || value.id !== id)
    throw new Error("Invalid recovery response");
  if ("state" in value && (value.state === "waiting" || value.state === "available"))
    return value.state;
  throw new Error("Invalid recovery state");
}

export const make = Effect.gen(function* () {
  const fetchRecovery = yield* RecoveryFetch;
  const lookup = Effect.fn("CliproxyRecovery.lookup")(function (
    config: UsageLimitSourceConfig,
    id: string,
  ) {
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchRecovery(recoveryUrl(config, id), {
          headers: { Authorization: `Bearer ${config.managementKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          redirect: "error",
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return "expired" as const;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Recovery lookup rejected");
        }
        return recoveryState(await response.json(), id);
      },
      catch: (cause) => new CliproxyRecoveryError({ operation: "lookup", cause }),
    });
  });
  const watch = Effect.fn("CliproxyRecovery.watch")(function (
    config: UsageLimitSourceConfig,
    id: string,
  ) {
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchRecovery(recoveryUrl(config, id, true), {
          headers: { Authorization: `Bearer ${config.managementKey}`, Accept: "text/event-stream" },
          signal,
          redirect: "error",
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return "expired" as const;
        }
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        ) {
          await response.body?.cancel();
          throw new Error("Recovery subscription rejected");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let event = "";
        let data = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Recovery subscription ended before availability");
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length + data.length > 65_536) throw new Error("Recovery event too large");
            let end: number;
            while ((end = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, end).replace(/\r$/, "");
              buffer = buffer.slice(end + 1);
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += `${line.slice(5).trimStart()}\n`;
              else if (line === "") {
                if (data && (event === "available" || event === "waiting" || event === "expired")) {
                  const value: unknown = decodeJson(data);
                  if (event === "expired") {
                    if (
                      typeof value !== "object" ||
                      value === null ||
                      !("id" in value) ||
                      value.id !== id
                    )
                      throw new Error("Invalid expired recovery identifier");
                    return "expired" as const;
                  }
                  const state = recoveryState(value, id);
                  if (state !== event) throw new Error("Recovery event state mismatch");
                  if (state === "available") return state;
                }
                event = "";
                data = "";
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      catch: (cause) => new CliproxyRecoveryError({ operation: "watch", cause }),
    });
  });
  const wait = Effect.fn("CliproxyRecovery.wait")(
    function* (sources: ReadonlyArray<UsageLimitSourceConfig>, id: string) {
      const results = yield* Effect.forEach(
        sources.filter((source) => source.enabled && source.managementKey),
        (source) =>
          lookup(source, id).pipe(
            Effect.result,
            Effect.map((result) => ({ source, result })),
          ),
        { concurrency: 4 },
      );
      if (results.some(({ result }) => result._tag === "Success" && result.success === "available"))
        return "available" as const;
      const match = results.find(
        ({ result }) => result._tag === "Success" && result.success === "waiting",
      );
      if (match) return yield* watch(match.source, id);
      const error = results.find(({ result }) => result._tag === "Failure");
      if (error?.result._tag === "Failure") return yield* error.result.failure;
      return "expired" as const;
    },
    Effect.retry(Schedule.spaced("5 seconds")),
  );
  return CliproxyRecovery.of({ lookup, watch, wait });
});

export const layer = Layer.effect(CliproxyRecovery, make);
