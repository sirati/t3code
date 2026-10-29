{
  description = "T3 Code development and source builds";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.nixpkgs-darwin-intel.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin-intel,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import (if system == "x86_64-darwin" then nixpkgs-darwin-intel else nixpkgs) {
          inherit system;
          overlays = [ self.overlays.default ];
        };
    in
    {
      nixosModules.default = { lib, pkgs, ... }: {
        imports = [ ./nix/nixos-module.nix ];
        services.t3code.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      };
      homeManagerModules.default = { lib, pkgs, ... }: {
        imports = [ ./nix/home-manager-module.nix ];
        services.t3code.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      };

      overlays.default =
        final: prev:
        let
          tools = import ./nix/tools.nix { pkgs = prev; };
          src = prev.lib.cleanSourceWith {
            src = self;
            filter =
              path: type:
              let
                name = baseNameOf path;
              in
              !(builtins.elem name [
                ".git"
                ".repos"
                ".t3"
                "node_modules"
                "result"
              ])
              && prev.lib.cleanSourceFilter path type;
          };
        in
        {
          t3code-nodejs = tools.nodejs;
          t3code-pnpm = tools.pnpm;
          t3code-electron = prev.callPackage ./nix/electron.nix { };
          t3code-resource-monitor = final.callPackage ./nix/resource-monitor.nix { inherit src; };
          t3code = final.callPackage ./nix/package.nix { inherit src; };
        };

      packages = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.t3code;
          t3code = pkgs.t3code;
          resource-monitor = pkgs.t3code-resource-monitor;
        }
      );

      devShells = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = import ./nix/shell.nix { inherit pkgs; };
        }
      );

      apps = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = {
            type = "app";
            program = "${pkgs.t3code}/bin/t3code-desktop";
          };
          server = {
            type = "app";
            program = "${pkgs.t3code}/bin/t3";
          };
        }
        // import ./nix/release.nix { inherit pkgs; }
      );

      checks = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          inherit (self.packages.${system}) t3code resource-monitor;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          modules = import ./nix/module-check.nix { inherit self nixpkgs pkgs; };
        }
      );

      formatter = eachSystem (system: (pkgsFor system).nixfmt);
    };
}
