# Nix development and builds

## Development

From the checkout:

```sh
nix develop
pnpm install --frozen-lockfile
vp run dev
# Or: vp run dev:desktop
```

The shell supplies the Node and pnpm versions in `package.json`, Electron,
Rust, the C compiler, Python, and Linux libsecret headers. Installation is explicit
and needs network access. Re-entering the shell does not install dependencies or
start a server. `vp` comes from the workspace dependencies after the first install.

Electron uses the Nix runtime through `ELECTRON_OVERRIDE_DIST_PATH`. Its development
launcher respects this override without downloading another runtime or changing
permissions in the Nix store. State and ports follow the normal
[development rules](development.md#state-and-ports).

## Install a source build

```sh
nix build
./result/bin/t3code-desktop
./result/bin/t3 --help
# Run without adding it to a profile:
nix run .
nix run .#server -- --help
# Install this checkout in your user profile:
nix profile add .
```

The package includes the desktop client, server, bundled web client, and resource
monitor. Git is supplied; provider CLIs and optional integrations must be available
on your PATH. Builds use the local source, so changes appear after rebuilding.
Add new source files to Git before building, because Git flakes omit untracked files.

Packages are defined for `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and
`aarch64-darwin`. Build another system using a native remote builder or configured
Linux emulation, for example:

```sh
nix build .#packages.aarch64-linux.default
```

This requests a build on that system. It does not cross-compile the application.
Intel macOS uses the separately pinned `nixpkgs-26.05-darwin` input because
nixpkgs unstable no longer supports that architecture.
Linux native modules, including node-pty, require a build environment that can run
the target architecture. macOS packages require a Darwin builder.

## Overlay

Add this checkout or your fork as a flake input, then enable its overlay:

```nix
{
  inputs.t3code.url = "path:/home/sirati/devel/ts/t3-code";

  outputs = { nixpkgs, t3code, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      modules = [
        ({ pkgs, ... }: {
          nixpkgs.overlays = [ t3code.overlays.default ];
          environment.systemPackages = [ pkgs.t3code ];
        })
      ];
    };
  };
}
```

The same overlay works with `import nixpkgs { overlays = [ t3code.overlays.default ]; }`
on non-NixOS systems and with Home Manager's `home.packages`. The overlay builds
the source belonging to its input, with the consumer's nixpkgs. Use the pinned
flake packages when you need exactly the dependency versions tested here.

## Release artifacts and cross-builds

Release apps run upstream's packaging pipeline from the current checkout. They
download packaging tools, Rust targets, Microsoft SDK files for Windows, and npm
dependencies. They are networked build commands, not sandboxed `nix build`
derivations. Output goes to upstream's release directory unless `--output-dir`
is supplied. Signing is off by default; upstream signing options still apply.

- On Linux x64: `nix run .#release-linux-x64` produces AppImage and deb artifacts.
- On Linux ARM64: `nix run .#release-linux-arm64` produces AppImage and deb artifacts.
- On macOS: `nix run .#release-mac-arm64`, `.#release-mac-x64`, or
  `.#release-mac-universal` produces DMG and zip artifacts. Cross-building between
  macOS architectures requires Xcode command-line tools and the Apple SDK.
- On Linux x64: `nix run .#release-win-x64 -- --wsl-runtime /path/to/t3-VERSION-linux-x64.tar.gz`
  or `.#release-win-arm64` with the matching ARM64 Linux archive produces an NSIS
  installer. The version of the Linux CLI archive must match `--build-version`.
  These commands build the Windows MSVC resource monitor with cargo-xwin before
  invoking Electron Builder through Wine. See [release procedures](release.md)
  for generating the bundled Linux CLI archive and checking Windows artifacts.

The commands reject incompatible build hosts. Native Nix packages and release
artifacts have different runtime linking requirements. A NixOS-linked Linux build
is not a portable distribution for ordinary Linux systems. Use upstream's Linux
release environment when distributing AppImages or debs outside Nix.

Nix does not run natively on Windows. Windows output is produced by the Linux
cross-build commands. The Android and iOS clients retain their existing
[mobile build workflow](../../apps/mobile/README.md); this flake packages the
desktop/server application.

## Dependency updates

`flake.lock` pins nixpkgs. `pnpm-lock.yaml` and the fixed-output dependency hash
in `nix/package.nix` pin JavaScript dependencies. After changing the pnpm lock,
set the hash to `lib.fakeHash`, run `nix build .#t3code.pnpmDeps`, and copy the
reported actual hash into the expression. The dependency fetcher includes all
platform variants so one hash can be used on all four systems.

When bumping Node, pnpm, or Electron, refresh the checksums in `nix/tools.nix`,
`nix/pnpm-sources.json`, and `nix/electron.nix` from their official downloads.
Run `nix flake check` on native builders for each supported Nix system.

## NixOS and Home Manager services

The flake exports `nixosModules.default` and `homeManagerModules.default`. Import
one and opt in with `services.t3code.enable = true`. For example, in NixOS:

```nix
{
  imports = [ inputs.t3code.nixosModules.default ];
  services.t3code = {
    enable = true;
    user = "alice"; # NixOS-managed, non-root account
    workingDirectory = "/home/alice";
    pathPackages = with pkgs; [ git ]; # add provider CLIs here
  };
}
```

For Home Manager, this example keeps an existing `~/.t3` data directory and
uses Tailscale Serve:

```nix
{ config, pkgs, inputs, ... }: {
  imports = [ inputs.t3code.homeManagerModules.default ];
  services.t3code = {
    enable = true;
    stateDirectory = "${config.home.homeDirectory}/.t3";
    pathPackages = with pkgs; [ git tailscale ]; # add provider CLIs
    extraArgs = [ "--tailscale-serve" ];
  };
}
```

Both modules accept `package`, `stateDirectory`, `workingDirectory`,
`pathPackages`, `environment`, `environmentFiles`, and `extraArgs`. For example, `extraArgs = [ "--host"
"127.0.0.1" "--port" "3000" ];` configures the listener. Tailscale Serve is
optional: add `--tailscale-serve` to `extraArgs` and Tailscale to `pathPackages`
when the host is configured to support it. Provider programs, credentials,
network exposure and firewall rules remain the host administrator's responsibility.
Avoid putting secrets in `environment`, since Nix-generated files are readable
in the store; use `environmentFiles = [ "/run/secrets/t3code.env" ];` for
a host-provisioned systemd environment file readable by the service.

The system service creates `/var/lib/t3code` by default. If `stateDirectory` is
changed, create that directory with suitable ownership before starting the service.
The working directory defaults to the state directory. The account must be
declared in `users.users` and have a nonzero UID. Systemd uses its primary
group unless `group` is set explicitly.
The account must be able to access its projects and provider credentials. The
Home Manager service defaults to `~/.local/share/t3code` and starts with the
user's systemd manager; enable lingering if it must run without a login. Both
services use `t3 serve`, which does not open a browser. Choose only one service
for a given data directory and listener.

Manage these services through Nix and `systemctl` (or `systemctl --user`).
Do not use `t3 service install` or `t3 update` to manage the Nix-provided unit;
update the flake input and rebuild the configuration instead.

## Dictation broker

The desktop client uses `sirati/dictation-api` through a pinned GitHub dependency. The flake locks the same revision for its native addon. Update both `inputs.dictation-api` and the revision in `apps/desktop/package.json` together, then regenerate `pnpm-lock.yaml` and the dependency hash in `nix/package.nix`.

To run the broker declaratively in Home Manager:

```nix
{
  imports = [ inputs.dictation-api.homeManagerModules.default ];
  services.dictation-api.enable = true;
}
```

Add `inputs.dictation-api.url = "github:sirati/dictation-api"` to the configuration's flake and pass `inputs` through `extraSpecialArgs`. NixOS can instead import `inputs.dictation-api.nixosModules.default`, which also creates a user service. Both start the broker with the graphical session. Do not also use the broker's imperative service installer.

T3 captures the original input and selection when it accepts dictation. Delivery follows that input after focus changes. If the original editor has been unmounted, T3 reports failure to the dictation provider, so a transcript cannot land in a different conversation.
