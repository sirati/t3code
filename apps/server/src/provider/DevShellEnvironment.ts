// @effect-diagnostics nodeBuiltinImport:off - The captured dev shells are files that agent shells source.
/**
 * Agent shells get the dev shell of their project's main-checkout flake, also in distant worktrees.
 * `nix develop` runs per working directory and again when the flake changes; shells source the
 * captured variables before each command. A new directory starts from a sibling's capture, and a
 * command waits on nix only while its directory has none, so none runs without the dev shell.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/** Set to "0" to start agents without their project's dev shell. */
export const DEV_SHELL_DISABLE_ENV = "T3CODE_NIX_DEV_SHELL";
const POLL_INTERVAL = "30 seconds";
// Half-second steps a command waits for its directory's first capture: five minutes.
const FIRST_SHELL_WAIT_STEPS = 600;
const NIX_DEVELOP_TIMEOUT = "10 minutes";
const MAX_SCAN_DEPTH = 3;

// Variables of the `nix develop` process itself, not of the dev shell, and the ones T3 sets.
const PROCESS_VARIABLES = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TEMPDIR",
  "NIX_BUILD_TOP",
  "HISTFILE",
  "PATH",
  "BASH_ENV",
  "PROMPT_COMMAND",
  "CLAUDE_ENV_FILE",
  "SHELLOPTS",
  "IFS",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Bash's own state, which a shell must not take from another one.
const BASH_VARIABLE = /^BASH/;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const hash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 20);

/** Parses `env -0` output. */
function parseEnvironment(output: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const entry of output.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) variables.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return variables;
}

/**
 * The lines that apply a captured dev shell. Sourced before every command, so they only set
 * variables: they replace what an earlier dev shell set and keep its PATH entries from piling up.
 */
export function devShellScript(input: {
  readonly flake: string;
  readonly cwd: string;
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly shell: ReadonlyMap<string, string>;
}): string {
  const exports: Array<readonly [string, string]> = [];
  for (const [name, value] of input.shell) {
    if (PROCESS_VARIABLES.has(name) || BASH_VARIABLE.test(name) || !VARIABLE_NAME.test(name))
      continue;
    if (input.base[name] === value) continue;
    exports.push([name, value]);
  }
  const basePath = new Set((input.base.PATH ?? "").split(":"));
  const prefix = [...new Set((input.shell.get("PATH") ?? "").split(":"))]
    .filter((entry) => entry.length > 0 && !basePath.has(entry))
    .join(":");
  const names = exports.map(([name]) => name).join(" ");
  return [
    `# T3 Code: the nix dev shell of ${input.flake} for ${input.cwd}.`,
    `if [ -n "\${BASH_VERSION-}" ]; then`,
    `  for __t3_name in \${__T3_DEVSHELL_NAMES-}; do`,
    `    case ${quote(` ${names} `)} in *" $__t3_name "*) ;; *) unset "$__t3_name" ;; esac`,
    `  done`,
    ...exports.map(([name, value]) => `  export ${name}=${quote(value)}`),
    `  if [ -n "\${__T3_DEVSHELL_PATH-}" ]; then PATH=\${PATH/"$__T3_DEVSHELL_PATH:"/}; fi`,
    ...(prefix.length > 0 ? [`  export PATH=${quote(prefix)}:"$PATH"`] : []),
    `  export __T3_DEVSHELL_PATH=${quote(prefix)} __T3_DEVSHELL_NAMES=${quote(names)}`,
    `  unset __t3_name`,
    `fi`,
    "",
  ].join("\n");
}

/**
 * Picks the dev shell of the directory a command runs in; most specific directory first. While the
 * `loading` file of a directory without a dev shell exists, its first capture is running, and the
 * command waits for it.
 */
export function dispatcherScript(
  entries: ReadonlyArray<{ readonly cwd: string; readonly file: string; readonly loading: string }>,
): string {
  const sorted = [...entries].sort((a, b) => b.cwd.length - a.cwd.length);
  return [
    "# T3 Code: loads the nix dev shell for the directory an agent command runs in.",
    `if [ -n "\${BASH_VERSION-}" ]; then`,
    `  case "$PWD/" in`,
    ...sorted.map(
      ({ cwd, file, loading }) =>
        `    ${quote(cwd.endsWith("/") ? cwd : `${cwd}/`)}*) __t3_file=${quote(file)} __t3_loading=${quote(loading)} ;;`,
    ),
    `    *) __t3_file= ;;`,
    `  esac`,
    `  if [ -n "$__t3_file" ]; then`,
    `    __t3_wait=0`,
    `    while [ ! -r "$__t3_file" ] && [ -e "$__t3_loading" ] && [ "$__t3_wait" -lt ${FIRST_SHELL_WAIT_STEPS} ]; do`,
    `      sleep 0.5 2>/dev/null || break`,
    `      __t3_wait=$((__t3_wait + 1))`,
    `    done`,
    `    [ ! -r "$__t3_file" ] || . "$__t3_file"`,
    `  fi`,
    `  unset __t3_file __t3_loading __t3_wait`,
    `fi`,
    "",
  ].join("\n");
}

const writeAtomic = (path: string, content: string) => {
  const pending = `${path}.${NodeCrypto.randomUUID()}.pending`;
  NodeFS.writeFileSync(pending, content, { mode: 0o600 });
  NodeFS.renameSync(pending, path);
};
// Best effort: without these files commands only stop waiting for, or start from, a capture.
const remove = (path: string) => {
  try {
    NodeFS.rmSync(path, { force: true });
  } catch {}
};
const copy = (from: string, to: string) => {
  try {
    writeAtomic(to, NodeFS.readFileSync(from, "utf8"));
  } catch {}
};

// Only the flake's own nix files decide its dev shell; a scan skips checkouts and build output.
const flakeFingerprint = (flake: string) => {
  const parts: Array<string> = [];
  const visit = (directory: string, depth: number) => {
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !entry.name.startsWith(".") && entry.name !== "node_modules")
          visit(path, depth + 1);
      } else if (entry.name.endsWith(".nix") || entry.name === "flake.lock") {
        try {
          const stat = NodeFS.statSync(path);
          parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
        } catch {}
      }
    }
  };
  visit(flake, 0);
  return hash(parts.join("\n"));
};

interface Entry {
  readonly key: string;
  readonly flake: string;
  readonly cwd: string;
  readonly file: string;
  readonly loading: string;
  fingerprint: string | undefined;
  running: Promise<void> | undefined;
}

interface StoredEntry {
  readonly flake: string;
  readonly cwd: string;
  readonly fingerprint: string;
  readonly loaded: boolean;
}

// What a capture recorded, or nothing for a missing or foreign file.
const readStoredEntry = (path: string): StoredEntry | undefined => {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const stored = value as Partial<StoredEntry>;
    return typeof stored.flake === "string" &&
      typeof stored.cwd === "string" &&
      typeof stored.fingerprint === "string"
      ? {
          flake: stored.flake,
          cwd: stored.cwd,
          fingerprint: stored.fingerprint,
          loaded: stored.loaded === true,
        }
      : undefined;
  } catch {
    return undefined;
  }
};
const writeStoredEntry = (path: string, entry: StoredEntry) =>
  writeAtomic(path, `${JSON.stringify(entry)}\n`);

// Marks a running first capture. It names its directory, so a restarted server runs the capture
// again and commands waiting for it keep waiting.
const writeLoading = (entry: Pick<Entry, "loading" | "flake" | "cwd">) => {
  try {
    writeAtomic(entry.loading, `${JSON.stringify({ flake: entry.flake, cwd: entry.cwd })}\n`);
  } catch {}
};
const readLoading = (path: string): Pick<Entry, "flake" | "cwd"> | undefined => {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { flake, cwd } = value as { readonly flake?: unknown; readonly cwd?: unknown };
    return typeof flake === "string" && typeof cwd === "string" ? { flake, cwd } : undefined;
  } catch {
    return undefined;
  }
};

export class DevShellEnvironment extends Context.Service<
  DevShellEnvironment,
  {
    /** Makes an agent's shells source the dev shell of the directory each command runs in. */
    readonly environment: Readonly<Record<string, string>>;
    /** The same for Claude Code, which re-exports its own PATH after the shell's startup files. */
    readonly claudeEnvironment: Readonly<Record<string, string>>;
    /**
     * Tracks the dev shell of `cwd` without waiting for nix; commands wait for a first capture
     * themselves. Never fails.
     */
    readonly prepare: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/provider/DevShellEnvironment") {}

const disabled = DevShellEnvironment.of({
  environment: {},
  claudeEnvironment: {},
  prepare: Effect.fn("DevShellEnvironment.prepareDisabled")(function* (_cwd: string) {}),
});

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  if (platform === "win32" || hostEnvironment[DEV_SHELL_DISABLE_ENV] === "0") return disabled;
  const runner = yield* ProcessRunner.make();
  const nix = yield* runner
    .run({ command: "nix", args: ["--version"], env: hostEnvironment, timeout: "10 seconds" })
    .pipe(Effect.option);
  if (nix._tag === "None" || nix.value.code !== 0) return disabled;

  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = NodePath.join(stateDir, "dev-shells");
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dispatcher = NodePath.join(directory, "agent-shell.sh");
  const claudeEnvFile = NodePath.join(directory, "claude-env.sh");
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const permits = yield* Semaphore.make(2);
  const entries = new Map<string, Entry>();

  const metadataPath = (entry: Pick<Entry, "key">) => NodePath.join(directory, `${entry.key}.json`);
  const writeDispatcher = () =>
    writeAtomic(
      dispatcher,
      dispatcherScript(
        [...entries.values()].map(({ cwd, file, loading }) => ({ cwd, file, loading })),
      ),
    );
  const entryFor = (flake: string, cwd: string): Entry => {
    const key = hash(`${flake}\0${cwd}`);
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    const entry: Entry = {
      key,
      flake,
      cwd,
      file: NodePath.join(directory, `${key}.sh`),
      loading: NodePath.join(directory, `${key}.loading`),
      fingerprint: undefined,
      running: undefined,
    };
    const stored = readStoredEntry(metadataPath(entry));
    if (stored?.flake === flake && stored.cwd === cwd) entry.fingerprint = stored.fingerprint;
    // A new worktree starts with the dev shell of another directory of the same flake, preferably
    // the main checkout's, until its own capture replaces it.
    if (!NodeFS.existsSync(entry.file)) {
      const siblings = [...entries.values()].filter((other) => other.flake === flake);
      const source = [...siblings.filter((other) => other.cwd === flake), ...siblings].find(
        (other) => NodeFS.existsSync(other.file),
      );
      if (source !== undefined) copy(source.file, entry.file);
    }
    entries.set(key, entry);
    writeDispatcher();
    return entry;
  };

  // A failed capture keeps the previous variables and waits for the flake to change again.
  const capture = Effect.fn("DevShellEnvironment.capture")(function* (entry: Entry) {
    const fingerprint = flakeFingerprint(entry.flake);
    if (fingerprint === entry.fingerprint) return;
    const environmentOf = (command: string, args: ReadonlyArray<string>) =>
      runner.run({
        command,
        args,
        cwd: entry.cwd,
        env: hostEnvironment,
        timeout: NIX_DEVELOP_TIMEOUT,
        maxOutputBytes: 64 * 1024 * 1024,
      });
    // The runner extends the server's environment, so the same run without nix is the baseline.
    const base = yield* environmentOf("env", ["-0"]).pipe(Effect.result);
    const result = yield* environmentOf("nix", [
      "develop",
      entry.flake,
      "--command",
      "env",
      "-0",
    ]).pipe(permits.withPermits(1), Effect.result);
    const loaded =
      result._tag === "Success" &&
      result.success.code === 0 &&
      base._tag === "Success" &&
      base.success.code === 0;
    if (loaded) {
      writeAtomic(
        entry.file,
        devShellScript({
          flake: entry.flake,
          cwd: entry.cwd,
          base: Object.fromEntries(parseEnvironment(base.success.stdout)),
          shell: parseEnvironment(result.success.stdout),
        }),
      );
      yield* Effect.logInfo("Loaded the nix dev shell for agent shells", {
        flake: entry.flake,
        cwd: entry.cwd,
      });
    } else {
      yield* Effect.logWarning("Could not load the nix dev shell; agents keep the previous one", {
        flake: entry.flake,
        cwd: entry.cwd,
        cause:
          result._tag === "Failure"
            ? result.failure
            : result.success.stderr.trim().split("\n").slice(-5).join("\n"),
      });
    }
    entry.fingerprint = fingerprint;
    writeStoredEntry(metadataPath(entry), {
      flake: entry.flake,
      cwd: entry.cwd,
      fingerprint,
      loaded,
    });
  });
  const refresh = (entry: Entry) => {
    if (entry.running !== undefined) return entry.running;
    // Commands in a directory without a dev shell wait for this capture instead of running bare.
    const first = !NodeFS.existsSync(entry.file);
    if (first) writeLoading(entry);
    entry.running = runPromise(
      capture(entry).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not check the nix dev shell", { cwd: entry.cwd, cause }),
        ),
      ),
    ).finally(() => {
      entry.running = undefined;
      if (first) remove(entry.loading);
    });
    return entry.running;
  };

  // The main checkout's flake applies to its worktrees, which may live anywhere.
  const flakeFor = Effect.fn("DevShellEnvironment.flakeFor")(function* (cwd: string) {
    const git = (args: ReadonlyArray<string>) =>
      runner
        .run({
          command: "git",
          args: ["-C", cwd, ...args],
          env: hostEnvironment,
          timeout: "10 seconds",
        })
        .pipe(
          Effect.map((result) => (result.code === 0 ? result.stdout.trim() : undefined)),
          Effect.orElseSucceed(() => undefined),
        );
    const common = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const candidates = [
      common?.endsWith("/.git") === true ? NodePath.dirname(common) : undefined,
      yield* git(["rev-parse", "--show-toplevel"]),
      cwd,
    ];
    return candidates.find(
      (candidate) =>
        candidate !== undefined && NodeFS.existsSync(NodePath.join(candidate, "flake.nix")),
    );
  });

  const prepare = Effect.fn("DevShellEnvironment.prepare")(
    function* (cwd: string) {
      const flake = yield* flakeFor(cwd);
      if (flake === undefined) return;
      // The session starts now; its first command waits if the directory has no dev shell yet.
      void refresh(entryFor(flake, cwd));
    },
    (effect, cwd) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not prepare the nix dev shell", { cwd, cause }),
        ),
      ),
  );

  // Sessions kept across a restart still source these files; keep checking them. A first capture
  // that an earlier server left unfinished runs again.
  const unfinished: Array<Entry> = [];
  for (const name of NodeFS.readdirSync(directory)) {
    const path = NodePath.join(directory, name);
    if (name.endsWith(".loading")) {
      const loading = readLoading(path);
      const entry =
        loading !== undefined && NodeFS.existsSync(loading.cwd)
          ? entryFor(loading.flake, loading.cwd)
          : undefined;
      if (entry !== undefined && !NodeFS.existsSync(entry.file)) unfinished.push(entry);
      if (entry === undefined || entry.loading !== path || NodeFS.existsSync(entry.file))
        remove(path);
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const stored = readStoredEntry(path);
    if (stored !== undefined && NodeFS.existsSync(stored.cwd)) entryFor(stored.flake, stored.cwd);
  }
  writeDispatcher();
  // Claude Code reads CLAUDE_ENV_FILE once per session, so it only points at the live dispatcher.
  const userClaudeEnvFile = hostEnvironment.CLAUDE_ENV_FILE;
  writeAtomic(
    claudeEnvFile,
    [
      ...(userClaudeEnvFile
        ? [`[ ! -r ${quote(userClaudeEnvFile)} ] || . ${quote(userClaudeEnvFile)}`]
        : []),
      `[ ! -r ${quote(dispatcher)} ] || . ${quote(dispatcher)}`,
      "",
    ].join("\n"),
  );
  for (const entry of unfinished) void refresh(entry);
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(POLL_INTERVAL).pipe(
        Effect.andThen(
          Effect.promise(() => Promise.all([...entries.values()].map((entry) => refresh(entry)))),
        ),
      ),
    ),
  );

  return DevShellEnvironment.of({
    environment: { BASH_ENV: dispatcher, PROMPT_COMMAND: `. ${quote(dispatcher)}` },
    claudeEnvironment: { CLAUDE_ENV_FILE: claudeEnvFile },
    prepare,
  });
});

export const layer = Layer.effect(DevShellEnvironment, make);
