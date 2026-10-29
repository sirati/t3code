{ pkgs }:
pkgs.mkShell {
  packages =
    with pkgs;
    [
      t3code-nodejs
      t3code-pnpm
      t3code-electron
      git
      ripgrep
      jq
      python3
      pkg-config
      node-gyp
      rustc
      cargo
      rustfmt
      clippy
      nixfmt
      curl
      unzip
      zip
      imagemagick
    ]
    ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.libicns ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.libsecret ];
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  # Read by apps/web/vite.config.ts for browser tests.
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
    pkgs.lib.getExe pkgs.chromium
  );
  npm_config_nodedir = "${pkgs.t3code-nodejs}";
  # Electron's npm entry point appends path.txt to this directory.
  ELECTRON_OVERRIDE_DIST_PATH =
    if pkgs.stdenv.hostPlatform.isLinux then
      "${pkgs.t3code-electron}/libexec/electron"
    else
      "${pkgs.t3code-electron}/Applications";
  LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
    pkgs.lib.makeLibraryPath [
      pkgs.stdenv.cc.cc.lib
      pkgs.libsecret
    ]
  );
  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"
  '';
}
