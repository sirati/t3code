// @effect-diagnostics nodeBuiltinImport:off - The test drives real bash, git and a fake nix.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  DEV_SHELL_DISABLE_ENV,
  DevShellEnvironment,
  devShellScript,
  dispatcherScript,
  layer,
} from "./DevShellEnvironment.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-shell-"));

// Resolved once, so the scripts can run with a PATH that has no bash on it.
const BASH = NodeChildProcess.execFileSync("bash", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();
// With a socket on stdin, NixOS's bash treats `bash -c` as a remote shell and runs the system
// bashrc, which replaces PATH; agent shells source the dev shell after that, so tests skip it.
const bash = (script: string, env: NodeJS.ProcessEnv, cwd?: string) =>
  NodeChildProcess.execFileSync(BASH, ["-c", script], {
    env,
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
// For a shell that waits on the server, which needs the event loop meanwhile.
const bashAsync = (script: string, env: NodeJS.ProcessEnv, cwd: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        const child = NodeChildProcess.spawn(BASH, ["-c", script], {
          env,
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 30_000,
        });
        let output = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
        child.on("close", () => resolve(output));
      }),
  );

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("dev shell scripts", () => {
  it("applies a captured dev shell repeatably and replaces an older one", () => {
    const dir = tempDir();
    try {
      const first = NodePath.join(dir, "first.sh");
      const second = NodePath.join(dir, "second.sh");
      NodeFS.writeFileSync(
        first,
        devShellScript({
          flake: "/flake",
          cwd: "/work",
          base: { PATH: "/usr/bin:/bin", SAME: "kept" },
          shell: new Map([
            ["PATH", "/nix/one/bin:/usr/bin:/bin"],
            ["QUOTED", "it's here"],
            ["SAME", "kept"],
            ["PWD", "/elsewhere"],
            ["BASH_FUNC_f%%", "() { :; }"],
          ]),
        }),
      );
      NodeFS.writeFileSync(
        second,
        devShellScript({
          flake: "/flake",
          cwd: "/work",
          base: { PATH: "/usr/bin:/bin" },
          shell: new Map([
            ["PATH", "/nix/two/bin:/usr/bin:/bin"],
            ["ADDED", "yes"],
          ]),
        }),
      );
      const env = { PATH: "/usr/bin:/bin", SAME: "kept" };
      // Sourced before every command, so twice must change nothing.
      assert.equal(
        bash(`. ${first}; . ${first}; printf '%s|%s|%s' "$QUOTED" "$PATH" "$PWD"`, env, dir),
        `it's here|/nix/one/bin:/usr/bin:/bin|${dir}`,
      );
      // A changed flake replaces the earlier variables and PATH entries.
      assert.equal(
        bash(`. ${first}; . ${second}; printf '%s|%s|%s' "\${QUOTED-unset}" "$ADDED" "$PATH"`, env),
        "unset|yes|/nix/two/bin:/usr/bin:/bin",
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks the dev shell of the most specific directory", () => {
    const dir = tempDir();
    try {
      const file = (name: string) => {
        const path = NodePath.join(dir, `${name}.sh`);
        NodeFS.writeFileSync(path, `export PICKED=${name}\n`);
        return path;
      };
      const project = NodePath.join(dir, "project");
      const nested = NodePath.join(project, "nested");
      NodeFS.mkdirSync(nested, { recursive: true });
      const dispatcher = NodePath.join(dir, "dispatcher.sh");
      const loading = NodePath.join(dir, "nothing.loading");
      NodeFS.writeFileSync(
        dispatcher,
        dispatcherScript([
          { cwd: project, file: file("project"), loading },
          { cwd: nested, file: file("nested"), loading },
          {
            cwd: NodePath.join(dir, "missing"),
            file: NodePath.join(dir, "missing.sh"),
            loading,
          },
        ]),
      );
      const picked = (cwd: string) =>
        bash(`. ${dispatcher}; printf '%s' "\${PICKED-none}"`, { PATH: "/usr/bin:/bin" }, cwd);
      assert.equal(picked(project), "project");
      assert.equal(picked(nested), "nested");
      assert.equal(picked(dir), "none");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for a first capture that is still running", () => {
    const dir = tempDir();
    try {
      const file = NodePath.join(dir, "late.sh");
      const loading = NodePath.join(dir, "late.loading");
      const dispatcher = NodePath.join(dir, "dispatcher.sh");
      NodeFS.writeFileSync(dispatcher, dispatcherScript([{ cwd: dir, file, loading }]));
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      const run = (capture: string) => {
        NodeFS.writeFileSync(loading, "");
        return bash(
          `(sleep 1; ${capture} rm '${loading}') & . ${dispatcher}; printf '%s' "\${PICKED-none}"`,
          env,
          dir,
        );
      };
      // A failed capture ends the wait without a dev shell.
      assert.equal(run(""), "none");
      assert.equal(run(`printf 'export PICKED=late\\n' > '${file}';`), "late");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("DevShellEnvironment", () => {
  // A stand-in nix whose dev shell exports what the flake directory's `value` file says and where
  // it ran. It holds a capture back while the flake directory has a `hold` file.
  const fakeNix = (dir: string) => {
    const bin = NodePath.join(dir, "fake-bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "nix"),
      [
        "#!/bin/sh",
        'if [ "$1" = --version ]; then echo "nix (fake) 2.0"; exit 0; fi',
        "flake=$2; shift 3",
        'while [ -e "$flake/hold" ]; do sleep 0.1; done',
        'FROM_FLAKE=$(cat "$flake/value"); CAPTURED_IN=$(pwd); export FROM_FLAKE CAPTURED_IN',
        'PATH="$flake/tools:$PATH"; export PATH',
        'exec "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return bin;
  };

  it.effect("gives worktrees their main checkout's dev shell and follows flake changes", () => {
    const dir = tempDir();
    const project = NodePath.join(dir, "project");
    const worktree = NodePath.join(dir, "worktrees", "feature");
    const other = NodePath.join(dir, "worktrees", "other");
    NodeFS.mkdirSync(project);
    const git = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
    NodeFS.writeFileSync(NodePath.join(project, "flake.nix"), "{ outputs = _: { }; }\n");
    NodeFS.writeFileSync(NodePath.join(project, "value"), "one");
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    git("worktree", "add", "-q", worktree);
    const path = `${fakeNix(dir)}:${process.env.PATH ?? ""}`;
    const environment = { PATH: path, HOME: dir };
    return Effect.gen(function* () {
      const devShells = yield* DevShellEnvironment;
      const claudeEnvFile = devShells.claudeEnvironment.CLAUDE_ENV_FILE;
      assert.isString(claudeEnvFile);
      assert.match(devShells.environment.PROMPT_COMMAND ?? "", /^\. '/);
      const shellIn = (cwd: string, script: string) =>
        bashAsync(`. '${claudeEnvFile}'; ${script}`, environment, cwd);
      // Repeats a command, sourcing the dev shell each time, until it prints `expected`.
      const shellUntil = (cwd: string, script: string, expected: string) =>
        shellIn(
          cwd,
          `for _ in $(seq 100); do out=$(${script}); [ "$out" = '${expected}' ] && break; sleep 0.1; . '${claudeEnvFile}'; done; printf '%s' "$out"`,
        );

      // The first command waits for the first capture rather than running without it.
      yield* devShells.prepare(worktree);
      assert.equal(
        yield* shellIn(worktree, `printf '%s|%s' "$FROM_FLAKE" "$PATH"`),
        `one|${NodePath.join(project, "tools")}:${path}`,
      );

      // An edited flake is captured again on the next check; running shells see it next command.
      NodeFS.writeFileSync(NodePath.join(project, "value"), "two");
      NodeFS.writeFileSync(NodePath.join(project, "flake.nix"), "{ outputs = _: { x = 1; }; }\n");
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* shellUntil(worktree, `printf '%s' "$FROM_FLAKE"`, "two"), "two");

      // Another worktree starts with that dev shell at once, then gets its own.
      git("worktree", "add", "-q", other);
      NodeFS.writeFileSync(NodePath.join(project, "hold"), "");
      yield* devShells.prepare(other);
      assert.equal(
        yield* shellIn(other, `printf '%s|%s' "$FROM_FLAKE" "$CAPTURED_IN"`),
        `two|${worktree}`,
      );
      NodeFS.rmSync(NodePath.join(project, "hold"));
      assert.equal(yield* shellUntil(other, `printf '%s' "$CAPTURED_IN"`, other), other);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(ServerConfig.layerTest(dir, { prefix: "t3-dev-shell-state-" })),
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
        ),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("runs a first capture again that a restarted server left unfinished", () => {
    const dir = tempDir();
    const project = NodePath.join(dir, "project");
    NodeFS.mkdirSync(project);
    NodeFS.writeFileSync(NodePath.join(project, "flake.nix"), "{ outputs = _: { }; }\n");
    NodeFS.writeFileSync(NodePath.join(project, "value"), "resumed");
    const base = NodePath.join(dir, "base");
    // What a server stopped during the first capture leaves behind.
    const shells = NodePath.join(base, "userdata", "dev-shells");
    NodeFS.mkdirSync(shells, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(shells, "unfinished.loading"),
      JSON.stringify({ flake: project, cwd: project }),
    );
    const environment = { PATH: `${fakeNix(dir)}:${process.env.PATH ?? ""}`, HOME: dir };
    return Effect.gen(function* () {
      const devShells = yield* DevShellEnvironment;
      // The capture's own marker replaces the one found at start.
      assert.isFalse(NodeFS.existsSync(NodePath.join(shells, "unfinished.loading")));
      // Without a prepare call, the command waits for the capture the new server ran again.
      assert.equal(
        yield* bashAsync(
          `. '${devShells.claudeEnvironment.CLAUDE_ENV_FILE}'; printf '%s' "\${FROM_FLAKE-none}"`,
          environment,
          project,
        ),
        "resumed",
      );
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(ServerConfig.layerTest(dir, base)),
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
        ),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("stays out of the way when turned off", () =>
    Effect.gen(function* () {
      const devShells = yield* DevShellEnvironment;
      assert.deepEqual(devShells.environment, {});
      assert.deepEqual(devShells.claudeEnvironment, {});
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-shell-off-" })),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, {
              PATH: "/usr/bin",
              [DEV_SHELL_DISABLE_ENV]: "0",
            }),
          ),
        ),
      ),
    ),
  );
});
