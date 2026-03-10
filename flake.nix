{
  description = "Homie — self-assembling homelab";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    system-manager = {
      url = "github:numtide/system-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
    agentsview-src = {
      url = "github:shayarnett/agentsview";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, system-manager, flake-utils, agentsview-src, ... }:
    let
      # Shared args for all machine configs
      commonArgs = system: let
        pkgs = import nixpkgs { inherit system; };
      in {
        overseer = pkgs.callPackage ./overseer { };
      };

      sparkArgs = system: let
        pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
      in (commonArgs system) // {
        agentsview = pkgs.callPackage ./packages/agentsview { inherit agentsview-src; };
      };
    in {
      # ── System configs (system-manager) ──
      systemConfigs = {
        spark = system-manager.lib.makeSystemConfig {
          modules = [ ./machines/spark.nix ];
          extraSpecialArgs = sparkArgs "aarch64-linux";
        };
        storage = system-manager.lib.makeSystemConfig {
          modules = [ ./machines/storage.nix ];
          extraSpecialArgs = commonArgs "x86_64-linux";
        };
        gpu-box = system-manager.lib.makeSystemConfig {
          modules = [ ./machines/gpu-box.nix ];
          extraSpecialArgs = commonArgs "x86_64-linux";
        };
      };

    } // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        packages = {
          overseer = pkgs.callPackage ./overseer { };
        };

        # One-command setup: switch + push to Gitea
        apps.setup = {
          type = "app";
          program = toString (pkgs.writeShellScript "homie-setup" ''
            set -euo pipefail
            MACHINE="''${1:-spark}"
            REPO_DIR="$(pwd)"

            echo "=== Homie Setup ==="
            echo "Machine: $MACHINE"
            echo "Repo: $REPO_DIR"

            # 1. Run system-manager switch
            echo ""
            echo "Activating system-manager..."
            nix run 'github:numtide/system-manager' -- switch --flake ".#$MACHINE" --sudo

            # 2. Wait for gitea-init to create the token
            TOKEN_FILE="/var/lib/homie-overseer/gitea-token"
            echo ""
            echo "Waiting for Gitea init..."
            for i in $(seq 1 60); do
              if [ -s "$TOKEN_FILE" ]; then
                echo "Gitea initialized"
                break
              fi
              sleep 2
            done

            TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || echo "")
            if [ -z "$TOKEN" ]; then
              echo "ERROR: Gitea init did not produce a token"
              exit 1
            fi

            # 3. Push to Gitea if the repo there is empty
            GITEA_URL="http://localhost:3000"
            GITEA_ORG="homie"
            GITEA_REPO="infra"

            EMPTY=$(${pkgs.curl}/bin/curl -sf -H "Authorization: token $TOKEN" \
              "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO" 2>/dev/null \
              | grep -o '"empty":[a-z]*' | grep -o 'true\|false' || echo "")

            if [ "$EMPTY" = "true" ]; then
              echo ""
              echo "Pushing repo to Gitea..."
              cd "$REPO_DIR"
              ${pkgs.git}/bin/git remote set-url origin \
                "http://homie-admin:$TOKEN@localhost:3000/$GITEA_ORG/$GITEA_REPO.git" 2>/dev/null \
                || ${pkgs.git}/bin/git remote add origin \
                "http://homie-admin:$TOKEN@localhost:3000/$GITEA_ORG/$GITEA_REPO.git"
              ${pkgs.git}/bin/git push -u origin main
              echo "Pushed to Gitea"
            else
              echo "Gitea repo already has content, skipping push"
            fi

            echo ""
            echo "=== Setup Complete ==="
          '');
        };

        # Validate system configs — `nix flake check` runs these
        checks = {
          spark-config = pkgs.runCommand "check-spark-config" {
            # Force nix to evaluate the spark system config derivation.
            # If any service definition has scoping errors, undefined vars,
            # or invalid nix expressions, this fails at eval time.
            sparkDrv = self.systemConfigs.spark;
          } ''
            echo "Spark config evaluated successfully"
            touch $out
          '';
        };
      }
    );
}
