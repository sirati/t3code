{ pkgs }:
let
  inherit (pkgs)
    lib
    stdenv
    fetchurl
    autoPatchelfHook
    ;
  system = stdenv.hostPlatform.system;
  nodeVersion = (lib.importJSON ../package.json).engines.node;
  pnpmVersion = lib.removePrefix "pnpm@" (lib.importJSON ../package.json).packageManager;
  nodeSources = {
    x86_64-linux = {
      tag = "linux-x64";
      hash = "5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      hash = "89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      hash = "2693310b2820f9350d29524f21344e1c623875bab773457d55b2aceb9670716f";
    };
    aarch64-darwin = {
      tag = "darwin-arm64";
      hash = "af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559";
    };
  };
  nodeSource = nodeSources.${system};
  pnpmSource = (lib.importJSON ./pnpm-sources.json).${system};
  nodejs = stdenv.mkDerivation {
    pname = "t3code-nodejs";
    version = nodeVersion;
    src = fetchurl {
      url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${nodeSource.tag}.tar.xz";
      sha256 = nodeSource.hash;
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
    dontBuild = true;
    dontStrip = true;
    dontPatchELF = true;
    installPhase = ''
      mkdir -p "$out"
      cp -a . "$out/"
      ${lib.optionalString stdenv.hostPlatform.isLinux ''
        # Sorting this upstream ELF's program headers makes the dynamic loader crash.
        patchelf --no-sort \
          --set-interpreter "$(cat "$NIX_CC/nix-support/dynamic-linker")" \
          --set-rpath ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} "$out/bin/node"
      ''}
      PATH="$out/bin:$PATH" patchShebangs "$out/lib/node_modules"
    '';
    passthru = {
      python = pkgs.python3;
    };
    meta = {
      license = lib.licenses.mit;
      platforms = builtins.attrNames nodeSources;
      mainProgram = "node";
    };
  };
  pnpm = stdenv.mkDerivation {
    pname = "t3code-pnpm";
    version = pnpmVersion;
    src = fetchurl pnpmSource;
    nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
    buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
    dontBuild = true;
    installPhase = ''
      install -Dm755 pnpm "$out/bin/pnpm"
      cp -r ${
        pkgs.fetchurl {
          url = "https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz";
          hash = "sha512-wYum2HmT09Fky16JSPMrLAbuhUSH4GzY2GeBNC+z5btGNDZwNHEehoArqpw3vqkGzhkprQjXCITJfYAd8TOJpg==";
        }
      } pnpm.tgz
      tar xf pnpm.tgz
      mkdir -p "$out/dist"
      cp -r package/dist/node-gyp-bin package/dist/node_modules "$out/dist/"
      ln -s pnpm "$out/bin/pn"
    '';
    passthru = {
      nodejs-slim = pkgs.nodejs-slim;
      majorVersion = lib.versions.major pnpmVersion;
    };
    meta = {
      license = lib.licenses.mit;
      platforms = builtins.attrNames nodeSources;
      mainProgram = "pnpm";
    };
  };
in
{
  inherit nodejs pnpm;
}
