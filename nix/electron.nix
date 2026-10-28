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
      hash = "6e7fd2d450d442507b846ace4ae6e2bd17e1b1653e86a033b5231abfc23e6df4";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      hash = "8e70d53d920d84db869023280e5a1fbda82ecc58fea4443748e58309a3c80238";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      hash = "451363b59bb7d2c1c9e0c4baa99106004eaabe724aa21a0c6b4c87469293531a";
    };
    aarch64-darwin = {
      tag = "darwin-arm64";
      hash = "4af51382278d00291dfcda265eddd9bab6e98cebb09f46aadc8438bf606de162";
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
