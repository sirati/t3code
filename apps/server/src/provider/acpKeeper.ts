/**
 * An ACP agent under the session keeper. A reattached session repeats no handshake (the agent is
 * initialized and mid-prompt): it is answered from the agent's first answers, and the
 * continuation turn's `session/prompt` takes over the kept prompt, whose result answers it.
 */
import type { ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";
import type { AcpSessionActivity } from "@t3tools/provider-acp/server/adapter";
import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PendingRequests, type KeptSession, type SessionKeeperShape } from "./SessionKeeper.ts";

const SESSION_SETUP: ReadonlyArray<string> = ["session/new", "session/resume", "session/load"];
const HANDSHAKE_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "authenticate",
  ...SESSION_SETUP,
]);
// New request ids that would clash with one the agent still owes the previous server move here.
const REMAPPED_ID_START = 2 ** 31;

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const withId = (message: Readonly<Record<string, unknown>>, id: unknown) =>
  encodeJson({ ...message, id });

/**
 * Rewrites a reattached session's traffic: it answers the handshake, splices the continuation
 * prompt onto the kept one, and drops answers meant for the previous server. Plain state.
 */
export class AcpReattachment {
  private handshakeOpen = true;
  private readonly replies: ReadonlyMap<string, string>;
  private readonly stale: Set<string>;
  readonly keptPrompt: string | undefined;
  private spliced = false;
  private splicedId: unknown;
  private heldAnswer: Readonly<Record<string, unknown>> | undefined;
  private readonly remapped = new Map<string, unknown>();
  private nextId = REMAPPED_ID_START;

  constructor(record: Pick<KeptSession, "replies" | "clientRequests">) {
    this.replies = new Map(record.replies?.map(({ method, result }) => [method, result]));
    this.stale = new Set(record.clientRequests?.map(({ id }) => id));
    this.keptPrompt = record.clientRequests?.find(({ method }) => method === "session/prompt")?.id;
  }

  /**
   * A line the client wrote. `forward` goes to the agent; `answers` go to the client at once;
   * `promptAnswer`, the kept prompt's result, goes after the output held for the turn.
   */
  fromClient(line: string): {
    readonly forward: string | undefined;
    readonly answers: ReadonlyArray<string>;
    readonly promptAnswer?: string;
  } {
    const message = line.includes('"method"')
      ? Option.getOrUndefined(decodeMessage(line))
      : undefined;
    if (message === undefined || !("method" in message) || !("id" in message)) {
      return { forward: line, answers: [] };
    }
    const method = String(message.method);
    if (this.handshakeOpen && HANDSHAKE_METHODS.has(method)) {
      const result = this.replyFor(method);
      if (result !== undefined) {
        if (SESSION_SETUP.includes(method)) this.handshakeOpen = false;
        return {
          forward: undefined,
          answers: [`{"jsonrpc":"2.0","id":${encodeJson(message.id)},"result":${result}}`],
        };
      }
    }
    if (method === "session/prompt" && this.keptPrompt !== undefined && !this.spliced) {
      this.spliced = true;
      this.splicedId = message.id;
      const held = this.heldAnswer;
      this.heldAnswer = undefined;
      return held === undefined
        ? { forward: undefined, answers: [] }
        : { forward: undefined, answers: [], promptAnswer: withId(held, message.id) };
    }
    if (this.stale.has(String(message.id))) {
      const id = this.nextId++;
      this.remapped.set(String(id), message.id);
      return { forward: withId(message, id), answers: [] };
    }
    return { forward: line, answers: [] };
  }

  /** A line the agent wrote: what the client gets, if anything. */
  fromAgent(line: string): { readonly line: string | undefined; readonly promptAnswer?: true } {
    if (!line.includes('"id"')) return { line };
    const message = Option.getOrUndefined(decodeMessage(line));
    if (message === undefined || "method" in message || !("id" in message)) return { line };
    const id = String(message.id);
    if (id === this.keptPrompt && this.stale.delete(id)) {
      if (this.spliced) return { line: withId(message, this.splicedId), promptAnswer: true };
      this.heldAnswer = message;
      return { line: undefined };
    }
    const original = this.remapped.get(id);
    if (original !== undefined) {
      this.remapped.delete(id);
      return { line: withId(message, original) };
    }
    if (this.stale.delete(id)) return { line: undefined };
    return { line };
  }

  private replyFor(method: string): string | undefined {
    if (SESSION_SETUP.includes(method)) {
      return (
        this.replies.get(method) ??
        SESSION_SETUP.map((setup) => this.replies.get(setup)).find((reply) => reply !== undefined)
      );
    }
    // An agent that needed no authentication answers it with an empty result.
    return this.replies.get(method) ?? (method === "authenticate" ? "{}" : undefined);
  }
}

const isResponse = (line: string) => {
  if (!line.includes('"id"')) return false;
  const message = Option.getOrUndefined(decodeMessage(line));
  return message !== undefined && "id" in message && !("method" in message);
};
const requestId = (line: string) => {
  const message = Option.getOrUndefined(decodeMessage(line));
  return message !== undefined && "method" in message && "id" in message
    ? String(message.id)
    : undefined;
};

class LineSplitter {
  private tail = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): ReadonlyArray<string> {
    const lines = (this.tail + this.decoder.decode(chunk, { stream: true })).split("\n");
    this.tail = lines.pop() ?? "";
    return lines;
  }
}

type HeldEvent =
  | { readonly kind: "agent"; readonly line: string | undefined; readonly promptAnswer?: true }
  | { readonly kind: "answer"; readonly line: string; readonly afterHeld: boolean }
  | { readonly kind: "release" };

/**
 * A reattached session's output: handshake answers pass at once, the agent's notifications and
 * requests wait (replayed requests first) until the continuation turn is registered, and the kept
 * prompt's result comes after them. Responses to the new client's requests pass at once.
 */
export const reattachedStdout = <E, R>(
  stdout: Stream.Stream<Uint8Array, E, R>,
  input: {
    readonly rewrite: AcpReattachment;
    readonly answers: Queue.Dequeue<{ readonly line: string; readonly afterHeld: boolean }>;
    readonly released: Effect.Effect<void>;
    readonly replay: ReadonlyArray<string>;
  },
): Stream.Stream<Uint8Array, E, R> =>
  Stream.suspend(() => {
    const held = [...input.replay];
    const replayed = new Set(input.replay.flatMap((line) => requestId(line) ?? []));
    let open = false;
    const agent = stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.map((line): HeldEvent => ({ kind: "agent", ...input.rewrite.fromAgent(line) })),
    );
    const side = Stream.merge(
      Stream.fromQueue(input.answers).pipe(
        Stream.map((answer): HeldEvent => ({ kind: "answer", ...answer })),
      ),
      Stream.fromEffect(input.released).pipe(Stream.map((): HeldEvent => ({ kind: "release" }))),
    );
    // The agent's output decides when the stream ends; the queue never does.
    return Stream.merge(agent, side, { haltStrategy: "left" }).pipe(
      Stream.map((event): ReadonlyArray<string> => {
        if (event.kind === "release") {
          open = true;
          return held.splice(0);
        }
        if (event.line === undefined) return [];
        if (event.kind === "answer" && !event.afterHeld) return [event.line];
        if (event.kind === "agent" && event.promptAnswer !== true) {
          const id = replayed.size === 0 ? undefined : requestId(event.line);
          if (id !== undefined && replayed.delete(id)) return [];
          if (isResponse(event.line)) return [event.line];
        }
        if (open) return [event.line];
        held.push(event.line);
        return [];
      }),
      Stream.flattenIterable,
      Stream.map((line) => `${line}\n`),
      Stream.encodeText,
    );
  });

/**
 * The handle of an ACP agent under the keeper: it tracks open requests and the handshake for a
 * restart, registers the session, and on reattach rewrites its traffic (`AcpReattachment`) and
 * holds the agent's output until the continuation turn is registered.
 */
export const acpKeeperHandle = Effect.fn("SessionKeeper.acpKeeperHandle")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  input: {
    readonly keeper: SessionKeeperShape;
    readonly providerSessionId: ProviderSessionId;
    readonly driver: ProviderDriverKind;
    readonly socket: string;
    readonly reattach: KeptSession | undefined;
    readonly activity: Effect.Effect<AcpSessionActivity | undefined>;
  },
) {
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const { reattach } = input;
  const pending = new PendingRequests(HANDSHAKE_METHODS);
  // What the previous server left open stays open, so another restart keeps it too.
  if (reattach !== undefined) pending.restore(reattach);
  const replay = reattach?.pending ?? [];
  for (const line of replay) pending.output(`${line}\n`);
  const rewrite = reattach === undefined ? undefined : new AcpReattachment(reattach);
  const answers = yield* Queue.unbounded<{ readonly line: string; readonly afterHeld: boolean }>();
  const keptTurnIds = rewrite?.keptPrompt === undefined ? [] : [rewrite.keptPrompt];
  // Registered now, so the adapter finds the kept turn before its continuation starts.
  const released =
    reattach === undefined
      ? undefined
      : input.keeper.holdReattached(
          input.providerSessionId,
          keptTurnIds,
          reattach.continueRun
            ? [
                {
                  threadId: reattach.threadId,
                  providerThreadId: reattach.providerThreadId,
                  nativeTurnIds: keptTurnIds,
                },
              ]
            : [],
        );
  const encoder = new TextEncoder();
  const clientLines = new LineSplitter();
  const stdin = Sink.mapInput(handle.stdin, (chunk: Uint8Array) => {
    if (rewrite === undefined) {
      pending.input(Buffer.from(chunk));
      return chunk;
    }
    let forwarded = "";
    for (const line of clientLines.push(chunk)) {
      const { forward, answers: replies, promptAnswer } = rewrite.fromClient(line);
      if (forward !== undefined) forwarded += `${forward}\n`;
      for (const reply of replies) Queue.offerUnsafe(answers, { line: reply, afterHeld: false });
      if (promptAnswer !== undefined) {
        Queue.offerUnsafe(answers, { line: promptAnswer, afterHeld: true });
      }
    }
    pending.input(forwarded);
    return encoder.encode(forwarded);
  });
  const tracked = handle.stdout.pipe(
    Stream.tap((chunk) => Effect.sync(() => pending.output(Buffer.from(chunk)))),
  );
  const stdout =
    rewrite === undefined || released === undefined
      ? tracked
      : reattachedStdout(tracked, {
          rewrite,
          answers,
          released: Effect.promise(() => released),
          replay,
        });
  const unregister = input.keeper.register({
    providerSessionId: input.providerSessionId,
    driver: input.driver,
    pid: Number(handle.pid),
    socket: input.socket,
    unit: undefined,
    pending,
    activity: () => runSync(input.activity),
    exited: runPromise(Effect.ignore(handle.exitCode)).then(() => unregister()),
  });
  return ChildProcessSpawner.makeHandle({
    ...handle,
    stdin,
    stdout,
    all: Stream.merge(stdout, handle.stderr),
  });
});

const word = (value: ChildProcess.StandardCommand["args"][number]) =>
  typeof value === "string" ? value : Redacted.value(value);
const plainEnvironment = (
  env: ChildProcess.StandardCommand["options"]["env"],
): NodeJS.ProcessEnv | undefined =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([name, value]) => [
          name,
          value === undefined ? undefined : word(value),
        ]),
      );

/**
 * A spawner that runs the agent under the keeper in a scope that outlives the server, or
 * reattaches the session the previous server kept. The runtime must not wrap it in a scope of
 * its own: that scope would stop with the server.
 */
export const makeAcpKeeperSpawner = (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly keeper: SessionKeeperShape;
  readonly keeperPath: string;
  readonly agentScope: AgentScopeShape;
  readonly threadId: string | undefined;
  readonly providerSessionId: ProviderSessionId;
  readonly driver: ProviderDriverKind;
  readonly activity: Effect.Effect<AcpSessionActivity | undefined>;
}) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* input.spawner.spawn(command);
      const socket = input.keeper.socketFor(input.providerSessionId);
      const reattach = input.keeper.takeReattach(input.providerSessionId);
      const launch =
        reattach !== undefined
          ? ChildProcess.make(input.keeperPath, ["attach", socket], command.options)
          : yield* input.agentScope
              .wrap({
                command: input.keeperPath,
                args: ["serve", socket, "--", command.command, ...command.args.map(word)],
                name: "acp",
                threadId: input.threadId,
                env: plainEnvironment(command.options.env),
                survivesRestart: true,
              })
              .pipe(
                Effect.map((scoped) =>
                  ChildProcess.make(
                    input.keeperPath,
                    ["launch", socket, "--", scoped.command, ...scoped.args],
                    command.options,
                  ),
                ),
              );
      const handle = yield* input.spawner.spawn(launch);
      return yield* acpKeeperHandle(handle, {
        keeper: input.keeper,
        providerSessionId: input.providerSessionId,
        driver: input.driver,
        socket,
        reattach,
        activity: input.activity,
      });
    }),
  );

/** Leaves the command as it is, for a runtime whose spawner already scoped it. */
export const unscopedAgentScope = (agentScope: AgentScopeShape): AgentScopeShape => ({
  ...agentScope,
  wrap: ({ command, args }) => Effect.succeed({ command, args }),
});
