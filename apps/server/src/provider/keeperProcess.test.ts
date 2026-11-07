import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { holdUntilReleased } from "./keeperProcess.ts";
import { PendingRequests } from "./SessionKeeper.ts";

const approval = '{"method":"item/commandExecution/requestApproval","id":7,"params":{}}';
const delta = '{"method":"item/agentMessage/delta","params":{"delta":"a"}}';
const done = '{"method":"turn/completed","params":{}}';
const resumed = '{"id":2,"result":{"thread":{}}}';

it("tracks requests until they are answered, and stops counting answers once frozen", () => {
  const pending = new PendingRequests();
  const [head, tail] = [approval.slice(0, 20), approval.slice(20)];
  pending.output(`${delta}\n${head}`);
  pending.output(`${tail}\n{"method":"tool/call","id":8,"params":{}}\n`);
  assert.deepEqual(pending.lines(), [approval, '{"method":"tool/call","id":8,"params":{}}']);

  pending.input('{"id":8,"result":{}}\n');
  assert.deepEqual(pending.lines(), [approval]);

  // An answer written after the detach request never reaches the provider.
  pending.freezeInput();
  pending.input('{"id":7,"result":{"decision":"accept"}}\n');
  assert.deepEqual(pending.lines(), [approval]);
});

it.effect(
  "holds a reattached session's output until release, replay first, and drops a re-sent request",
  () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const output = `${delta}\n${resumed}\n${approval}\n${done}\n`;
      const stdout = Stream.make(output.slice(0, 30), output.slice(30)).pipe(
        Stream.encodeText,
        // Release only after the provider's output was read, so the order below is fixed.
        Stream.concat(Stream.fromEffect(Deferred.succeed(released, undefined)).pipe(Stream.drain)),
      );
      const lines = yield* holdUntilReleased(stdout, Deferred.await(released), [approval]).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runCollect,
      );
      assert.deepEqual(lines, [resumed, approval, delta, done]);
    }),
);
