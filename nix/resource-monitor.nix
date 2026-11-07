{
  lib,
  rustPlatform,
  src,
}:
rustPlatform.buildRustPackage {
  pname = "t3code-resource-monitor";
  version = (lib.importJSON ../apps/server/package.json).version;
  inherit src;
  sourceRoot = "${src.name}/native/resource-monitor";
  cargoLock.lockFile = ../native/resource-monitor/Cargo.lock;
  meta = {
    description = "Native resource diagnostics sidecar for T3 Code";
    homepage = "https://github.com/pingdotgg/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3-resource-monitor";
    platforms = lib.platforms.linux ++ lib.platforms.darwin ++ lib.platforms.windows;
  };
}
