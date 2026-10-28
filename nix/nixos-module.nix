{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.t3code;
  inherit (lib)
    mkEnableOption
    mkOption
    types
    mkIf
    ;
  daemon = import ./daemon-service.nix { inherit lib pkgs cfg; };
  escapeExec = value: lib.replaceStrings [ "%" "$" ] [ "%%" "$$" ] (builtins.toJSON value);
  escapeEnvironment = value: lib.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON value);
  env = cfg.environment // {
    PATH = lib.makeBinPath cfg.pathPackages;
  };
in
{
  options.services.t3code = {
    enable = mkEnableOption "the T3 Code headless server";
    seamlessReload = mkOption {
      type = types.bool;
      default = true;
      description = "Retain provider processes while replacing the backend on service reload. Environment or listener changes require a full restart.";
    };
    package = mkOption {
      type = types.package;
      default = pkgs.t3code;
      defaultText = lib.literalExpression "pkgs.t3code";
    };
    user = mkOption {
      type = types.str;
      description = "Existing unprivileged account to run the server.";
    };
    group = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Optional group override; by default systemd uses the account primary group.";
    };
    stateDirectory = mkOption {
      type = types.str;
      default = "/var/lib/t3code";
      description = "Writable T3 Code data directory.";
    };
    workingDirectory = mkOption {
      type = types.str;
      default = cfg.stateDirectory;
    };
    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Additional arguments appended to the headless backend command.";
    };
    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Additional environment variables for the service.";
    };
    environmentFiles = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Absolute paths to systemd environment files, kept outside the Nix store.";
    };
    pathPackages = mkOption {
      type = types.listOf types.package;
      default = with pkgs; [ git ];
      description = "Executables providers and projects may need on PATH.";
    };
  };
  config = mkIf cfg.enable {
    assertions = [
      {
        assertion =
          cfg.user != ""
          && cfg.user != "root"
          && builtins.match "[0-9]+" cfg.user == null
          && builtins.hasAttr cfg.user config.users.users
          && config.users.users.${cfg.user}.uid != 0;
        message = "services.t3code.user must name a NixOS-managed non-root account with a nonzero UID";
      }
    ];
    systemd.services.t3code = {
      description = "T3 Code server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      reloadIfChanged = cfg.seamlessReload;
      serviceConfig = {
        ExecStart = lib.concatMapStringsSep " " escapeExec ([ "${cfg.package}/bin/t3" ] ++ daemon.args);
        KillMode = "mixed";
        TimeoutStartSec = "35min";
        TimeoutStopSec = "90s";
        User = cfg.user;
        WorkingDirectory = lib.replaceStrings [ "%" ] [ "%%" ] cfg.workingDirectory;
        StateDirectory = lib.mkIf (cfg.stateDirectory == "/var/lib/t3code") "t3code";
        Environment = lib.mapAttrsToList (name: value: escapeEnvironment "${name}=${value}") env;
        EnvironmentFile = map escapeEnvironment cfg.environmentFiles;
        Restart = "on-failure";
        RestartSec = 5;
      }
      // lib.optionalAttrs cfg.seamlessReload {
        ExecStartPre = [ (escapeExec "${daemon.prepare}") ];
        ExecReload = escapeExec "${daemon.reload}";
      }
      // lib.optionalAttrs (cfg.group != null) { Group = cfg.group; };
    };
  };
}
