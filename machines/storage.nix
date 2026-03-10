{ pkgs, lib, config, overseer, ... }:

let
  giteaConfig = pkgs.writeText "app.ini" ''
    [server]
    HTTP_PORT = 3000
    ROOT_URL = http://gitea.spark.local/

    [database]
    DB_TYPE = sqlite3
    PATH = /var/lib/gitea/data/gitea.db
  '';
in {
  config = {
    system-manager.allowAnyDistro = true;
    nixpkgs.hostPlatform = "x86_64-linux";

    environment.systemPackages = [ pkgs.git ];

    # ── Gitea ──
    systemd.services.gitea = {
      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.gitea}/bin/gitea web --config /etc/homie/gitea/app.ini";
        Restart = "on-failure";
        RestartSec = "5";
        User = "gitea";
        Group = "gitea";
        StateDirectory = "gitea";
        WorkingDirectory = "/var/lib/gitea";
      };
      after = [ "network.target" ];
      wantedBy = [ "system-manager.target" ];
    };

    # ── Overseer ──
    systemd.services.homie-overseer = {
      serviceConfig = {
        Type = "simple";
        ExecStart = "${overseer}/bin/homie-overseer --machine storage --repo /var/lib/homie/repo --services gitea";
        Restart = "on-failure";
        RestartSec = "5";
      };
      after = [ "network.target" ];
      wantedBy = [ "system-manager.target" ];
    };

    environment.etc."homie/gitea/app.ini".source = giteaConfig;

    systemd.tmpfiles.rules = [
      "d /var/lib/gitea 0755 gitea gitea -"
      "d /var/lib/gitea/data 0755 gitea gitea -"
    ];
  };
}
