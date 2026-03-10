{ pkgs, lib, config, overseer, agentsview, ... }:

let
  # ── Machine config ──
  user = "shay";
  hostname = "spark";
  domain = "${hostname}.local";
  hostIp = "192.168.1.95";
  homeDir = "/home/${user}";
  repoDir = "${homeDir}/homie";

  # ── Port assignments (Nixie: check this before adding services) ──
  ports = {
    llama = 8000;       # llama-server: Qwen3.5-9B (all agents)
    homie = 3456;       # Homie web chat UI
    gitea = 3000;       # Gitea git hosting
    overseer = 9100;    # Overseer webhook listener
    agentsview = 8085;  # AgentsView session browser
    dashy = 8086;       # Dashy dashboard
    vaultwarden = 8222;  # Vaultwarden password manager
  };

in {
  config = {
    system-manager.allowAnyDistro = true;
    nixpkgs.hostPlatform = "aarch64-linux";

    environment.systemPackages = [ pkgs.git pkgs.nodejs_22 pkgs.tmux ];

    # ── Sudoers rule for system-manager (migrated from bootstrap.sh) ──
    environment.etc."sudoers.d/homie" = {
      text = "${user} ALL=(root) NOPASSWD: /nix/store/*/bin/system-manager-engine, /usr/bin/systemctl restart *\n";
      mode = "0440";
    };

    # ── nginx (reverse proxy for all services) ──
    services.nginx = {
      enable = true;
      recommendedProxySettings = true;
      virtualHosts."chat.${domain}" = {
        locations."/".proxyPass = "http://127.0.0.1:${toString ports.homie}";
        locations."/".extraConfig = ''
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
        '';
      };
      virtualHosts."gitea.${domain}" = {
        locations."/".proxyPass = "http://127.0.0.1:${toString ports.gitea}";
      };
virtualHosts."pihole.${domain}" = {
        locations."/".return = "302 /admin/";
        locations."/admin".proxyPass = "http://127.0.0.1:8081";
      };
      virtualHosts."agents.${domain}" = {
        locations."/".proxyPass = "http://127.0.0.1:${toString ports.agentsview}";
      };
      virtualHosts."dashy.${domain}" = {
        locations."/".proxyPass = "http://127.0.0.1:${toString ports.dashy}";
      };
      virtualHosts."vault.${domain}" = {
        locations."/".proxyPass = "http://127.0.0.1:${toString ports.vaultwarden}";
        locations."/notifications/hub" = {
          proxyPass = "http://127.0.0.1:${toString ports.vaultwarden}";
          extraConfig = ''
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
          '';
        };
      };
      # Catch-all: return 444 for unknown subdomains instead of falling through
      virtualHosts."_" = {
        default = true;
        locations."/".return = "444";
      };
    };

    # ── Model download (oneshot: fetch GGUF if missing) ──
    systemd.services.llama-model =
      let
        modelPath = "${homeDir}/models/Qwen3.5-9B-Q4_K_M.gguf";
        downloadModel = pkgs.writeShellScript "llama-download-model" ''
          if [ -f "${modelPath}" ]; then
            echo "Model already exists: ${modelPath}"
            exit 0
          fi
          mkdir -p ${homeDir}/models
          echo "Downloading Qwen3.5-9B-Q4_K_M.gguf..."
          ${pkgs.python3.withPackages (p: [p.huggingface-hub])}/bin/python3 -c "
          from huggingface_hub import hf_hub_download
          hf_hub_download('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf', local_dir='${homeDir}/models')
          "
          echo "Model download complete"
        '';
      in {
        serviceConfig = {
          Type = "oneshot";
          ExecStart = downloadModel;
          User = user;
          RemainAfterExit = true;
        };
        after = [ "network.target" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── llama-server: Qwen3.5-9B (all agents) ──
    systemd.services.llama =
      let
        modelPath = "${homeDir}/models/Qwen3.5-9B-Q4_K_M.gguf";
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = "/usr/local/bin/llama-server --model ${modelPath} -ngl 99 -c 32768 -np 1 --port ${toString ports.llama} --host 0.0.0.0";
          Restart = "on-failure";
          RestartSec = "10";
          User = user;
        };
        after = [ "network.target" "llama-model.service" ];
        requires = [ "llama-model.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Homie (web chat UI) ──
    systemd.services.homie =
      let
        homieDir = "${repoDir}/homie";
        buildScript = pkgs.writeShellScript "homie-build" ''
          export PATH="${pkgs.nodejs_22}/bin:/usr/bin:$PATH"
          export HOME="${homeDir}"
          cd ${homieDir}
          npm install --production=false 2>&1
          npx tsc -p tsconfig.build.json 2>&1
        '';
        startScript = pkgs.writeShellScript "homie-start" ''
          export PATH="${pkgs.nodejs_22}/bin:/usr/bin:/usr/local/bin:/usr/sbin:$PATH"
          export HOME="${homeDir}"
          export NODE_ENV="production"
          exec ${pkgs.nodejs_22}/bin/node ${homieDir}/dist/main.js --server --host=0.0.0.0 --port=${toString ports.homie}
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStartPre = buildScript;
          ExecStart = startScript;
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
          WorkingDirectory = repoDir;
        };
        after = [ "network.target" "llama.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Gitea (git hosting for declarative deploys) ──
    systemd.services.gitea =
      let
        giteaStart = pkgs.writeShellScript "gitea-start" ''
          export PATH="/usr/bin:/usr/local/bin:$PATH"
          # Generate app.ini on first run if missing
          mkdir -p /var/lib/gitea/custom/conf
          if [ ! -f /var/lib/gitea/custom/conf/app.ini ]; then
            cat > /var/lib/gitea/custom/conf/app.ini <<'CONF'
          APP_DATA_PATH = /var/lib/gitea/data

          [server]
          HTTP_PORT = ${toString ports.gitea}
          ROOT_URL = http://gitea.${domain}/
          DOMAIN = gitea.${domain}

          [database]
          DB_TYPE = sqlite3
          PATH = /var/lib/gitea/data/gitea.db

          [security]
          INSTALL_LOCK = true

          [service]
          DISABLE_REGISTRATION = true

          [repository]
          ROOT = /var/lib/gitea/repos
          DEFAULT_BRANCH = main

          [git]
          HOME_PATH = /var/lib/gitea/git

          [log]
          ROOT_PATH = /var/lib/gitea/log

          [webhook]
          ALLOWED_HOST_LIST = loopback

          [actions]
          ENABLED = true
          DEFAULT_ACTIONS_URL = github
          CONF
          mkdir -p /var/lib/gitea/{data,repos,git,log}
          fi
          # Ensure Actions are enabled on existing installs
          if ! grep -q '^\[actions\]' /var/lib/gitea/custom/conf/app.ini; then
            printf '\n[actions]\nENABLED = true\nDEFAULT_ACTIONS_URL = github\n' >> /var/lib/gitea/custom/conf/app.ini
          fi
          export GITEA_WORK_DIR=/var/lib/gitea
          export GITEA_CUSTOM=/var/lib/gitea/custom
          export HOME=/var/lib/gitea
          exec ${pkgs.gitea}/bin/gitea web --work-path /var/lib/gitea --config /var/lib/gitea/custom/conf/app.ini
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = giteaStart;
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
          StateDirectory = "gitea";
          WorkingDirectory = "/var/lib/gitea";
        };
        after = [ "network.target" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Gitea Init (one-shot: create admin, token, org, repo) ──
    systemd.services.gitea-init =
      let
        giteaBin = "${pkgs.gitea}/bin/gitea";
        giteaInit = pkgs.writeShellScript "gitea-init" ''
          export PATH="/usr/bin:/usr/local/bin:$PATH"
          export GITEA_WORK_DIR=/var/lib/gitea
          export GITEA_CUSTOM=/var/lib/gitea/custom
          export HOME=/var/lib/gitea
          CONF=/var/lib/gitea/custom/conf/app.ini
          TOKEN_FILE=/var/lib/homie-overseer/gitea-token

          # Wait for Gitea API to be ready
          for i in $(seq 1 30); do
            /usr/bin/curl -sf http://localhost:${toString ports.gitea}/api/v1/version >/dev/null 2>&1 && break
            sleep 2
          done

          # Create admin user if none exists (generate random password on first run)
          GITEA_PASS_FILE=/var/lib/gitea/admin-password
          if ! ${giteaBin} admin user list --admin --config "$CONF" 2>/dev/null | grep -q "homie-admin"; then
            GITEA_PASS=$(${pkgs.openssl}/bin/openssl rand -base64 24)
            echo "$GITEA_PASS" > "$GITEA_PASS_FILE"
            chmod 600 "$GITEA_PASS_FILE"
            ${giteaBin} admin user create \
              --admin --username homie-admin --password "$GITEA_PASS" \
              --email admin@${domain} --must-change-password=false \
              --config "$CONF" 2>&1 || true
            echo "Gitea admin password saved to $GITEA_PASS_FILE"
          fi

          # Generate API token if not already saved
          if [ ! -s "$TOKEN_FILE" ]; then
            TOKEN=$(${giteaBin} admin user generate-access-token \
              --username homie-admin --token-name overseer --scopes all \
              --raw --config "$CONF" 2>/dev/null)
            if [ -n "$TOKEN" ]; then
              echo "$TOKEN" > "$TOKEN_FILE"
              echo "Generated API token"
            fi
          fi

          TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || echo "")
          if [ -z "$TOKEN" ]; then
            echo "Failed to get API token"
            exit 1
          fi

          # Validate token works (stale token from previous DB = silent failures)
          if ! /usr/bin/curl -sf -H "Authorization: token $TOKEN" \
            "http://localhost:${toString ports.gitea}/api/v1/user" >/dev/null 2>&1; then
            echo "Saved token is stale, regenerating..."
            rm -f "$TOKEN_FILE"
            TOKEN=$(${giteaBin} admin user generate-access-token \
              --username homie-admin --token-name "overseer-$(date +%s)" --scopes all \
              --raw --config "$CONF" 2>/dev/null)
            if [ -n "$TOKEN" ]; then
              echo "$TOKEN" > "$TOKEN_FILE"
              echo "Regenerated API token"
            else
              echo "Failed to regenerate API token"
              exit 1
            fi
          fi

          API="http://localhost:${toString ports.gitea}/api/v1"
          AUTH="Authorization: token $TOKEN"

          # Create org if missing
          /usr/bin/curl -sf -H "$AUTH" "$API/orgs/homie" >/dev/null 2>&1 || \
            /usr/bin/curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
              -d '{"username":"homie","visibility":"public"}' "$API/orgs" >/dev/null

          # Create repo if missing
          /usr/bin/curl -sf -H "$AUTH" "$API/repos/homie/infra" >/dev/null 2>&1 || \
            /usr/bin/curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
              -d '{"name":"infra","default_branch":"main","auto_init":false}' \
              "$API/orgs/homie/repos" >/dev/null

          # Generate ~/.homie/config.yaml if missing
          HOMIE_CONFIG="/home/${user}/.homie/config.yaml"
          if [ ! -f "$HOMIE_CONFIG" ]; then
            mkdir -p "/home/${user}/.homie"
            cat > "$HOMIE_CONFIG" <<YAML
          lab:
            name: ${hostname}-homelab
            domain: ${domain}
            repo_dir: ${repoDir}
            hosts:
            - name: ${hostname}
              address: ${hostIp}
              ssh_user: ${user}
              gpu: true
          agents:
            homie:
              model: openai-compatible/qwen3.5-9b
              endpoint: http://localhost:${toString ports.llama}/v1
            nixie:
              model: openai-compatible/qwen3.5-9b
              endpoint: http://localhost:${toString ports.llama}/v1
            termie:
              model: openai-compatible/qwen3.5-9b
              endpoint: http://localhost:${toString ports.llama}/v1
            doxie:
              model: openai-compatible/qwen3.5-9b
              endpoint: http://localhost:${toString ports.llama}/v1
            jinxie:
              model: openai-compatible/qwen3.5-9b
              endpoint: http://localhost:${toString ports.llama}/v1
          services:
            lxd:
              remote: local
            docker:
              host: unix:///var/run/docker.sock
          proxy:
            routes:
            - subdomain: chat
              port: ${toString ports.homie}
            - subdomain: gitea
              port: ${toString ports.gitea}
            - subdomain: pihole
              port: 8081
            - subdomain: agents
              port: ${toString ports.agentsview}
            - subdomain: vault
              port: ${toString ports.vaultwarden}
          data_dir: ~/.homie
          gitea:
            url: http://localhost:${toString ports.gitea}
            token: $TOKEN
            org: homie
            repo: infra
          YAML
          fi

          # Register act-runner if not already registered
          if [ ! -f /var/lib/act-runner/.runner ]; then
            REG_TOKEN=$(/usr/bin/curl -sf -X GET -H "$AUTH" \
              "$API/orgs/homie/actions/runners/registration-token" 2>/dev/null \
              | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
            if [ -n "$REG_TOKEN" ]; then
              cd /var/lib/act-runner
              ${pkgs.forgejo-runner}/bin/forgejo-runner register \
                --instance "http://localhost:${toString ports.gitea}" \
                --token "$REG_TOKEN" \
                --name spark \
                --labels "nix:host" \
                --no-interactive 2>&1
              echo "Registered act-runner"
            fi
          fi

          echo "Gitea init complete"
        '';
      in {
        serviceConfig = {
          Type = "oneshot";
          ExecStart = giteaInit;
          User = user;
          RemainAfterExit = true;
        };
        after = [ "gitea.service" ];
        requires = [ "gitea.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Overseer ──
    systemd.services.homie-overseer =
      let
        overseerStart = pkgs.writeShellScript "overseer-start" ''
          export PATH="/nix/var/nix/profiles/default/bin:/usr/bin:/usr/local/bin:/usr/sbin:${pkgs.git}/bin:$PATH"
          GITEA_TOKEN=""
          if [ -f /var/lib/homie-overseer/gitea-token ]; then
            GITEA_TOKEN="--gitea-token $(cat /var/lib/homie-overseer/gitea-token)"
          fi
          exec ${overseer}/bin/homie-overseer \
            --machine ${hostname} \
            --port ${toString ports.overseer} \
            --repo ${repoDir} \
            --gitea-url http://localhost:${toString ports.gitea} \
            --gitea-org homie \
            --gitea-repo infra \
            --services llama homie gitea vaultwarden \
            --homie-port ${toString ports.homie} \
            $GITEA_TOKEN
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = overseerStart;
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
        };
        after = [ "network.target" "gitea-init.service" ];
        requires = [ "gitea-init.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Gitea Actions Runner (CI checks on PRs) ──
    # Runs `nix flake check` on PR branches before merge.
    # One-time setup: register the runner via Gitea admin UI, then run:
    #   cd /var/lib/act-runner && forgejo-runner register \
    #     --instance http://localhost:${toString ports.gitea} \
    #     --token <TOKEN> --name spark --labels nix:host --no-interactive
    systemd.services.act-runner =
      let
        runnerConfig = pkgs.writeText "act-runner-config.yaml" ''
          log:
            level: info
          runner:
            file: /var/lib/act-runner/.runner
            capacity: 1
            timeout: 30m
            labels:
              - "nix:host"
          cache:
            enabled: false
          host:
            workdir_parent: /tmp/act-runner
        '';
        runnerStart = pkgs.writeShellScript "act-runner-start" ''
          export PATH="${pkgs.nodejs_22}/bin:${pkgs.git}/bin:/nix/var/nix/profiles/default/bin:/usr/bin:/usr/local/bin:$PATH"
          export HOME="/var/lib/act-runner"
          cd /var/lib/act-runner
          # Clean leftover workdirs from previous runs
          rm -rf /tmp/act-runner
          mkdir -p /tmp/act-runner
          exec ${pkgs.forgejo-runner}/bin/forgejo-runner daemon --config ${runnerConfig}
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = runnerStart;
          Restart = "on-failure";
          RestartSec = "10";
          User = user;
        };
        after = [ "network.target" "gitea-init.service" ];
        requires = [ "gitea-init.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Pi-hole (DNS server with web UI) ──
    # DNS on port 1053, Web UI on port 8081, using host network mode
    systemd.services.pihole =
      let
        piholeStart = pkgs.writeShellScript "pihole-start" ''
          mkdir -p /etc/dnsmasq.d /etc/pihole
          echo 'address=/${domain}/${hostIp}' > /etc/dnsmasq.d/02-homie-local.conf

          # Generate Pi-hole password on first run
          PIHOLE_PASS_FILE=/etc/pihole/admin-password
          if [ ! -f "$PIHOLE_PASS_FILE" ]; then
            ${pkgs.openssl}/bin/openssl rand -base64 24 > "$PIHOLE_PASS_FILE"
            chmod 600 "$PIHOLE_PASS_FILE"
            echo "Pi-hole admin password saved to $PIHOLE_PASS_FILE"
          fi
          PIHOLE_PASS=$(cat "$PIHOLE_PASS_FILE")

          exec /usr/bin/docker run --rm --name pihole --network host \
            -e TZ=America/New_York \
            -e WEBPASSWORD="$PIHOLE_PASS" \
            -e FTLCONF_dns_port=1053 \
            -e FTLCONF_webserver_port=8081 \
            -e FTLCONF_misc_etc_dnsmasq_d=true \
            -v /etc/pihole:/etc/pihole \
            -v /etc/dnsmasq.d:/etc/dnsmasq.d \
            pihole/pihole:latest
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = piholeStart;
          ExecStop = "/usr/bin/docker stop pihole";
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
        };
        after = [ "network.target" "docker.service" ];
        requires = [ "docker.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Vaultwarden (password manager) ──
    systemd.services.vaultwarden =
      let
        vaultwardenStart = pkgs.writeShellScript "vaultwarden-start" ''
          export ROCKET_PORT=${toString ports.vaultwarden}
          export ROCKET_ADDRESS=127.0.0.1
          export DATA_FOLDER=/var/lib/vaultwarden
          export DOMAIN=http://vault.${domain}
          export SIGNUPS_ALLOWED=true
          export INVITATIONS_ALLOWED=true
          export SHOW_PASSWORD_HINT=false
          export WEB_VAULT_ENABLED=true
          export WEB_VAULT_FOLDER=${pkgs.vaultwarden.webvault}/share/vaultwarden/vault

          # Load admin token if available (generated by vaultwarden-init)
          if [ -f /var/lib/vaultwarden/admin-token ]; then
            export ADMIN_TOKEN=$(cat /var/lib/vaultwarden/admin-token)
          fi

          exec ${pkgs.vaultwarden}/bin/vaultwarden
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = vaultwardenStart;
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
          WorkingDirectory = "/var/lib/vaultwarden";
        };
        after = [ "network.target" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Vaultwarden Init (one-shot: generate admin token, create org) ──
    systemd.services.vaultwarden-init =
      let
        vaultInit = pkgs.writeShellScript "vaultwarden-init" ''
          export PATH="/usr/bin:$PATH"
          VW_URL="http://127.0.0.1:${toString ports.vaultwarden}"
          ADMIN_TOKEN_FILE=/var/lib/vaultwarden/admin-token
          ADMIN_TOKEN_PLAIN=/var/lib/vaultwarden/admin-token-plain
          INIT_DONE=/var/lib/vaultwarden/init-done

          # Wait for vaultwarden API
          for i in $(seq 1 30); do
            /usr/bin/curl -sf "$VW_URL/alive" >/dev/null 2>&1 && break
            sleep 2
          done

          # Generate admin token on first run
          if [ ! -f "$ADMIN_TOKEN_PLAIN" ]; then
            PLAIN=$(${pkgs.openssl}/bin/openssl rand -base64 32)
            echo "$PLAIN" > "$ADMIN_TOKEN_PLAIN"
            chmod 600 "$ADMIN_TOKEN_PLAIN"

            # Vaultwarden accepts plain tokens (argon2 hashing is optional)
            echo "$PLAIN" > "$ADMIN_TOKEN_FILE"
            chmod 600 "$ADMIN_TOKEN_FILE"

            # Restart vaultwarden to pick up the admin token
            /usr/bin/sudo /usr/bin/systemctl restart vaultwarden
            for i in $(seq 1 30); do
              /usr/bin/curl -sf "$VW_URL/alive" >/dev/null 2>&1 && break
              sleep 2
            done
          fi

          ADMIN_PLAIN=$(cat "$ADMIN_TOKEN_PLAIN")

          # Invite admin user (you) via admin API
          /usr/bin/curl -sf -X POST "$VW_URL/admin/invite" \
            -H "Content-Type: application/json" \
            -H "Cookie: VW_ADMIN=$ADMIN_PLAIN" \
            -d '{"email":"admin@${domain}"}' >/dev/null 2>&1 || true

          # Invite homie service account
          /usr/bin/curl -sf -X POST "$VW_URL/admin/invite" \
            -H "Content-Type: application/json" \
            -H "Cookie: VW_ADMIN=$ADMIN_PLAIN" \
            -d '{"email":"homie@${domain}"}' >/dev/null 2>&1 || true

          if [ ! -f "$INIT_DONE" ]; then
            SETUP_FILE="${homeDir}/SETUP-VAULT.txt"
            cat > "$SETUP_FILE" <<SETUP
=== Vaultwarden Setup ===

Your password manager is running at: http://vault.${domain}

1. Open http://vault.${domain} and create your account with: admin@${domain}
2. Open http://vault.${domain}/admin and log in with this token:

   $(cat "$ADMIN_TOKEN_PLAIN")

3. Create an organization called "homie-infra"
4. Register a second account: homie@${domain} (this is the service account)
5. Invite homie@${domain} to the homie-infra organization
6. In the admin panel, disable open signups

Gitea admin password: $(cat /var/lib/gitea/admin-password 2>/dev/null || echo "(check /var/lib/gitea/admin-password)")
Pi-hole admin password: $(cat /etc/pihole/admin-password 2>/dev/null || echo "(check /etc/pihole/admin-password)")

Delete this file when done: rm ~/SETUP-VAULT.txt
SETUP
            chmod 600 "$SETUP_FILE"
            echo ""
            echo "==========================================="
            echo "  First-time setup instructions written to:"
            echo "  ${homeDir}/SETUP-VAULT.txt"
            echo "==========================================="
            touch "$INIT_DONE"
          fi

          echo "Vaultwarden init complete"
        '';
      in {
        serviceConfig = {
          Type = "oneshot";
          ExecStart = vaultInit;
          User = user;
          RemainAfterExit = true;
        };
        after = [ "vaultwarden.service" ];
        requires = [ "vaultwarden.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Dashy (dashboard) ──
    systemd.services.dashy =
      let
        dashyStart = pkgs.writeShellScript "dashy-start" ''
          exec /usr/bin/docker run --rm --name dashy \
            -p ${toString ports.dashy}:8080 \
            -v /var/lib/dashy/conf.yml:/app/user-data/conf.yml \
            lissy93/dashy:latest
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = dashyStart;
          ExecStop = "/usr/bin/docker stop dashy";
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
        };
        after = [ "network.target" "docker.service" ];
        requires = [ "docker.service" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── AgentsView (AI session browser) ──
    systemd.services.agentsview =
      let
        agentsviewStart = pkgs.writeShellScript "agentsview-start" ''
          mkdir -p /var/lib/agentsview
          cat > /var/lib/agentsview/config.json <<EOF
          {"homie_dirs": ["${homeDir}/.homie/conversations"]}
          EOF
          export AGENT_VIEWER_DATA_DIR=/var/lib/agentsview
          export AGENTSVIEW_TRUSTED_HOSTS=agents.${domain}
          export AGENTSVIEW_TRUSTED_ORIGINS=http://agents.${domain}
          exec ${agentsview}/bin/agentsview \
            -host 127.0.0.1 -port ${toString ports.agentsview} -no-browser
        '';
      in {
        serviceConfig = {
          Type = "simple";
          ExecStart = agentsviewStart;
          Restart = "on-failure";
          RestartSec = "5";
          User = user;
        };
        after = [ "network.target" ];
        wantedBy = [ "system-manager.target" ];
      };

    # ── Directories ──
    systemd.tmpfiles.rules = [
      "d /var/lib/gitea 0755 ${user} ${user} -"
      "d /var/lib/gitea/data 0755 ${user} ${user} -"
      "d /var/lib/act-runner 0755 ${user} ${user} -"
      "d /var/lib/homie-overseer 0755 ${user} ${user} -"
"d /etc/pihole 0755 ${user} ${user} -"
      "d /etc/dnsmasq.d 0755 ${user} ${user} -"
      "d /var/lib/dashy 0755 ${user} ${user} -"
      "d /var/lib/agentsview 0755 ${user} ${user} -"
      "d /var/lib/vaultwarden 0755 ${user} ${user} -"
      "d ${homeDir}/models 0755 ${user} ${user} -"
    ];
  };
}



