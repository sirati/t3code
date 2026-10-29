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
      hash = "2be868b71b0aa71f30e6b5567a106a35a049385e963183c074aad1975ead5167";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      hash = "0e16c008d628a9c8758ee75b6e2faf2f2ee5365e7e522f0884c8e52d0d551d2c";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      hash = "d1c49452bd009411705d0d2ba140e126b6fdd2f69db837437327aab0b2476c2c";
    };
    aarch64-darwin = {
      tag = "darwin-arm64";
      hash = "687f922034f1e991ab34ed7f47c4cb4e5c5e85e974b0ce155c22ce6d6f699aa3";
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
