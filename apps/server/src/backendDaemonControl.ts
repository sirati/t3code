// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Local control for the standalone supervisor cannot depend on the replaceable backend runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { BackendDaemonStatus } from "./backendDaemonProtocol.ts";

export const CONTROL_FILE = "backend-daemon.json";
const MAX_MESSAGE_BYTES = 16 * 1024;
const CONTROL_TIMEOUT_MS = 31 * 60_000;

interface Transport {
  readonly endpoint: string;
  readonly token: string;
}

export class BackendDaemonControl {
  readonly #owner: NodeSqlite.DatabaseSync;
  readonly #server: NodeNet.Server;
  readonly #sockets = new Set<NodeNet.Socket>();
  readonly #filename: string;
  #closed = false;

  private constructor(owner: NodeSqlite.DatabaseSync, filename: string, server: NodeNet.Server) {
    this.#owner = owner;
    this.#filename = filename;
    this.#server = server;
  }

  static async open(options: {
    readonly stateDirectory: string;
    readonly transportDirectory: string;
    readonly platform: NodeJS.Platform;
    readonly status: () => BackendDaemonStatus;
    readonly reload: () => Promise<void>;
  }): Promise<BackendDaemonControl> {
    await NodeFSP.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const owner = new NodeSqlite.DatabaseSync(
      NodePath.join(options.stateDirectory, "backend-daemon-owner.sqlite"),
    );
    try {
      owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    } catch (cause) {
      owner.close();
      throw new Error("Another backend daemon supervisor owns this T3 home.", { cause });
    }
    const transport: Transport = {
      endpoint:
        options.platform === "win32"
          ? `\\\\.\\pipe\\t3-control-${NodeCrypto.randomUUID()}`
          : NodePath.join(options.transportDirectory, "control.sock"),
      token: NodeCrypto.randomBytes(32).toString("hex"),
    };
    const filename = NodePath.join(options.stateDirectory, CONTROL_FILE);
    const temporary = `${filename}.${NodeCrypto.randomUUID()}.tmp`;
    const server = NodeNet.createServer();
    const control = new BackendDaemonControl(owner, filename, server);
    server.on("connection", (socket) => {
      if (control.#sockets.size >= 64) {
        socket.destroy();
        return;
      }
      control.#sockets.add(socket);
      socket.once("close", () => control.#sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
      let buffer = "";
      let received = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (received) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        received = true;
        let request: unknown;
        try {
          request = JSON.parse(buffer.slice(0, newline));
        } catch {
          socket.end('{"ok":false,"error":"Invalid request."}\n');
          return;
        }
        if (
          typeof request !== "object" ||
          request === null ||
          !("token" in request) ||
          typeof request.token !== "string" ||
          !("op" in request) ||
          (request.op !== "reload" && request.op !== "status")
        ) {
          socket.end('{"ok":false,"error":"Invalid request."}\n');
          return;
        }
        const token = Buffer.from(request.token);
        const expected = Buffer.from(transport.token);
        if (token.length !== expected.length || !NodeCrypto.timingSafeEqual(token, expected)) {
          socket.end('{"ok":false,"error":"Unauthorized."}\n');
          return;
        }
        const operation = request.op === "reload" ? options.reload() : Promise.resolve();
        void operation.then(
          () => socket.end(`${JSON.stringify({ ok: true, status: options.status() })}\n`),
          (cause: unknown) =>
            socket.end(
              `${JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : "Backend reload failed." })}\n`,
            ),
        );
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(transport.endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await NodeFSP.writeFile(temporary, JSON.stringify(transport), { mode: 0o600, flag: "wx" });
      await NodeFSP.rename(temporary, filename);
      return control;
    } catch (cause) {
      await NodeFSP.rm(temporary, { force: true });
      await control.close();
      throw cause;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening)
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    try {
      await NodeFSP.rm(this.#filename, { force: true });
    } finally {
      this.#owner.close();
    }
  }
}

export function requestBackendDaemon(
  transport: Transport,
  op: "reload" | "status",
): Promise<BackendDaemonStatus> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(transport.endpoint);
    let response = "";
    let settled = false;
    const finish = (status: BackendDaemonStatus | Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (status instanceof Error) reject(status);
      else resolve(status);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_TIMEOUT_MS, () =>
      finish(new Error("The backend daemon did not respond.")),
    );
    socket.once("error", finish);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ token: transport.token, op })}\n`),
    );
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES)
        return finish(new Error("The backend daemon response is too large."));
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const decoded: unknown = JSON.parse(response.slice(0, newline));
        if (typeof decoded === "object" && decoded !== null && "ok" in decoded) {
          if (decoded.ok === false && "error" in decoded && typeof decoded.error === "string")
            return finish(new Error(decoded.error));
          if (decoded.ok === true && "status" in decoded && isStatus(decoded.status))
            return finish(decoded.status);
        }
        finish(new Error("The backend daemon returned an invalid response."));
      } catch (cause) {
        finish(new Error("The backend daemon returned invalid JSON.", { cause }));
      }
    });
    socket.once("close", () => {
      if (!settled) finish(new Error("The backend daemon closed its control connection."));
    });
  });
}

function isStatus(value: unknown): value is BackendDaemonStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    ["stopped", "starting", "running", "reloading", "degraded"].includes(String(value.state)) &&
    (!("hostPid" in value) ||
      (typeof value.hostPid === "number" &&
        Number.isSafeInteger(value.hostPid) &&
        value.hostPid > 0)) &&
    (!("backendPid" in value) ||
      (typeof value.backendPid === "number" &&
        Number.isSafeInteger(value.backendPid) &&
        value.backendPid > 0))
  );
}
