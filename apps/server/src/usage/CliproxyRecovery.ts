import type { UsageLimitSourceConfig } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
    /** Settles once some account of the route's provider can serve its model again. */
    readonly waitForRoute: (
      sources: ReadonlyArray<UsageLimitSourceConfig>,
      route: RecoveryRoute,
    ) => Effect.Effect<"available">;
  }
>()("t3/usage/CliproxyRecovery") {}

/** The proxy provider and model a paused turn needs, for when its ticket is gone. */
export interface RecoveryRoute {
  readonly provider: string;
  readonly model: string | undefined;
}

// Several paused threads poll the same listing; one read serves them all for this long.
const AUTH_FILES_CACHE_MS = 10_000;
const ROUTE_POLL_INTERVAL = "15 seconds";

const canonicalModel = (model: string) =>
  model
    .replace(/\[[^\]]*\]$/, "")
    .trim()
    .toLowerCase();

/**
 * Whether the proxy's account listing has an account of the route's provider with no
 * active cooldown for the route's model. A cooldown without a readable end counts as active.
 */
export function routeAvailableInAuthFiles(value: unknown, route: RecoveryRoute, nowMs: number) {
  if (typeof value !== "object" || value === null || !("files" in value)) {
    throw new Error("Invalid auth files response");
  }
  const files: unknown = value.files;
  if (!Array.isArray(files)) throw new Error("Invalid auth files response");
  const model = route.model === undefined ? undefined : canonicalModel(route.model);
  const active = (cooldown: unknown) => {
    if (typeof cooldown !== "object" || cooldown === null) return false;
    const until =
      "retry_at" in cooldown && typeof cooldown.retry_at === "string"
        ? Date.parse(cooldown.retry_at)
        : Number.NaN;
    if (Number.isFinite(until) && until <= nowMs) return false;
    if (!("scope" in cooldown) || cooldown.scope === "credential") return true;
    return (
      cooldown.scope === "model" &&
      model !== undefined &&
      "model_key" in cooldown &&
      typeof cooldown.model_key === "string" &&
      canonicalModel(cooldown.model_key) === model
    );
  };
  return files.some((file: unknown) => {
    if (typeof file !== "object" || file === null) return false;
    const account = file as Record<string, unknown>;
    if (account.provider !== route.provider) return false;
    if (account.disabled === true || account.status === "disabled" || account.unavailable === true)
      return false;
    const cooldowns: unknown = account.cooldowns;
    return !Array.isArray(cooldowns) || !cooldowns.some(active);
  });
}

function authFilesUrl(config: UsageLimitSourceConfig) {
  const url = new URL(config.url);
  url.pathname = `${url.pathname.replace(/\/(?:v[08]\/management)?\/?$/, "")}/v0/management/auth-files`;
  url.search = "";
  url.hash = "";
  return url;
}

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
  const listings = new Map<string, { readonly at: number; readonly body: Promise<unknown> }>();
  const readAuthFiles = (config: UsageLimitSourceConfig, nowMs: number) =>
    Effect.tryPromise({
      try: (signal) => {
        const key = `${config.url}\u0000${config.managementKey}`;
        const cached = listings.get(key);
        if (cached !== undefined && nowMs - cached.at < AUTH_FILES_CACHE_MS) return cached.body;
        const body = fetchRecovery(authFilesUrl(config), {
          headers: { Authorization: `Bearer ${config.managementKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          redirect: "error",
        }).then(async (response) => {
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Account listing rejected");
          }
          return (await response.json()) as unknown;
        });
        listings.set(key, { at: nowMs, body });
        body.catch(() => listings.delete(key));
        return body;
      },
      catch: (cause) => new CliproxyRecoveryError({ operation: "lookup", cause }),
    });
  const routeAvailable = Effect.fn("CliproxyRecovery.routeAvailable")(function* (
    sources: ReadonlyArray<UsageLimitSourceConfig>,
    route: RecoveryRoute,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const source of sources) {
      if (!source.enabled || !source.managementKey) continue;
      const listing = yield* readAuthFiles(source, nowMs).pipe(Effect.option);
      if (listing._tag === "None") continue;
      const available = yield* Effect.try({
        try: () => routeAvailableInAuthFiles(listing.value, route, nowMs),
        catch: (cause) => new CliproxyRecoveryError({ operation: "decode", cause }),
      }).pipe(Effect.orElseSucceed(() => false));
      if (available) return true;
    }
    return false;
  });
  // A ticket lives in the proxy's memory, so a proxy restart or its 24-hour expiry loses it.
  // The proxy's own account cooldowns then tell when the route frees up.
  const waitForRoute = Effect.fn("CliproxyRecovery.waitForRoute")(function* (
    sources: ReadonlyArray<UsageLimitSourceConfig>,
    route: RecoveryRoute,
  ) {
    while (!(yield* routeAvailable(sources, route))) yield* Effect.sleep(ROUTE_POLL_INTERVAL);
    return "available" as const;
  });
  return CliproxyRecovery.of({ lookup, watch, wait, waitForRoute });
});

export const layer = Layer.effect(CliproxyRecovery, make);
