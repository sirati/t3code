{
  lib,
  rustPlatform,
  src,
}:
rustPlatform.buildRustPackage {
  pname = "t3code-session-keeper";
  version = (lib.importJSON ../apps/server/package.json).version;
  inherit src;
  sourceRoot = "${src.name}/native/session-keeper";
  cargoLock.lockFile = ../native/session-keeper/Cargo.lock;
  meta = {
    description = "Keeps T3 Code provider sessions running while the server restarts";
    homepage = "https://github.com/pingdotgg/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3-session-keeper";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
