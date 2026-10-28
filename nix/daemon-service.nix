{
  lib,
  pkgs,
  cfg,
}:
let
  backend = "${cfg.stateDirectory}/runtime/daemon-entry";
  prepare = pkgs.writeShellScript "t3code-daemon-entry" ''
    set -eu
    ${pkgs.coreutils}/bin/mkdir -p -- ${lib.escapeShellArg "${cfg.stateDirectory}/runtime"}
    ${pkgs.coreutils}/bin/ln -sfn -- ${lib.escapeShellArg "${cfg.package}/bin/t3"} ${lib.escapeShellArg "${backend}.next"}
    ${pkgs.coreutils}/bin/mv -Tf -- ${lib.escapeShellArg "${backend}.next"} ${lib.escapeShellArg backend}
  '';
  reload = pkgs.writeShellScript "t3code-daemon-reload" ''
    set -eu
    ${prepare}
    exec ${
      lib.escapeShellArgs [
        "${cfg.package}/bin/t3"
        "daemon"
        "reload"
        "--base-dir"
        cfg.stateDirectory
      ]
    }
  '';
in
{
  args =
    (
      if cfg.seamlessReload then
        [
          "daemon"
          "run"
          "--backend-command"
          backend
        ]
      else
        [ "serve" ]
    )
    ++ [
      "--base-dir"
      cfg.stateDirectory
    ]
    ++ cfg.extraArgs;
  inherit prepare reload;
}
