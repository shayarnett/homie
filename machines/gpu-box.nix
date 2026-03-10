{ pkgs, lib, config, overseer, ... }:

{
  config = {
    system-manager.allowAnyDistro = true;
    nixpkgs.hostPlatform = "x86_64-linux";

    environment.systemPackages = [ pkgs.git ];

    # ── vLLM (native, fast inference on RTX 4080) ──
    systemd.services.vllm = {
      serviceConfig = {
        Type = "simple";
        ExecStart = builtins.concatStringsSep " " [
          "${pkgs.vllm}/bin/vllm" "serve" "Qwen/Qwen3-8B"
          "--port" "8888"
          "--gpu-memory-utilization" "0.8"
          "--enable-auto-tool-choice"
          "--tool-call-parser" "hermes"
          "--enable-prefix-caching"
        ];
        Restart = "on-failure";
        RestartSec = "10";
        StateDirectory = "vllm";
      };
      environment = {
        HOME = "/var/lib/vllm";
      };
      after = [ "network.target" ];
      wantedBy = [ "system-manager.target" ];
    };

    # ── Overseer ──
    systemd.services.homie-overseer = {
      serviceConfig = {
        Type = "simple";
        ExecStart = "${overseer}/bin/homie-overseer --machine gpu-box --repo /var/lib/homie/repo --services vllm";
        Restart = "on-failure";
        RestartSec = "5";
      };
      after = [ "network.target" ];
      wantedBy = [ "system-manager.target" ];
    };

    systemd.tmpfiles.rules = [
      "d /var/lib/vllm 0755 root root -"
    ];
  };
}
