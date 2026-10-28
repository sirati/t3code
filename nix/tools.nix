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
      hash = "6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      hash = "42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      hash = "69316aaafb4dfcb25ac7b9a460f5c60928a37580284fde410144d0e6c8672d0f";
    };
    aarch64-darwin = {
      tag = "darwin-arm64";
      hash = "18830bf448fe187c650dc28c98aa8c968ed1d40b6dd032c081e70a384a1bf660";
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
