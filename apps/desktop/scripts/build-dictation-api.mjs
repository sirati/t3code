import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native build tooling targets the host outside the Effect runtime.
const hostPlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native build tooling targets the host outside the Effect runtime.
const hostArch = process.arch;

const { values } = NodeUtil.parseArgs({
  options: {
    "package-root": { type: "string" },
    platform: { type: "string", default: hostPlatform },
    arch: { type: "string", default: hostArch },
  },
});
const root =
  values["package-root"] ??
  NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("@dictation-api/client"));
const packageRoot = NodePath.join(root, "bindings/node");
const targetPlatform = { mac: "darwin", win: "win32" }[values.platform] ?? values.platform;
const architectures = values.arch === "universal" ? ["x64", "arm64"] : [values.arch];
for (const arch of architectures) {
  const machine = { x64: "x86_64", arm64: "aarch64" }[arch];
  const suffix = { linux: "unknown-linux-gnu", darwin: "apple-darwin", win32: "pc-windows-msvc" }[
    targetPlatform
  ];
  if (!machine || !suffix)
    throw new Error(`Unsupported dictation target: ${targetPlatform}/${arch}`);
  if (values.arch === "universal" && targetPlatform !== "darwin")
    throw new Error("Universal dictation addons require macOS.");
  const platform =
    targetPlatform === "linux"
      ? `linux-${arch}-gnu`
      : `${targetPlatform}-${arch}${targetPlatform === "win32" ? "-msvc" : ""}`;
  const output = NodePath.resolve(packageRoot, `dictation-api.${platform}.node`);
  if (!NodeFS.existsSync(output)) {
    const target = `${machine}-${suffix}`;
    const crossWindows = targetPlatform === "win32" && hostPlatform !== "win32";
    if (targetPlatform === "darwin" && hostPlatform !== "darwin")
      throw new Error("Building macOS dictation addons requires a Darwin builder and Apple SDK.");
    NodeChildProcess.execFileSync(
      "cargo",
      [
        ...(crossWindows ? ["xwin"] : []),
        "build",
        "--locked",
        "--release",
        "--target",
        target,
        "--target-dir",
        NodePath.resolve(root, "target"),
        "-p",
        "dictation-api-node",
      ],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    const library =
      targetPlatform === "win32"
        ? "dictation_api_node.dll"
        : targetPlatform === "darwin"
          ? "libdictation_api_node.dylib"
          : "libdictation_api_node.so";
    NodeFS.copyFileSync(NodePath.resolve(root, "target", target, "release", library), output);
  }
}
