// @effect-diagnostics nodeBuiltinImport:off - Keeper-backed providers are native children with piped stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";

import type { ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  type KeptSession,
  PendingRequests,
  type SessionActivity,
  type SessionKeeperShape,
} from "./SessionKeeper.ts";

export interface KeeperLaunch {
  readonly keeperPath: string;
  readonly socket: string;
  /** Set when the previous server kept this session; the keeper is reattached instead. */
  readonly reattach: KeptSession | undefined;
  /** Whether the command already ends in `serve`, as when an agent scope wraps the keeper. */
  readonly serveIncluded: boolean;
}

/** The keeper arguments that start `command`, or reattach the session a predecessor kept. */
const keeperArgs = (launch: KeeperLaunch, command: ReadonlyArray<string>): ReadonlyArray<string> =>
  launch.reattach !== undefined
    ? ["attach", launch.socket]
    : [
        "launch",
        launch.socket,
        "--",
        ...(launch.serveIncluded
          ? command
          : [launch.keeperPath, "serve", launch.socket, "--", ...command]),
      ];

export const spawnKeeperBackedProcess = (
  options: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string | undefined;
    readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    readonly signal?: AbortSignal | undefined;
  },
  launch: KeeperLaunch & {
    readonly stderr?: (chunk: string) => void;
    /** Set on reattach: output waits until the adapter attached the continuation turn. */
    readonly released?: Promise<void> | undefined;
  },
): NodeChildProcess.ChildProcess => {
  const child = NodeChildProcess.spawn(
    launch.keeperPath,
    [...keeperArgs(launch, [options.command, ...options.args])],
    {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env as NodeJS.ProcessEnv,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => launch.stderr?.(chunk));
  const source = child.stdout;
  if (launch.released === undefined || source === null) return child;
  // The adapter reads `stdout`; a reattached session's output waits behind this gate.
  Object.defineProperty(child, "stdout", {
    value: holdClaudeOutput(source, launch.released),
  });
  return child;
};

/**
 * Holds a reattached Claude CLI's output until its continuation turn is attached. Control
 * responses pass, so the SDK can finish opening the session.
 */
const holdClaudeOutput = (
  source: NodeStream.Readable,
  released: Promise<void>,
): NodeStream.Readable => {
  const gated = new NodeStream.PassThrough();
  const held: Array<string> = [];
  let open = false;
  let tail = "";
  source.on("data", (chunk: Buffer) => {
    const lines = (tail + chunk.toString()).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      if (open || line.includes('"type":"control_response"')) gated.write(`${line}\n`);
      else held.push(`${line}\n`);
    }
  });
  source.on("end", () => {
    if (tail.length > 0 && open) gated.write(tail);
    else if (tail.length > 0) held.push(tail);
    if (open) gated.end();
  });
  void released.then(() => {
    open = true;
    for (const line of held.splice(0)) gated.write(line);
    if (source.readableEnded) gated.end();
  });
  return gated;
};

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRpcResponse = (line: string) => {
  const message = Option.getOrUndefined(decodeLine(line));
  return (
    typeof message === "object" && message !== null && !("method" in message) && "id" in message
  );
};

const requestId = (line: string): string | undefined => {
  if (!line.includes('"method"')) return undefined;
  const message = Option.getOrUndefined(decodeLine(line));
  return typeof message === "object" && message !== null && "method" in message && "id" in message
    ? String(message.id)
    : undefined;
};

/**
 * Holds a reattached JSON-RPC provider's notifications and requests until its adapter registered
 * the turn they belong to, replayed requests first. Responses pass, so the adapter can start up.
 * Codex re-sends some open requests on `thread/resume`; one that was replayed already is dropped.
 */
export const holdUntilReleased = <E, R>(
  stdout: Stream.Stream<Uint8Array, E, R>,
  released: Effect.Effect<void>,
  replay: ReadonlyArray<string>,
): Stream.Stream<Uint8Array, E, R> =>
  Stream.suspend(() => {
    const held = [...replay];
    const replayed = new Set(replay.flatMap((line) => requestId(line) ?? []));
    let open = false;
    const lines = stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.map((line) => ({ line }) as const),
    );
    const release = Stream.fromEffect(released).pipe(
      Stream.map(() => ({ release: true }) as const),
    );
    return Stream.merge(lines, release).pipe(
      Stream.map((item): ReadonlyArray<string> => {
        if ("release" in item) {
          open = true;
          return held.splice(0);
        }
        const id = replayed.size === 0 ? undefined : requestId(item.line);
        if (id !== undefined && replayed.delete(id)) return [];
        if (open || isRpcResponse(item.line)) return [item.line];
        held.push(item.line);
        return [];
      }),
      Stream.flattenIterable,
      Stream.map((line) => `${line}\n`),
      Stream.encodeText,
    );
  });

/**
 * The platform handle of a keeper-backed JSON-RPC provider: it tracks unanswered requests,
 * registers the session for a restart, and on reattach replays and holds what the old server
 * left unanswered.
 */
export const keeperBackedHandle = Effect.fn("SessionKeeper.keeperBackedHandle")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  input: {
    readonly keeper: SessionKeeperShape;
    readonly providerSessionId: ProviderSessionId;
    readonly driver: ProviderDriverKind;
    readonly socket: string;
    readonly reattach: KeptSession | undefined;
    readonly activity: Effect.Effect<SessionActivity | undefined> | undefined;
  },
) {
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const replay = input.reattach?.pending ?? [];
  const pending = new PendingRequests();
  // Replayed requests stay open until answered, so another restart keeps them too.
  for (const line of replay) pending.output(`${line}\n`);
  const tracked = handle.stdout.pipe(
    Stream.tap((chunk) => Effect.sync(() => pending.output(Buffer.from(chunk)))),
  );
  // Registered now, so the adapter finds the kept turns before its continuation starts.
  const released =
    input.reattach === undefined
      ? undefined
      : input.keeper.holdReattached(input.providerSessionId, input.reattach.nativeTurnIds);
  const stdout =
    released === undefined
      ? tracked
      : holdUntilReleased(
          tracked,
          Effect.promise(() => released),
          replay,
        );
  const stdin = Sink.mapInput(handle.stdin, (chunk: Uint8Array) => {
    pending.input(Buffer.from(chunk));
    return chunk;
  });
  const activity = input.activity;
  const unregister = input.keeper.register({
    providerSessionId: input.providerSessionId,
    driver: input.driver,
    pid: Number(handle.pid),
    socket: input.socket,
    unit: undefined,
    pending,
    activity: () => (activity === undefined ? undefined : runSync(activity)),
    exited: runPromise(Effect.ignore(handle.exitCode)).then(() => unregister()),
  });
  return ChildProcessSpawner.makeHandle({
    ...handle,
    stdin,
    stdout,
    all: Stream.merge(stdout, handle.stderr),
  });
});
