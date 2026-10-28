// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS as METHODS,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Socket from "effect/socket/Socket";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeUtil from "node:util";
import * as ClientSupervisor from "../../../packages/client-runtime/src/connection/supervisor.ts";
import * as ConnectionDriver from "../../../packages/client-runtime/src/connection/driver.ts";
import * as Connectivity from "../../../packages/client-runtime/src/connection/connectivity.ts";
import * as ConnectionWakeups from "../../../packages/client-runtime/src/connection/wakeups.ts";
import {
  PrimaryConnectionTarget,
  ConnectionTransientError,
} from "../../../packages/client-runtime/src/connection/model.ts";
import { appendOrchestrationProtocol } from "../../../packages/client-runtime/src/connection/compatibility.ts";
import { resolveRemoteWebSocketConnectionUrl } from "../../../packages/client-runtime/src/authorization/remote.ts";
import * as RpcSession from "../../../packages/client-runtime/src/rpc/session.ts";
import * as ClientRpc from "../../../packages/client-runtime/src/rpc/client.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../../packages/client-runtime/src/environment/descriptor.ts";
import { BackendDaemonSupervisor } from "./backendDaemonSupervisor.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const launchedJson = Schema.fromJsonString(
  Schema.Struct({ threadId: ThreadId, runId: Schema.NullOr(RunId) }),
);

const unusedPort = Effect.promise(async () => {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No TCP fixture address.");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
});

it.live(
  "retains an approval-waiting native turn and reconnects the existing client across reload",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const executable = yield* HostProcess.ExecutablePath;
        const platform = yield* HostProcess.Platform;
        const environment = yield* HostProcess.Environment;
        const entry = yield* path.fromFileUrl(new URL("./bin.ts", import.meta.url));
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handover-e2e-" });
        const workspace = path.join(root, "workspace");
        const home = path.join(root, "home");
        yield* fs.makeDirectory(workspace, { recursive: true });
        yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
        yield* fs.writeFileString(
          path.join(home, "userdata", "settings.json"),
          '{"defaultRuntimeMode":"approval-required"}',
        );
        yield* fs.writeFileString(path.join(workspace, "README.md"), "Handover fixture.\n");
        const run = Effect.fn("HandoverFixture.exec")(
          (command: string, args: ReadonlyArray<string>, cwd = workspace) =>
            Effect.tryPromise((signal) =>
              execFile(command, [...args], {
                cwd,
                signal,
                env: { ...environment, T3CODE_HOME: home, T3CODE_MODE: "web" },
                maxBuffer: 1024 * 1024,
              }),
            ),
        );
        yield* run("git", ["init", "--initial-branch=main"]);
        yield* run("git", ["add", "README.md"]);
        yield* run("git", [
          "-c",
          "user.name=Handover fixture",
          "-c",
          "user.email=handover@example.invalid",
          "commit",
          "-m",
          "fixture",
        ]);
        const port = yield* unusedPort;
        const origin = `http://127.0.0.1:${port}`;
        const args = [
          "--base-dir",
          home,
          "--mode",
          "web",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--dev-url",
          `${origin}/frontend`,
        ];
        const daemon = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new BackendDaemonSupervisor({
                platform,
                environment: { ...environment, T3CODE_HOME: home },
                workingDirectory: workspace,
                output: "ignore",
                hostCommand: async (descriptor) => ({
                  command: executable,
                  args: [entry, "__provider-host", ...args, "--descriptor-file", descriptor],
                }),
                backendCommand: async (descriptor) => ({
                  command: executable,
                  args: [entry, "serve", ...args, "--provider-host-descriptor-file", descriptor],
                }),
                onError: () => {},
              }),
          ),
          (instance) => Effect.promise(() => instance.stop()),
        );
        yield* Effect.promise(() => daemon.start());
        yield* run(executable, [entry, "project", "add", workspace, "--base-dir", home]);
        const issued = yield* run(executable, [
          entry,
          "auth",
          "session",
          "issue",
          "--base-dir",
          home,
          "--token-only",
        ]);
        const token = issued.stdout.trim();
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: origin });
        const httpClient = yield* HttpClient.HttpClient;
        const target = new PrimaryConnectionTarget({
          environmentId: descriptor.environmentId,
          label: "Handover fixture",
          httpBaseUrl: origin,
          wsBaseUrl: origin.replace("http:", "ws:"),
        });
        const factory = yield* RpcSession.make().pipe(
          Effect.provide(Socket.layerWebSocketConstructorGlobal),
        );
        const driver = ConnectionDriver.ConnectionDriver.of({
          connect: Effect.fn("HandoverFixture.connect")(
            function* () {
              const url = yield* resolveRemoteWebSocketConnectionUrl({
                httpBaseUrl: origin,
                wsBaseUrl: target.wsBaseUrl,
                bearerToken: token,
              }).pipe(
                Effect.mapError(
                  () =>
                    new ConnectionTransientError({
                      reason: "transport",
                      detail: "Fixture authorization failed.",
                    }),
                ),
              );
              const prepared = {
                environmentId: target.environmentId,
                label: target.label,
                httpBaseUrl: origin,
                socketUrl: appendOrchestrationProtocol(url),
                httpAuthorization: { _tag: "Bearer" as const, token },
                target,
              };
              const session = yield* factory.connect(prepared);
              return { prepared, session };
            },
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
          preflight: () => Effect.succeed(true),
          checkHost: () => Effect.succeed("answered"),
        });
        const connection = yield* ClientSupervisor.make(
          { target, profile: Option.none(), enabled: true },
          { initiallyDesired: true },
        ).pipe(
          Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
          Effect.provide(
            Layer.merge(
              Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
              ConnectionWakeups.layer({ changes: Stream.never }),
            ),
          ),
        );
        const currentSession = () =>
          SubscriptionRef.changes(connection.session).pipe(
            Stream.filter(Option.isSome),
            Stream.map((session) => session.value),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        const originalSession = yield* currentSession();
        yield* originalSession.ready;
        const launched = yield* Schema.decodeEffect(launchedJson)(
          (yield* run(executable, [
            entry,
            "thread",
            "start",
            workspace,
            "Continue after reload",
            "--provider",
            "devReplay",
            "--model",
            "approval",
            "--json",
            "--base-dir",
            home,
          ])).stdout.trim(),
        );
        assert.isNotNull(launched.runId);
        const pending = yield* Deferred.make<RuntimeRequestId, Error>();
        const completed = yield* Deferred.make<void, Error>();
        const cursor = yield* Ref.make<number | undefined>(undefined);
        const sequences: number[] = [];
        yield* ClientRpc.subscribeDynamic(METHODS.subscribeThread, () =>
          Ref.get(cursor).pipe(
            Effect.map((afterSequence) => ({
              threadId: launched.threadId,
              requestCompletionMarker: true,
              ...(afterSequence === undefined ? {} : { afterSequence }),
            })),
          ),
        ).pipe(
          Stream.runForEach((item) =>
            Effect.gen(function* () {
              if (item.kind === "snapshot") {
                yield* Ref.set(cursor, item.snapshotSequence);
                const request = item.projection.runtimeRequests.find(
                  (request) => request.status === "pending",
                );
                if (request !== undefined) yield* Deferred.succeed(pending, request.id);
                const error = item.projection.turnItems.find((item) => item.type === "error");
                if (error?.type === "error")
                  yield* Deferred.fail(pending, new Error(error.failure.message));
              } else if (item.kind === "event") {
                sequences.push(item.sequence);
                yield* Ref.set(cursor, item.sequence);
                if (
                  item.event.type === "turn-item.updated" &&
                  item.event.payload.type === "error"
                ) {
                  const error = new Error(item.event.payload.failure.message);
                  yield* Deferred.fail(pending, error);
                  yield* Deferred.fail(completed, error);
                }
                if (
                  item.event.type === "runtime-request.updated" &&
                  item.event.payload.status === "pending"
                )
                  yield* Deferred.succeed(pending, item.event.payload.id);
                if (
                  item.event.type === "run.updated" &&
                  item.event.payload.id === launched.runId &&
                  item.event.payload.status === "completed"
                ) {
                  yield* Deferred.succeed(completed, undefined);
                  yield* Deferred.fail(
                    pending,
                    new Error("The fixture turn completed without asking for approval."),
                  );
                }
              }
            }),
          ),
          Effect.provideService(ClientSupervisor.EnvironmentSupervisor, connection),
          Effect.tapCause((cause) => {
            const error = new Error("Thread subscription failed.", { cause });
            return Deferred.fail(pending, error).pipe(
              Effect.andThen(Deferred.fail(completed, error)),
            );
          }),
          Effect.forkScoped,
        );
        const requestId = yield* Deferred.await(pending);
        const before = yield* originalSession.client[METHODS.getThreadProjection]({
          threadId: launched.threadId,
        });
        const processBefore = daemon.status;
        yield* Effect.promise(() => daemon.reload());
        const replacement = yield* SubscriptionRef.changes(connection.session).pipe(
          Stream.filter(Option.isSome),
          Stream.map((session) => session.value),
          Stream.filter((session) => session !== originalSession),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        yield* replacement.ready;
        const after = yield* replacement.client[METHODS.getThreadProjection]({
          threadId: launched.threadId,
        });
        assert.equal(daemon.status.hostPid, processBefore.hostPid);
        assert.notEqual(daemon.status.backendPid, processBefore.backendPid);
        assert.deepEqual(
          after.attempts.map((attempt) => attempt.id),
          before.attempts.map((attempt) => attempt.id),
        );
        assert.deepEqual(
          after.providerThreads.map((thread) => thread.nativeThreadRef),
          before.providerThreads.map((thread) => thread.nativeThreadRef),
        );
        assert.equal(
          after.runtimeRequests.find((request) => request.id === requestId)?.status,
          "pending",
        );
        yield* replacement.client[METHODS.dispatchCommand]({
          type: "runtime-request.respond",
          commandId: CommandId.make("handover-accept"),
          threadId: launched.threadId,
          requestId,
          decision: "accept",
        });
        yield* Deferred.await(completed);
        assert.equal(new Set(sequences).size, sequences.length);
        const final = yield* replacement.client[METHODS.getThreadProjection]({
          threadId: launched.threadId,
        });
        assert.equal(final.runs.find((run) => run.id === launched.runId)?.status, "completed");
        assert.equal(final.attempts.length, before.attempts.length);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
);
