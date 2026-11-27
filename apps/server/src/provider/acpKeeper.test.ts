import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { AcpReattachment, reattachedStdout } from "./acpKeeper.ts";
import { PendingRequests } from "./SessionKeeper.ts";

const HANDSHAKE = new Set(["initialize", "authenticate", "session/new", "session/resume"]);
const initialize = '{"jsonrpc":"2.0","id":1073741824,"method":"initialize","params":{}}';
const newSession = '{"jsonrpc":"2.0","id":1073741826,"method":"session/new","params":{}}';
const prompt = '{"jsonrpc":"2.0","id":1073741827,"method":"session/prompt","params":{}}';
const update = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}';
const permission = '{"jsonrpc":"2.0","id":5,"method":"session/request_permission","params":{}}';
const promptDone = '{"jsonrpc":"2.0","id":1073741827,"result":{"stopReason":"end_turn"}}';
const record = {
  replies: [
    { method: "initialize", result: '{"protocolVersion":1}' },
    { method: "session/new", result: '{"sessionId":"s1"}' },
  ],
  clientRequests: [{ id: "1073741827", method: "session/prompt" }],
};

it("records the handshake and the client's open prompt for a restart", () => {
  const pending = new PendingRequests(HANDSHAKE);
  pending.input(`${initialize}\n${newSession}\n`);
  pending.output('{"jsonrpc":"2.0","id":1073741824,"result":{"protocolVersion":1}}\n');
  pending.output('{"jsonrpc":"2.0","id":1073741826,"result":{"sessionId":"s1"}}\n');
  pending.input(`${prompt}\n`);
  pending.output(`${update}\n${permission}\n`);
  assert.deepEqual(pending.replyResults(), record.replies);
  assert.deepEqual(pending.clientRequests(), record.clientRequests);
  assert.deepEqual(pending.lines(), [permission]);

  // A successor takes the record over, so a second restart still has it.
  const successor = new PendingRequests(HANDSHAKE);
  successor.restore(record);
  assert.deepEqual(successor.replyResults(), record.replies);
  successor.output(`${promptDone}\n`);
  assert.deepEqual(successor.clientRequests(), []);
});

it("answers a reattached handshake itself and splices the continuation prompt", () => {
  const rewrite = new AcpReattachment(record);
  // The agent is initialized and mid-prompt: neither the handshake nor the prompt reach it.
  const answered = rewrite.fromClient(
    '{"jsonrpc":"2.0","id":1073741824,"method":"initialize","params":{}}',
  );
  assert.isUndefined(answered.forward);
  assert.deepEqual(answered.answers, [
    '{"jsonrpc":"2.0","id":1073741824,"result":{"protocolVersion":1}}',
  ]);
  assert.deepEqual(
    rewrite.fromClient('{"jsonrpc":"2.0","id":1073741825,"method":"authenticate","params":{}}')
      .answers,
    ['{"jsonrpc":"2.0","id":1073741825,"result":{}}'],
  );
  // A resume gets the session the first server created.
  assert.deepEqual(
    rewrite.fromClient('{"jsonrpc":"2.0","id":1073741826,"method":"session/resume","params":{}}')
      .answers,
    ['{"jsonrpc":"2.0","id":1073741826,"result":{"sessionId":"s1"}}'],
  );
  // Answered before the continuation prompt: held, then given to it.
  assert.deepEqual(rewrite.fromAgent(promptDone), { line: undefined });
  const spliced = rewrite.fromClient(
    '{"jsonrpc":"2.0","id":1073741830,"method":"session/prompt","params":{}}',
  );
  assert.isUndefined(spliced.forward);
  assert.strictEqual(
    spliced.promptAnswer,
    '{"jsonrpc":"2.0","id":1073741830,"result":{"stopReason":"end_turn"}}',
  );
  // Later traffic passes unchanged.
  assert.strictEqual(rewrite.fromClient(prompt).forward, prompt);
  assert.deepEqual(rewrite.fromAgent(update), { line: update });
});

it("moves a new request off an id the agent still owes the previous server", () => {
  const rewrite = new AcpReattachment({
    clientRequests: [
      { id: "1073741827", method: "session/prompt" },
      { id: "1073741828", method: "session/set_mode" },
    ],
  });
  const moved = rewrite.fromClient(
    '{"jsonrpc":"2.0","id":1073741828,"method":"session/set_model","params":{}}',
  );
  assert.strictEqual(
    moved.forward,
    '{"jsonrpc":"2.0","id":2147483648,"method":"session/set_model","params":{}}',
  );
  // The old server's answer is dropped; the moved request's answer gets its id back.
  assert.deepEqual(rewrite.fromAgent('{"jsonrpc":"2.0","id":1073741828,"result":{}}'), {
    line: undefined,
  });
  assert.deepEqual(rewrite.fromAgent('{"jsonrpc":"2.0","id":2147483648,"result":{}}'), {
    line: '{"jsonrpc":"2.0","id":1073741828,"result":{}}',
  });
});

it.effect(
  "holds a reattached session's output for the turn and ends it with the kept prompt's result",
  () =>
    Effect.gen(function* () {
      const rewrite = new AcpReattachment(record);
      const answers = yield* Queue.unbounded<{
        readonly line: string;
        readonly afterHeld: boolean;
      }>();
      const released = yield* Deferred.make<void>();
      const offer = (result: ReturnType<AcpReattachment["fromClient"]>) => {
        for (const line of result.answers) Queue.offerUnsafe(answers, { line, afterHeld: false });
        if (result.promptAnswer !== undefined) {
          Queue.offerUnsafe(answers, { line: result.promptAnswer, afterHeld: true });
        }
      };
      offer(rewrite.fromClient(initialize));
      const output = `${update}\n${promptDone}\n`;
      const stdout = Stream.make(output).pipe(
        Stream.encodeText,
        // The turn registers once the output was read, then sends its prompt. The agent keeps
        // running, so the stream stays open: four lines end the test.
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(released, undefined).pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.andThen(
                Effect.sync(() =>
                  offer(
                    rewrite.fromClient(
                      '{"jsonrpc":"2.0","id":1073741830,"method":"session/prompt","params":{}}',
                    ),
                  ),
                ),
              ),
            ),
          ).pipe(Stream.drain),
        ),
        Stream.concat(Stream.never),
      );
      const lines = yield* reattachedStdout(stdout, {
        rewrite,
        answers,
        released: Deferred.await(released),
        replay: [permission],
      }).pipe(Stream.decodeText, Stream.splitLines, Stream.take(4), Stream.runCollect);
      assert.deepEqual(lines, [
        '{"jsonrpc":"2.0","id":1073741824,"result":{"protocolVersion":1}}',
        permission,
        update,
        '{"jsonrpc":"2.0","id":1073741830,"result":{"stopReason":"end_turn"}}',
      ]);
    }),
);
