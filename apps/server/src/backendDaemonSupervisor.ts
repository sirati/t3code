// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// This process boundary must survive failure to load a replacement backend.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isBackendDaemonReady, type BackendDaemonRole } from "./backendDaemonProtocol.ts";

export interface DaemonCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ManagedProcess {
  readonly process: NodeChildProcess.ChildProcess;
  readonly command: DaemonCommand;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  closed: boolean;
  stopRequested: boolean;
}

export interface BackendDaemonSupervisorOptions {
  readonly platform: NodeJS.Platform;
  readonly hostCommand: (descriptorFile: string) => Promise<DaemonCommand>;
  readonly backendCommand: (descriptorFile: string) => Promise<DaemonCommand>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onError: (error: Error) => void;
}

export class BackendDaemonSupervisor {
  readonly #options: BackendDaemonSupervisorOptions;
  readonly #processes = new Set<ManagedProcess>();
  readonly #failure = Promise.withResolvers<Error>();
  #directory: string | undefined;
  #descriptorFile: string | undefined;
  #host: ManagedProcess | undefined;
  #backend: ManagedProcess | undefined;
  #startup: Promise<void> | undefined;
  #reload: Promise<void> | undefined;
  #stop: Promise<void> | undefined;
  #stopping = false;
  #state: "stopped" | "starting" | "running" | "reloading" | "degraded" = "stopped";

  constructor(options: BackendDaemonSupervisorOptions) {
    this.#options = options;
  }

  get failure(): Promise<Error> {
    return this.#failure.promise;
  }

  get status() {
    return {
      state: this.#state,
      hostPid: this.#host?.closed ? undefined : this.#host?.process.pid,
      backendPid: this.#backend?.closed ? undefined : this.#backend?.process.pid,
    };
  }

  start(): Promise<void> {
    this.#startup ??= this.#start();
    return this.#startup;
  }

  async #start(): Promise<void> {
    this.#state = "starting";
    try {
      this.#directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-daemon-"));
      await NodeFSP.chmod(this.#directory, 0o700);
      this.#descriptorFile = NodePath.join(this.#directory, "host.json");
      const endpoint =
        this.#options.platform === "win32"
          ? `\\\\.\\pipe\\t3-daemon-${NodeCrypto.randomUUID()}`
          : NodePath.join(this.#directory, "host.sock");
      await NodeFSP.writeFile(
        this.#descriptorFile,
        JSON.stringify({ endpoint, token: NodeCrypto.randomBytes(32).toString("hex") }),
        { mode: 0o600 },
      );
      this.#host = this.#spawn(
        await resolveCommand(await this.#options.hostCommand(this.#descriptorFile)),
        "host",
      );
      await this.#host.ready;
      this.#backend = this.#spawn(
        await resolveCommand(await this.#options.backendCommand(this.#descriptorFile)),
        "backend",
      );
      await this.#backend.ready;
      if (!this.#stopping) this.#state = "running";
    } catch (error) {
      await this.#cleanup();
      this.#state = "stopped";
      throw error;
    }
  }

  #spawn(command: DaemonCommand, role: BackendDaemonRole): ManagedProcess {
    if (this.#stopping) throw new Error("The backend daemon is stopping.");
    const child = NodeChildProcess.spawn(command.command, [...command.args], {
      env: { ...(this.#options.environment ?? process.env) },
      detached: this.#options.platform !== "win32",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const record: ManagedProcess = {
      process: child,
      command,
      ready: ready.promise,
      exited: exited.promise,
      closed: false,
      stopRequested: false,
    };
    this.#processes.add(record);
    const timeout = setTimeout(
      () => ready.reject(new Error(`The ${role} did not become ready.`)),
      this.#options.startupTimeoutMs ?? 30 * 60_000,
    );
    const onMessage = (message: unknown) => {
      if (isBackendDaemonReady(message, role)) ready.resolve();
    };
    const onError = (error: Error) => {
      ready.reject(error);
      if (child.pid === undefined) finish();
      else this.#options.onError(error);
    };
    const finish = () => {
      if (record.closed) return;
      record.closed = true;
      this.#processes.delete(record);
      ready.reject(new Error(`The ${role} exited before becoming ready.`));
      exited.resolve();
      if (this.#stopping) return;
      if (record === this.#host)
        this.#failure.resolve(new Error("The persistent provider host exited."));
      else if (
        record === this.#backend &&
        this.#reload === undefined &&
        this.#state === "running"
      ) {
        void this.reload().catch((cause: unknown) => this.#options.onError(asError(cause)));
      }
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.once("exit", finish);
    void record.ready.then(
      () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
      },
      () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
      },
    );
    return record;
  }

  reload(): Promise<void> {
    if (this.#reload !== undefined) return this.#reload;
    this.#reload = this.#replace().finally(() => {
      this.#reload = undefined;
    });
    return this.#reload;
  }

  async #replace(): Promise<void> {
    await this.#startup;
    if (this.#stopping || this.#descriptorFile === undefined || this.#host?.closed !== false)
      throw new Error("The provider host is not available for reload.");
    const previous = this.#backend;
    // Resolve before draining the old backend, so a missing target causes no outage.
    const next = await resolveCommand(await this.#options.backendCommand(this.#descriptorFile));
    if (this.#stopping) return;
    this.#state = "reloading";
    try {
      if (previous !== undefined) await this.#terminate(previous, false);
    } catch (error) {
      this.#state = "degraded";
      throw error;
    }
    let candidate: ManagedProcess | undefined;
    try {
      candidate = this.#spawn(next, "backend");
      await candidate.ready;
      this.#backend = candidate;
      this.#state = "running";
    } catch (error) {
      if (candidate !== undefined) await this.#terminate(candidate, true);
      if (this.#stopping) return;
      this.#state = "degraded";
      if (previous === undefined) throw error;
      try {
        const rollback = this.#spawn(previous.command, "backend");
        this.#backend = rollback;
        await rollback.ready;
        this.#state = "running";
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Replacement and rollback both failed; the provider host remains running.",
          { cause: rollbackError },
        );
      }
      throw new Error("The replacement backend failed; the previous backend was restored.", {
        cause: error,
      });
    }
  }

  async #terminate(record: ManagedProcess, force: boolean): Promise<void> {
    if (record.closed) return;
    if (!record.stopRequested) {
      record.stopRequested = true;
      if (record.process.connected) {
        record.process.send({ type: "t3-daemon-stop" }, (error) => {
          if (error !== null && !record.closed) record.process.kill("SIGTERM");
        });
      } else record.process.kill("SIGTERM");
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        record.exited,
        new Promise<void>((resolve, reject) => {
          timeout = setTimeout(() => {
            if (force) {
              record.process.kill("SIGKILL");
              void record.exited.then(resolve);
            } else
              reject(
                new Error(
                  "The old backend did not finish its handover; no replacement was started.",
                ),
              );
          }, this.#options.shutdownTimeoutMs ?? 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  stop(): Promise<void> {
    this.#stopping = true;
    this.#stop ??= (async () => {
      await this.#cleanup();
      await Promise.allSettled(
        [this.#startup, this.#reload].filter((operation) => operation !== undefined),
      );
      await this.#cleanup();
      this.#state = "stopped";
    })();
    return this.#stop;
  }

  async #cleanup(): Promise<void> {
    for (const record of [...this.#processes].reverse()) await this.#terminate(record, true);
    if (this.#directory !== undefined)
      await NodeFSP.rm(this.#directory, { recursive: true, force: true });
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function resolveCommand(command: DaemonCommand): Promise<DaemonCommand> {
  await NodeFSP.access(command.command, NodeFS.constants.X_OK);
  return { command: await NodeFSP.realpath(command.command), args: [...command.args] };
}
