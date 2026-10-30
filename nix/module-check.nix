{
  self,
  nixpkgs,
  pkgs,
}:
let
  lib = pkgs.lib;
  systemConfig =
    extra:
    (nixpkgs.lib.nixosSystem {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        self.nixosModules.default
        { system.stateVersion = "25.11"; }
        extra
      ];
    }).config;
  homeConfig =
    extra:
    (lib.evalModules {
      modules = [
        self.homeManagerModules.default
        {
          config._module.args.pkgs = pkgs;
          options.home.homeDirectory = lib.mkOption {
            type = lib.types.str;
            default = "/home/alice";
          };
          options.systemd.user.services = lib.mkOption {
            type = lib.types.attrs;
            default = { };
          };
        }
        extra
      ];
    }).config;
  system = systemConfig {
    users.users.alice = {
      isNormalUser = true;
      group = "users";
    };
    services.t3code = {
      enable = true;
      user = "alice";
      stateDirectory = "/srv/t3 state";
      environment.EXAMPLE = "space \"quote\" \\ $VAR %h";
      environmentFiles = [ "/run/secrets/t3 env" ];
      extraArgs = [
        "--port"
        "8080"
        "space \"quote\" \\ $VAR %h"
      ];
    };
  };
  home = homeConfig {
    services.t3code = {
      enable = true;
      environment.EXAMPLE = "space \"quote\" \\ $VAR %h";
      environmentFiles = [ "/run/secrets/t3 env" ];
      extraArgs = [
        "--host"
        "127.0.0.1"
        "space \"quote\" \\ $VAR %h"
      ];
    };
  };
  disabledSystem = systemConfig { };
  disabledHome = homeConfig { };
  invalidUid = systemConfig {
    users.users.alias = {
      isSystemUser = true;
      uid = 0;
      group = "root";
    };
    services.t3code = {
      enable = true;
      user = "alias";
    };
  };
  invalidNumeric = systemConfig {
    services.t3code = {
      enable = true;
      user = "0";
    };
  };
  invalid = systemConfig {
    services.t3code = {
      enable = true;
      user = "root";
    };
  };
in
assert !(disabledSystem.systemd.services ? t3code);
assert !(disabledHome.systemd.user.services ? t3code);
assert system.systemd.services.t3code.serviceConfig.User == "alice";
assert !(system.systemd.services.t3code.serviceConfig ? Group);
assert system.systemd.services.t3code.serviceConfig.WorkingDirectory == "/srv/t3 state";
assert lib.hasInfix (builtins.toJSON "space \"quote\" \\ $$VAR %%h")
  system.systemd.services.t3code.serviceConfig.ExecStart;
assert builtins.elem (builtins.toJSON "EXAMPLE=space \"quote\" \\ $VAR %%h")
  system.systemd.services.t3code.serviceConfig.Environment;
assert lib.hasInfix (builtins.toJSON "space \"quote\" \\ $$VAR %%h")
  home.systemd.user.services.t3code.Service.ExecStart;
assert builtins.elem (builtins.toJSON "EXAMPLE=space \"quote\" \\ $VAR %%h")
  home.systemd.user.services.t3code.Service.Environment;
assert
  home.systemd.user.services.t3code.Service.EnvironmentFile
  == [ (builtins.toJSON "/run/secrets/t3 env") ];
assert !(lib.all (x: x.assertion) invalidUid.assertions);
assert !(lib.all (x: x.assertion) invalidNumeric.assertions);
assert !(lib.all (x: x.assertion) invalid.assertions);
pkgs.runCommand "t3code-module-evaluation" { } "touch $out"
