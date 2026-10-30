{
  lib,
  stdenv,
  fetchurl,
  electron_44-bin ? null,
  unzip,
  makeWrapper,
}:
let
  version = (lib.importJSON ../apps/desktop/package.json).dependencies.electron;
  sources = {
    x86_64-linux = {
      tag = "linux-x64";
      hash = "62df9375ef035f2835a18cd7f9bff1959a185da22f2ecba1daa37cd9caee1dc5";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      hash = "558ae899d98b70236325d81da44bb6b2c988dd9a7bd16be17cea25f06e56cc14";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      hash = "0d52465c24865981a9a68621c7068f124ef9f2a4caf5119afde62b04fffea66d";
    };
    aarch64-darwin = {
      tag = "darwin-arm64";
      hash = "8e9f6041d3aa62229332b033d0390fd213a9b10cd078163f3f5fe988ee91baf7";
    };
  };
  source = sources.${stdenv.hostPlatform.system};
  src = fetchurl {
    url = "https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${source.tag}.zip";
    sha256 = source.hash;
  };
in
if stdenv.hostPlatform.isLinux then
  electron_44-bin.overrideAttrs { inherit version src; }
else
  stdenv.mkDerivation {
    pname = "t3code-electron";
    inherit version src;
    nativeBuildInputs = [
      unzip
      makeWrapper
    ];
    dontUnpack = true;
    dontBuild = true;
    installPhase = ''
      mkdir -p "$out/Applications"
      unzip -q "$src" -d "$out/Applications"
      makeWrapper "$out/Applications/Electron.app/Contents/MacOS/Electron" "$out/bin/electron"
    '';
    meta = {
      license = lib.licenses.mit;
      platforms = builtins.attrNames sources;
      mainProgram = "electron";
    };
  }
