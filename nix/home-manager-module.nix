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
  args = [
    "serve"
    "--base-dir"
    cfg.stateDirectory
  ]
  ++ cfg.extraArgs;
  escapeExec = value: lib.replaceStrings [ "%" "$" ] [ "%%" "$$" ] (builtins.toJSON value);
  escapeEnvironment = value: lib.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON value);
  env =
    cfg.environment
    // {
      PATH = lib.makeBinPath cfg.pathPackages;
    }
    // lib.optionalAttrs cfg.keepActiveSessions { T3CODE_KEEP_SESSIONS = "1"; };
in
{
  options.services.t3code = {
    enable = mkEnableOption "the T3 Code headless server";
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
    keepActiveSessions = mkEnableOption "keeping agent sessions with work in flight running across service restarts";
  };
  config = mkIf cfg.enable {
    systemd.user.services.t3code = {
      Unit = {
        Description = "T3 Code server";
        After = [ "network-online.target" ];
        Wants = [ "network-online.target" ];
      };
      Install.WantedBy = [ "default.target" ];
      Service = {
        ExecStart = lib.concatMapStringsSep " " escapeExec ([ "${cfg.package}/bin/t3" ] ++ args);
        WorkingDirectory = lib.replaceStrings [ "%" ] [ "%%" ] cfg.workingDirectory;
        Restart = "on-failure";
        RestartSec = 5;
        Environment = lib.mapAttrsToList (name: value: escapeEnvironment "${name}=${value}") env;
        EnvironmentFile = map escapeEnvironment cfg.environmentFiles;
      }
      // lib.optionalAttrs cfg.keepActiveSessions {
        # Only the server may get the stop signal: it detaches busy sessions before anything else ends.
        KillMode = "mixed";
      };
    };
  };
}
