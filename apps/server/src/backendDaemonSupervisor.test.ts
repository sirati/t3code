// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { BackendDaemonSupervisor, type DaemonCommand } from "./backendDaemonSupervisor.ts";
import { CONTROL_FILE, requestBackendDaemon } from "./backendDaemonControl.ts";

const fixture = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const role = process.argv[1];
const descriptor = process.argv[2];
const mode = process.argv[3];
if (role === 'worker') {
  const nonce = crypto.randomUUID();
  let steps = 0;
  const server = net.createServer(socket => {
    socket.once('data', () => socket.end(JSON.stringify({ nonce, starts: 1, steps: ++steps })));
  });
  server.listen(0, '127.0.0.1', () => process.send({ type: 'worker-ready', pid: process.pid, port: server.address().port }));
  const stop = () => server.close(() => process.exit(0));
  process.on('message', stop);
  process.on('disconnect', stop);
} else if (role === 'host') {
  const worker = cp.spawn(process.execPath, [...process.execArgv, 'worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  worker.once('message', async info => {
    fs.writeFileSync(descriptor + '.worker', JSON.stringify(info));
    process.send({ type: 't3-daemon-ready', role: 'host', protocol: 1 });
  });
  const stop = () => { worker.once('exit', () => process.exit(0)); worker.send({ type: 'stop' }); };
  process.on('message', stop);
  process.on('disconnect', stop);
} else {
  fs.appendFileSync(descriptor + '.generations', mode + '\n');
  if (mode === 'bad') process.exit(42);
  process.send({ type: 't3-daemon-ready', role: 'backend', protocol: 1 });
  process.on('message', () => process.exit(0));
  process.on('disconnect', () => process.exit(0));
}
`;

const command = (role: "host" | "backend", descriptor: string, mode = "good"): DaemonCommand => ({
  command: process.execPath,
  args: ["-e", fixture, role, descriptor, mode],
});

function advanceWorker(port: number): Promise<{ nonce: string; starts: number; steps: number }> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write("next"));
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

it.live.each(["replace", "rollback", "missing-target"] as const)(
  "keeps the native worker alive across backend replacement: %s",
  (scenario) =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(async () => {
        let descriptor = "";
        let mode = "good";
        const errors: Error[] = [];
        const supervisor = new BackendDaemonSupervisor({
          platform,
          hostCommand: async (file) => {
            descriptor = file;
            return command("host", file);
          },
          backendCommand: async (file) =>
            mode === "missing"
              ? { command: `${file}.missing`, args: [] }
              : command("backend", file, mode),
          onError: (error) => {
            errors.push(error);
          },
        });
        try {
          await supervisor.start();
          const original = supervisor.status;
          const worker = JSON.parse(await NodeFSP.readFile(`${descriptor}.worker`, "utf8")) as {
            pid: number;
            port: number;
          };
          const before = await advanceWorker(worker.port);
          mode =
            scenario === "rollback" ? "bad" : scenario === "missing-target" ? "missing" : "good";
          const first = supervisor.reload();
          assert.strictEqual(supervisor.reload(), first);
          if (scenario !== "replace") {
            await first.then(
              () => assert.fail("A failed replacement must report rollback."),
              (error: unknown) => {
                assert.instanceOf(error, Error);
                if (error instanceof Error)
                  assert.match(
                    error.message,
                    scenario === "rollback" ? /previous backend was restored/ : /ENOENT/,
                  );
              },
            );
          } else await first;
          const after = await advanceWorker(worker.port);
          assert.equal(supervisor.status.state, "running");
          assert.equal(supervisor.status.hostPid, original.hostPid);
          if (scenario === "missing-target")
            assert.equal(supervisor.status.backendPid, original.backendPid);
          else assert.notEqual(supervisor.status.backendPid, original.backendPid);
          assert.deepEqual(after, { nonce: before.nonce, starts: 1, steps: 2 });
          assert.deepEqual(
            (await NodeFSP.readFile(`${descriptor}.generations`, "utf8")).trim().split("\n"),
            scenario === "rollback"
              ? ["good", "bad", "good"]
              : scenario === "missing-target"
                ? ["good"]
                : ["good", "good"],
          );
          assert.deepEqual(errors, []);
        } finally {
          await supervisor.stop();
        }
        assert.equal(supervisor.status.state, "stopped");
        assert.isFalse(
          await NodeFSP.stat(NodePath.dirname(descriptor)).then(
            () => true,
            () => false,
          ),
        );
      }),
    ),
);

it.live("stops the host when shutdown overlaps backend resolution", () =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(async () => {
      const resolving = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<DaemonCommand>();
      const supervisor = new BackendDaemonSupervisor({
        platform,
        hostCommand: async (file) => command("host", file),
        backendCommand: async (file) => {
          resolving.resolve();
          await gate.promise;
          return command("backend", file);
        },
        onError: () => {},
      });
      const starting = supervisor.start();
      try {
        await resolving.promise;
        const stopping = supervisor.stop();
        gate.resolve(command("backend", "unused"));
        await starting.catch(() => undefined);
        await stopping;
        assert.equal(supervisor.status.state, "stopped");
      } finally {
        gate.resolve(command("backend", "unused"));
        await supervisor.stop();
      }
    }),
  ),
);

it.live("authenticates reloads and rejects a second supervisor for the same home", () =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-control-test-"));
      let descriptor = "";
      let duplicateStarted = false;
      const first = new BackendDaemonSupervisor({
        platform,
        stateDirectory: directory,
        hostCommand: async (file) => {
          descriptor = file;
          return command("host", file);
        },
        backendCommand: async (file) => command("backend", file),
        onError: () => {},
      });
      const duplicate = new BackendDaemonSupervisor({
        platform,
        stateDirectory: directory,
        hostCommand: async (file) => {
          duplicateStarted = true;
          return command("host", file);
        },
        backendCommand: async (file) => command("backend", file),
        onError: () => {},
      });
      try {
        await first.start();
        const filename = NodePath.join(directory, CONTROL_FILE);
        const transport = JSON.parse(await NodeFSP.readFile(filename, "utf8")) as {
          endpoint: string;
          token: string;
        };
        if (platform !== "win32") assert.equal((await NodeFSP.stat(filename)).mode & 0o777, 0o600);
        const original = await requestBackendDaemon(transport, "status");
        const worker = JSON.parse(await NodeFSP.readFile(`${descriptor}.worker`, "utf8")) as {
          port: number;
        };
        const before = await advanceWorker(worker.port);
        await requestBackendDaemon({ ...transport, token: "wrong" }, "reload").then(
          () => assert.fail("An unauthenticated reload must fail."),
          (cause: unknown) => {
            assert.instanceOf(cause, Error);
            if (cause instanceof Error) assert.equal(cause.message, "Unauthorized.");
          },
        );
        assert.deepEqual(await requestBackendDaemon(transport, "status"), original);
        const replaced = await requestBackendDaemon(transport, "reload");
        assert.equal(replaced.hostPid, original.hostPid);
        assert.notEqual(replaced.backendPid, original.backendPid);
        assert.deepEqual(await advanceWorker(worker.port), { ...before, steps: 2 });
        await duplicate.start().then(
          () => assert.fail("A second supervisor must not acquire the home."),
          (cause: unknown) => {
            assert.instanceOf(cause, Error);
            if (cause instanceof Error)
              assert.match(cause.message, /Another backend daemon supervisor owns/);
          },
        );
        assert.isFalse(duplicateStarted);
        assert.deepEqual(await requestBackendDaemon(transport, "status"), replaced);
      } finally {
        await duplicate.stop();
        await first.stop();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    }),
  ),
);
