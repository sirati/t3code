{ pkgs }:
let
  inherit (pkgs) lib;
  targets = {
    linux-x64 = {
      platform = "linux";
      arch = "x64";
      target = "AppImage";
      rust = [ "x86_64-unknown-linux-gnu" ];
      host = "x86_64-linux";
    };
    linux-arm64 = {
      platform = "linux";
      arch = "arm64";
      target = "AppImage";
      rust = [ "aarch64-unknown-linux-gnu" ];
      host = "aarch64-linux";
    };
    mac-x64 = {
      platform = "mac";
      arch = "x64";
      target = "dmg";
      rust = [ "x86_64-apple-darwin" ];
      host = "darwin";
    };
    mac-arm64 = {
      platform = "mac";
      arch = "arm64";
      target = "dmg";
      rust = [ "aarch64-apple-darwin" ];
      host = "darwin";
    };
    mac-universal = {
      platform = "mac";
      arch = "universal";
      target = "dmg";
      rust = [
        "x86_64-apple-darwin"
        "aarch64-apple-darwin"
      ];
      host = "darwin";
    };
    win-x64 = {
      platform = "win";
      arch = "x64";
      target = "nsis";
      rust = [ "x86_64-pc-windows-msvc" ];
      host = "x86_64-linux";
    };
    win-arm64 = {
      platform = "win";
      arch = "arm64";
      target = "nsis";
      rust = [ "aarch64-pc-windows-msvc" ];
      host = "x86_64-linux";
    };
  };
  makeRelease =
    name: cfg:
    let
      host = pkgs.stdenv.hostPlatform;
      supported =
        if cfg.host == "darwin" then
          host.isDarwin
        else if cfg.host == "linux" then
          host.isLinux
        else
          cfg.host == host.system;
      builder = pkgs.writeShellApplication {
        name = "t3code-release-${name}";
        runtimeInputs =
          if !supported then
            [ ]
          else
            with pkgs;
            [
              t3code-nodejs
              t3code-pnpm
              git
              curl
              python3
              pkg-config
              rustup
              cargo-xwin
              clang
              lld
              cmake
              gnumake
              stdenv.cc
              unzip
              zip
              gnutar
              xz
              imagemagick
            ]
            ++ lib.optionals host.isLinux [ pkgs.p7zip ]
            ++ lib.optionals (cfg.platform == "win") [ pkgs.wineWow64Packages.stable ];
        text =
          if !supported then
            ''
              echo ${lib.escapeShellArg "${name} requires a ${cfg.host} builder. See docs/operations/nix.md."} >&2
              exit 1
            ''
          else
            ''
              if [[ ! -f scripts/build-desktop-artifact.ts ]]; then
                echo "Run this command from the T3 Code checkout." >&2
                exit 1
              fi
              export PATH="$PWD/node_modules/.bin:$PATH"
              export RUSTUP_TOOLCHAIN=${pkgs.rustc.version}
              rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
              rustup target add ${lib.escapeShellArgs cfg.rust}
              export RUSTC="$(rustup which rustc)"
              export RUSTDOC="$(rustup which rustdoc)"
              export npm_config_nodedir=${pkgs.t3code-nodejs}
              export ELECTRON_SKIP_BINARY_DOWNLOAD=1
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              ${lib.optionalString host.isLinux ''
                export PKG_CONFIG_PATH="${
                  lib.makeSearchPath "lib/pkgconfig" [
                    pkgs.libsecret.dev
                    pkgs.glib.dev
                  ]
                }:''${PKG_CONFIG_PATH:-}"
                export LD_LIBRARY_PATH="${
                  lib.makeLibraryPath [
                    pkgs.stdenv.cc.cc.lib
                    pkgs.libsecret
                  ]
                }:''${LD_LIBRARY_PATH:-}"
              ''}
              pnpm install --frozen-lockfile
              ${lib.optionalString (cfg.platform == "win") ''
                cargo xwin build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target ${builtins.head cfg.rust}
                export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1
              ''}
              exec node scripts/build-desktop-artifact.ts \
                --platform ${cfg.platform} --arch ${cfg.arch} --target ${cfg.target} "$@"
            '';
      };
    in
    {
      type = "app";
      program = lib.getExe builder;
    };
in
lib.mapAttrs' (name: cfg: lib.nameValuePair "release-${name}" (makeRelease name cfg)) targets
