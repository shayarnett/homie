# Homie — Agent Instructions

Self-assembling homelab infrastructure. This is a monorepo — the root is for infra, not the webapp.

## Repo Layout

```
flake.nix              Nix flake: system configs, packages, deploy app
flake.lock             Pinned dependency versions (nixpkgs, system-manager, etc.)
machines/              Nix configs per host — THE source of truth for all services
packages/              Nix package definitions for third-party services
  agentsview/          AgentsView session browser (Go + embedded SPA)
overseer/              Webhook-driven deploy daemon (Python, packaged via default.nix)
homie/                 Web chat UI with specialist agents (TypeScript/Node)
  src/                 Source (orchestrator, specialists, services, server)
    conversations/     Multi-conversation manager, JSONL session logging
    orchestrator/      Agent creation, system prompt, lab state
    server/            HTTP + WebSocket server
    specialists/       Nixie, Termie, Doxie, Jinxie agents
  static/              Static web assets (index.html SPA)
  package.json         Node dependencies
  tsconfig.build.json  TypeScript build config
vllm/recipes/          LLM serving recipe YAML files
scripts/bootstrap.sh   First-time machine setup
```

## How Deployment Works

1. All services are declared in `machines/<host>.nix` using [system-manager](https://github.com/numtide/system-manager) (NOT NixOS)
2. Changes are committed and pushed to Gitea
3. The **overseer** receives a webhook, runs `git pull --ff-only`, then `system-manager switch`
4. system-manager generates systemd units and nginx configs, restarts changed services

**After pushing, system-manager must run for changes to take effect.** Nginx config is generated from `services.nginx.virtualHosts` — it is NOT hand-edited. If system-manager runs but nginx doesn't restart, you must `sudo systemctl restart nginx` manually.

### Manual deploy (when overseer can't auto-deploy)
```bash
ssh <host> "cd /opt/homie && git pull && nix run 'github:numtide/system-manager' -- switch --flake '.#<host>' --sudo"
```

## Nix Packaging Conventions

Everything deployable is a Nix derivation. Follow these patterns:

### Adding a new service (native binary)

1. Create `packages/<name>/default.nix` with a derivation
2. Add the source as a flake input in `flake.nix` (use `flake = false` for non-flake repos)
3. Pass the package to the machine config via `extraSpecialArgs` in `flake.nix`
4. Reference the package in `machines/<host>.nix`

**Example — Go service (AgentsView pattern):**
```nix
# packages/agentsview/default.nix
{ pkgs, agentsview-src }:
let
  frontend = pkgs.buildNpmPackage {
    pname = "myapp-frontend";
    version = "0.0.1";
    src = "${agentsview-src}/frontend";
    npmDepsHash = "sha256-...";  # Get via: nix build, read error
    installPhase = ''
      mkdir -p $out
      cp -r dist/* $out/
    '';
  };
in
pkgs.buildGoModule {
  pname = "myapp";
  version = "0.0.1";
  src = agentsview-src;
  vendorHash = "sha256-...";    # Get via: nix build, read error
  subPackages = [ "cmd/myapp" ];
  preBuild = ''
    cp -r ${frontend} internal/web/dist
  '';
}
```

**Example — Python service (Overseer pattern):**
```nix
# overseer/default.nix
{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "homie-overseer";
  version = "0.1.0";
  src = ./.;
  buildInputs = [ pkgs.python3 ];
  installPhase = ''
    mkdir -p $out/bin
    echo "#!${pkgs.python3}/bin/python3" > $out/bin/homie-overseer
    cat overseer.py >> $out/bin/homie-overseer
    chmod +x $out/bin/homie-overseer
  '';
}
```

### Getting Nix hashes

For `buildGoModule` and `buildNpmPackage`, you must provide content hashes. To get them:

1. Set the hash to `pkgs.lib.fakeHash` (or `"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="`)
2. Build on the target architecture: `nix build '.#systemConfigs.spark'`
3. The error message contains the correct hash — copy it in
4. Build again. Repeat for each hash (npm first, then Go vendor)

**Important**: You cannot cross-build for aarch64-linux on an aarch64-darwin Mac. Build on the target machine.

### Adding a flake input

```nix
# flake.nix inputs
myapp-src = {
  url = "github:owner/repo";
  flake = false;  # Non-flake repos MUST set this
};
```

Then pass to the machine config:
```nix
# In sparkArgs or commonArgs
myapp = pkgs.callPackage ./packages/myapp { inherit myapp-src; };
```

### Docker services (use sparingly — prefer Nix packages)

Only use Docker when the service can't be packaged with Nix (complex native deps, vendor images like pihole). Pattern:

```nix
systemd.services.myapp = {
  serviceConfig = {
    ExecStart = pkgs.writeShellScript "myapp-start" ''
      exec /usr/bin/docker run --rm --name myapp \
        -p ${toString ports.myapp}:8080 \
        -v /var/lib/myapp:/data \
        myimage:latest
    '';
    ExecStop = "/usr/bin/docker stop myapp";
    # ...
  };
  requires = [ "docker.service" ];
};
```

## Machine Nix Conventions

- **Ports**: defined in the `ports` attrset at the top of each machine's nix file. Always check/add here first.
- **Domain**: constructed as `${hostname}.local`. Subdomains use `"subdomain.${domain}"`.
- **All services**: use `wantedBy = [ "system-manager.target" ]` (NOT `multi-user.target`)
- **nginx virtualHosts**: every user-facing service needs one. There's a catch-all `"_"` that returns 444.
- **Directories**: use `systemd.tmpfiles.rules` for persistent data dirs, NOT `mkdir` in scripts.
- **Host check / CORS**: services behind nginx with anti-DNS-rebinding (like AgentsView) need trusted host/origin env vars since nginx forwards the subdomain as the Host header.

## Homie Webapp (homie/)

TypeScript app built with `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

- **Build**: `cd homie && npm install && npx tsc -p tsconfig.build.json`
- **Run**: `node homie/dist/main.js --server --host=0.0.0.0 --port=<port>`
- **Config**: `~/.homie/config.yaml` on the host (not in repo)
- **Specialists**: nixie (deploy), termie (SSH/debug), doxie (Docker), jinxie (nginx)
- **Tool schemas**: use `@sinclair/typebox` (`Type.Object`, `Type.String`, etc.)
- **Services**: SSH, Docker, LXD — instantiated in `homie.ts`, passed to specialists
- **Imports**: use `.js` extensions in import paths (ESM)

### Multi-Conversation Architecture

- `ConversationManager` in `src/conversations/manager.ts` — creates/lists/removes conversations
- Each conversation: UUID directory under `~/.homie/conversations/<uuid>/`
- `SharedServices` (SSH, Docker, LXD, Gitea) are shared; each conversation gets its own `Agent` instance
- `JsonlLogger` writes `session.jsonl` per conversation for AgentsView compatibility
- WebSocket protocol: `join`, `create`, `delete`, `rename`, `list`, `chat`, `stop`, `clear`
- Webhooks (Gitea issues, PRs, CI failures) create separate conversations with source tracking
- Legacy single `conversation.json` auto-migrates on first run

### JSONL Session Format (for AgentsView)

Each conversation writes `session.jsonl` with these entry types:
```jsonl
{"type":"summary","sessionId":"...","timestamp":"...","title":"...","source":"user|gitea-issue|..."}
{"type":"user","uuid":"...","sessionId":"...","timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"assistant","uuid":"...","parentUuid":"...","sessionId":"...","timestamp":"...","message":{"role":"assistant","content":[...]}}
{"type":"tool_call","uuid":"...","parentUuid":"...","sessionId":"...","timestamp":"...","toolName":"...","args":{...}}
{"type":"tool_result","uuid":"...","parentUuid":"...","sessionId":"...","timestamp":"...","toolName":"...","isError":false,"result":"..."}
```

## AgentsView Integration

AgentsView (`packages/agentsview/`) is a Go web app that indexes and browses AI agent sessions. It's built from the fork at `github:shayarnett/agentsview`.

- **Parser**: `internal/parser/homie.go` reads homie's JSONL format
- **Discovery**: scans `~/.homie/conversations/<uuid>/session.jsonl`
- **Config**: `config.json` with `"homie_dirs"` pointing at the conversations directory
- **Env vars**: `AGENTSVIEW_TRUSTED_HOSTS` and `AGENTSVIEW_TRUSTED_ORIGINS` for reverse proxy setups
- **URL**: `http://agents.<hostname>.local`

To update the AgentsView version: update the `agentsview-src` flake input, then rebuild hashes.

## Common Pitfalls

- **system-manager ≠ NixOS**: system-manager has a subset of NixOS module options. Don't assume all NixOS nginx options exist.
- **Deploy ≠ activate**: pushing to Gitea triggers overseer, but if `git pull` fails (dirty working tree, conflicts), the deploy silently fails. Check overseer logs.
- **nginx won't auto-restart**: system-manager may rebuild the config but not restart nginx. Always verify with `systemctl status nginx` and check the config path in the process matches the new generation.
- **nginx recommendedProxySettings**: sets `proxy_set_header Host $host` via an include. You CANNOT override this with `extraConfig` because the include comes after. If a service needs a different Host header, use env vars on the service side instead.
- **The `result` symlink**: `nix build` creates a `result` symlink. It's in `.gitignore` but can block `git pull` if it gets tracked. Never commit it.
- **Working tree on hosts**: the repo dir can accumulate untracked files (build artifacts, nix results). These block `git pull --ff-only`. Keep it clean.
- **File permissions after Docker→Nix migration**: Docker containers run as root by default. When switching a service from Docker to a native Nix package running as a user, `chown` the data directory.
- **Cross-compilation**: Don't try to build aarch64-linux packages on aarch64-darwin. Build on the target machine.
- **Hash iteration**: Getting Nix hashes requires building (and failing) on the target arch. npm hash first, then Go vendor hash — they're sequential dependencies.
- **Don't use GHCR/DockerHub for homelab images**: This is a self-contained system. Package everything with Nix.
