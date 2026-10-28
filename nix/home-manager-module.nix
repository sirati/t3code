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
    stateDirectory = mkOption {
      type = types.str;
      default = "${config.home.homeDirectory}/.local/share/t3code";
    };
    workingDirectory = mkOption {
      type = types.str;
      default = config.home.homeDirectory;
    };
    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
    };
    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
    };
    environmentFiles = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Absolute paths to systemd environment files, kept outside the Nix store.";
    };
    pathPackages = mkOption {
      type = types.listOf types.package;
      default = with pkgs; [ git ];
    };
  };
  config = mkIf cfg.enable {
    systemd.user.services.t3code = {
      Unit = {
        Description = "T3 Code server";
        After = [ "network-online.target" ];
        Wants = [ "network-online.target" ];
      }
      // lib.optionalAttrs cfg.seamlessReload { X-SwitchMethod = "reload"; };
      Install.WantedBy = [ "default.target" ];
      Service = {
        ExecStart = lib.concatMapStringsSep " " escapeExec ([ "${cfg.package}/bin/t3" ] ++ daemon.args);
        KillMode = "mixed";
        TimeoutStartSec = "35min";
        TimeoutStopSec = "90s";
        WorkingDirectory = lib.replaceStrings [ "%" ] [ "%%" ] cfg.workingDirectory;
        Restart = "on-failure";
        RestartSec = 5;
        Environment = lib.mapAttrsToList (name: value: escapeEnvironment "${name}=${value}") env;
        EnvironmentFile = map escapeEnvironment cfg.environmentFiles;
      }
      // lib.optionalAttrs cfg.seamlessReload {
        ExecStartPre = [ (escapeExec "${daemon.prepare}") ];
        ExecReload = escapeExec "${daemon.reload}";
      };
    };
  };
}
