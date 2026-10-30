// @effect-diagnostics nodeBuiltinImport:off - Kept sessions are native processes found through unix sockets and record files.
// @effect-diagnostics globalTimers:off -- A detach waits on a native child's exit and clears its deadline on every path.
/**
 * Opt-in: Claude and Codex run under `t3-session-keeper`, which owns the CLI and only copies its
 * stdio. At shutdown a busy session detaches instead of stopping; its keeper holds the output until
 * the next server reattaches it through a continuation run.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const KEEP_SESSIONS_ENV = "T3CODE_KEEP_SESSIONS";
const SESSION_KEEPER_PATH_ENV = "T3CODE_SESSION_KEEPER_PATH";
/** The keeper's exit code after letting go of a session that keeps running. */
const DETACHED_EXIT_CODE = 75;
const DETACH_DEADLINE_MS = 10_000;
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** Whether a launcher exit was a detach, after which its session lives on in the keeper. */
export const isDetachedExit = (code: number | null, signal: NodeJS.Signals | null) =>
  code === DETACHED_EXIT_CODE || signal === "SIGUSR1";

/**
 * Remembers JSON-RPC requests a provider still waits on, so a successor can show them again.
 * It only reads the stream. Claude needs none: its CLI re-sends open prompts on `initialize`.
 */
export class PendingRequests {
  private readonly open = new Map<string, string>();
  private outputTail = "";
  private inputTail = "";
  private inputFrozen = false;

  output(chunk: Buffer | string): void {
    this.outputTail = this.scan(this.outputTail + chunk.toString(), (line, message) => {
      if ("method" in message && "id" in message) this.open.set(String(message.id), line);
    });
  }

  /** Answers written after a detach request never reach the provider, so they no longer count. */
  freezeInput(): void {
    this.inputFrozen = true;
  }

  input(chunk: Buffer | string): void {
    if (this.inputFrozen) return;
    this.inputTail = this.scan(this.inputTail + chunk.toString(), (_line, message) => {
      if (!("method" in message) && "id" in message) this.open.delete(String(message.id));
    });
  }

  lines(): ReadonlyArray<string> {
    return [...this.open.values()];
  }

  private scan(text: string, visit: (line: string, message: Record<string, unknown>) => void) {
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      // Cheap filter before parsing: only requests and responses carry an id.
      if (!line.includes('"id"')) continue;
      const message = Option.getOrUndefined(decodeLine(line));
      if (typeof message === "object" && message !== null) {
        visit(line, message as Record<string, unknown>);
      }
    }
    return tail;
  }
}

/** What a busy session needs to continue on the next server. */
const KeptSession = Schema.Struct({
  providerSessionId: ProviderSessionId,
  driver: ProviderDriverKind,
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  socket: Schema.String,
  unit: Schema.NullOr(Schema.String),
  /** Provider requests that were waiting for an answer when the session detached. */
  pending: Schema.Array(Schema.String),
  /** Native turns in flight, for providers that must be told which turn they continue. */
  nativeTurnIds: Schema.Array(Schema.String),
  /** Whether a continuation run picks the session up, or its next turn reattaches it. */
  continueRun: Schema.Boolean,
});
export type KeptSession = typeof KeptSession.Type;
const decodeKeptSession = Schema.decodeUnknownOption(Schema.fromJsonString(KeptSession));
const encodeKeptSession = Schema.encodeSync(Schema.fromJsonString(KeptSession));
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface SessionActivity {
  readonly busy: boolean;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeTurnIds?: ReadonlyArray<string>;
  /** False when no turn could carry what the provider does next; its next turn reattaches. */
  readonly continueRun?: boolean;
}

/** A provider process running under a keeper on this server. */
export interface KeeperBackedSession {
  readonly providerSessionId: ProviderSessionId;
  readonly driver: ProviderDriverKind;
  readonly pid: number;
  readonly socket: string;
  readonly unit: string | undefined;
  /** Unanswered JSON-RPC requests, for providers that do not re-send them to a new client. */
  readonly pending: PendingRequests | undefined;
  /** Read synchronously, so a shutdown can decide before anything is interrupted. */
  readonly activity: () => SessionActivity | undefined;
  readonly exited: Promise<void>;
}

export interface SessionKeeperShape {
  /** The keeper binary, when this server keeps sessions across restarts. */
  readonly keeperPath: string | undefined;
  readonly socketFor: (providerSessionId: ProviderSessionId) => string;
  readonly register: (session: KeeperBackedSession) => () => void;
  /** The kept session the next spawn for this provider session reattaches, taken once. */
  readonly takeReattach: (providerSessionId: ProviderSessionId) => KeptSession | undefined;
  /** Detaches every busy session at shutdown and returns their threads. */
  readonly detachBusy: Effect.Effect<ReadonlySet<ThreadId>>;
  readonly keptThreadIds: () => ReadonlySet<ThreadId>;
  /** Starts a continuation run for each session kept by the previous server. */
  readonly resumeKept: Effect.Effect<void>;
  /** Holds a reattached session's provider output until its adapter registers the kept turns. */
  readonly holdReattached: (
    providerSessionId: ProviderSessionId,
    nativeTurnIds: ReadonlyArray<string>,
  ) => Promise<void>;
  /** Settles once a reattached session's continuation turn is attached; undefined otherwise. */
  readonly whenReattached: (providerSessionId: ProviderSessionId) => Promise<void> | undefined;
  /** The kept native turns a reattached session continues, taken once, and the release. */
  readonly reattachedTurns: (
    providerSessionId: ProviderSessionId,
  ) =>
    | { readonly nativeTurnIds: ReadonlyArray<string>; readonly release: Effect.Effect<void> }
    | undefined;
}

export class SessionKeeper extends Context.Service<SessionKeeper, SessionKeeperShape>()(
  "t3/provider/SessionKeeper",
) {}

const hash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

// A probe frame gets an answer without taking over the session or its held output.
const PROBE_FRAME = Buffer.from([8, 0, 0, 0, 0]);

const isAlive = (socket: string) =>
  new Promise<boolean>((resolve) => {
    const probe = NodeNet.connect(socket);
    probe.once("connect", () => probe.write(PROBE_FRAME));
    probe.once("data", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
    probe.once("close", () => resolve(false));
  });

const stopKeeper = (keeperPath: string, socket: string) =>
  new Promise<void>((resolve) => {
    NodeChildProcess.execFile(keeperPath, ["stop", socket], () => resolve());
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const continuations = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const keeperPath =
    process.env[KEEP_SESSIONS_ENV] === "1" ? process.env[SESSION_KEEPER_PATH_ENV] : undefined;
  const recordsDir = NodePath.join(config.stateDir, "kept-sessions");
  const socketDir = process.env.XDG_RUNTIME_DIR || recordsDir;
  const socketPrefix = `t3-keeper-${hash(config.stateDir)}-`;
  const socketFor = (providerSessionId: ProviderSessionId) =>
    NodePath.join(socketDir, `${socketPrefix}${hash(providerSessionId)}.sock`);
  const sessions = new Map<ProviderSessionId, KeeperBackedSession>();
  const reattached = new Map<
    ProviderSessionId,
    { readonly nativeTurnIds: ReadonlyArray<string>; readonly release: Effect.Effect<void> }
  >();
  const kept = new Map<ProviderSessionId, KeptSession>();
  const awaitingTurn = new Map<ProviderSessionId, Promise<void>>();
  const keptThreads = new Set<ThreadId>();

  // Sessions the previous server kept wait here; keepers nobody recorded end like on a restart.
  if (keeperPath !== undefined) {
    yield* Effect.promise(async () => {
      NodeFS.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
      const recorded = new Set<string>();
      for (const name of NodeFS.readdirSync(recordsDir)) {
        if (!name.endsWith(".json")) continue;
        const file = NodePath.join(recordsDir, name);
        const session = Option.getOrUndefined(decodeKeptSession(NodeFS.readFileSync(file, "utf8")));
        NodeFS.rmSync(file, { force: true });
        if (session !== undefined && (await isAlive(session.socket))) {
          kept.set(session.providerSessionId, session);
          recorded.add(session.socket);
        }
      }
      for (const name of NodeFS.existsSync(socketDir) ? NodeFS.readdirSync(socketDir) : []) {
        const socket = NodePath.join(socketDir, name);
        if (name.startsWith(socketPrefix) && !recorded.has(socket)) {
          await stopKeeper(keeperPath, socket);
        }
      }
    });
  }

  const detaching = new Map<
    ProviderSessionId,
    { session: KeeperBackedSession; activity: SessionActivity }
  >();
  // Runs before anything else in shutdown: a teardown must not answer or interrupt kept work.
  const detachBusyNow = () => {
    for (const session of sessions.values()) {
      if (detaching.has(session.providerSessionId)) continue;
      // Runs inside a signal listener, so one session failing must not stop the others or the exit.
      try {
        const activity = session.activity();
        if (activity === undefined || !activity.busy) continue;
        process.kill(session.pid, "SIGUSR1");
        session.pending?.freezeInput();
        detaching.set(session.providerSessionId, { session, activity });
      } catch {}
    }
  };
  if (keeperPath !== undefined) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const signal of SHUTDOWN_SIGNALS) process.prependListener(signal, detachBusyNow);
      }),
      () =>
        Effect.sync(() => {
          for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, detachBusyNow);
        }),
    );
  }

  const recordDetached = async ({
    session,
    activity,
  }: {
    readonly session: KeeperBackedSession;
    readonly activity: SessionActivity;
  }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detached = await Promise.race([
      session.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), DETACH_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    // A launcher that never let go ends with this server.
    if (!detached) return undefined;
    // Only now is the list final: requests the CLI sent until it let go still wait for an answer.
    const record: KeptSession = {
      providerSessionId: session.providerSessionId,
      driver: session.driver,
      threadId: activity.threadId,
      providerThreadId: activity.providerThreadId,
      socket: session.socket,
      unit: session.unit ?? null,
      pending: session.pending?.lines() ?? [],
      nativeTurnIds: activity.nativeTurnIds ?? [],
      continueRun: activity.continueRun ?? true,
    };
    const file = NodePath.join(recordsDir, `${hash(session.providerSessionId)}.json`);
    NodeFS.writeFileSync(file, encodeKeptSession(record), { mode: 0o600 });
    return activity.threadId;
  };

  return SessionKeeper.of({
    keeperPath,
    socketFor,
    register: (session) => {
      sessions.set(session.providerSessionId, session);
      return () => {
        if (sessions.get(session.providerSessionId) === session) {
          sessions.delete(session.providerSessionId);
        }
      };
    },
    takeReattach: (providerSessionId) => {
      const session = kept.get(providerSessionId);
      kept.delete(providerSessionId);
      return session;
    },
    detachBusy: Effect.promise(async () => {
      if (keeperPath === undefined) return keptThreads;
      detachBusyNow();
      const detached = await Promise.all([...detaching.values()].map(recordDetached));
      for (const threadId of detached) if (threadId !== undefined) keptThreads.add(threadId);
      return keptThreads;
    }).pipe(Effect.withSpan("SessionKeeper.detachBusy")),
    keptThreadIds: () => keptThreads,
    holdReattached: (providerSessionId, nativeTurnIds) => {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      awaitingTurn.set(providerSessionId, released);
      reattached.set(providerSessionId, {
        nativeTurnIds,
        release: Effect.sync(() => {
          awaitingTurn.delete(providerSessionId);
          release();
        }),
      });
      return released;
    },
    whenReattached: (providerSessionId) => awaitingTurn.get(providerSessionId),
    reattachedTurns: (providerSessionId) => {
      const turns = reattached.get(providerSessionId);
      reattached.delete(providerSessionId);
      return turns;
    },
    resumeKept: Effect.forEach(
      [...kept.values()].filter((session) => session.continueRun),
      (session) =>
        Effect.logInfo("Continuing a provider session kept across the restart", {
          threadId: session.threadId,
          providerSessionId: session.providerSessionId,
        }).pipe(
          Effect.andThen(
            continuations.offer({
              threadId: session.threadId,
              providerThreadId: session.providerThreadId,
              driver: session.driver,
              detail: null,
              delivery: "adapter_buffered",
              notification: {
                source: { kind: "background_task" },
                outcome: "updated",
                summary: "Continued after T3 Code restarted",
              },
            }),
          ),
        ),
      { discard: true },
    ),
  });
});

// Shares the continuation worker's request queue through the same layer reference.
export const layer = Layer.effect(SessionKeeper, make).pipe(
  Layer.provide(ProviderContinuationRequests.layer),
);
