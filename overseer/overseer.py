#!/usr/bin/env python3
"""Homie Overseer — webhook listener and reconciler.

Runs as a systemd service. On webhook or manual trigger, pulls the
latest config and runs system-manager switch to reconcile services.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler


STATE_DIR = "/var/lib/homie-overseer"
PENDING_FILE = os.path.join(STATE_DIR, "pending-job.json")


def set_commit_status(sha, state, description, token, gitea_url, gitea_org, gitea_repo):
    """Post commit status back to Gitea (pending/success/failure)."""
    url = f"{gitea_url}/api/v1/repos/{gitea_org}/{gitea_repo}/statuses/{sha}"
    data = json.dumps({
        "state": state,
        "description": description[:140],
        "context": "overseer/switch",
    }).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"token {token}",
    })
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"[overseer] Failed to set commit status: {e}", flush=True)


def save_pending_job(sha, old_sha=None, new_sha=None):
    """Write a pending job file so we can finish it after restart."""
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(PENDING_FILE, "w") as f:
        json.dump({"sha": sha, "state": "pending",
                   "old_sha": old_sha or "", "new_sha": new_sha or ""}, f)


def complete_pending_job(ok):
    """Mark the pending job as done (but keep the file for finish_pending_jobs)."""
    if not os.path.exists(PENDING_FILE):
        return
    try:
        with open(PENDING_FILE) as f:
            job = json.load(f)
        job["state"] = "success" if ok else "failure"
        with open(PENDING_FILE, "w") as f:
            json.dump(job, f)
    except Exception:
        pass


def clear_pending_job():
    """Remove the pending job file."""
    try:
        os.remove(PENDING_FILE)
    except FileNotFoundError:
        pass


def finish_pending_jobs(server):
    """On startup, check for jobs that were interrupted by a restart."""
    if not os.path.exists(PENDING_FILE):
        return
    try:
        with open(PENDING_FILE) as f:
            job = json.load(f)
    except Exception:
        clear_pending_job()
        return

    sha = job.get("sha", "")
    state = job.get("state", "pending")

    if not sha or not server.gitea_token:
        clear_pending_job()
        return

    # If still "pending", the overseer was killed mid-switch (system-manager restarted us).
    # That means switch succeeded (we wouldn't be running the new code otherwise).
    if state == "pending":
        state = "success"
        msg = "ok (confirmed after restart)"
        print(f"[overseer] Finishing pending job for {sha[:8]}: {state}", flush=True)

        # Restart services whose source changed (we were killed before we could do this)
        old_sha = job.get("old_sha", "")
        new_sha = job.get("new_sha", "")
        if old_sha and new_sha and old_sha != new_sha:
            changed = get_changed_files(server.repo_dir, old_sha, new_sha)
            if changed:
                restart_affected_services(server.repo_dir, changed)
    else:
        msg = "ok" if state == "success" else "failed"

    set_commit_status(sha, state, msg, server.gitea_token,
                      server.gitea_url, server.gitea_org, server.gitea_repo)
    clear_pending_job()


# Map source directories to the services that need restarting when they change.
# system-manager only restarts services when their nix-generated unit changes,
# so we handle app-level source changes here.
# Map source directories to services that need restarting when they change.
# system-manager only restarts services when their nix-generated unit changes,
# so we handle app-level source changes here.
# NOTE: Do NOT include homie-overseer — system-manager switch restarts us anyway.
SOURCE_RESTART_MAP = {
    "homie/": "homie",
}


def get_changed_files(repo_dir, old_sha, new_sha):
    """Get list of files changed between two commits."""
    result = subprocess.run(
        ["git", "diff", "--name-only", old_sha, new_sha],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    return result.stdout.strip().splitlines()


def restart_affected_services(repo_dir, changed_files):
    """Restart services whose source directories were modified."""
    to_restart = set()
    for path in changed_files:
        for prefix, service in SOURCE_RESTART_MAP.items():
            if path.startswith(prefix):
                to_restart.add(service)

    for service in to_restart:
        print(f"[overseer] Restarting {service} (source changed)", flush=True)
        subprocess.run(
            ["sudo", "systemctl", "restart", service],
            capture_output=True,
            text=True,
        )


def reconcile(repo_dir, machine, sha=None):
    """Pull latest config and run system-manager switch."""
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        print(f"[overseer] No repo at {repo_dir}, skipping reconcile", flush=True)
        return False, f"no repo at {repo_dir}"

    print(f"[overseer] Reconciling {machine}...", flush=True)

    # Record current SHA before pull
    old_sha_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )
    old_sha = old_sha_result.stdout.strip()

    # Pull latest
    result = subprocess.run(
        ["git", "pull", "--ff-only"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[overseer] git pull failed: {result.stderr}", flush=True)
        return False, f"git pull failed: {result.stderr}"

    print(f"[overseer] git pull: {result.stdout.strip()}", flush=True)

    # Record new SHA after pull
    new_sha_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )
    new_sha = new_sha_result.stdout.strip()

    # Restart services whose source changed BEFORE system-manager switch,
    # because switch may restart the overseer itself, killing this process.
    if old_sha != new_sha:
        changed = get_changed_files(repo_dir, old_sha, new_sha)
        if changed:
            restart_affected_services(repo_dir, changed)

    # Save pending job so we can finish the status + restarts after our own restart
    job_sha = sha or new_sha
    if job_sha:
        save_pending_job(job_sha, old_sha, new_sha)

    # Run system-manager switch (--sudo escalates only the activation step)
    # NOTE: This may kill the overseer if its own unit changed.
    result = subprocess.run(
        ["nix", "run",
         "--extra-experimental-features", "nix-command flakes",
         "github:numtide/system-manager", "--",
         "switch", "--flake", f"{repo_dir}#{machine}", "--sudo"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        print(f"[overseer] switch failed: {result.stderr}", flush=True)
        complete_pending_job(False)
        return False, f"switch failed: {result.stderr}"

    print(f"[overseer] switch complete", flush=True)
    complete_pending_job(True)

    return True, "ok"


def get_health(managed_services):
    """Check status of managed services via systemctl."""
    statuses = {}
    for svc in managed_services:
        result = subprocess.run(
            ["systemctl", "is-active", svc],
            capture_output=True,
            text=True,
        )
        statuses[svc] = result.stdout.strip()

    all_ok = all(s == "active" for s in statuses.values())
    return {"healthy": all_ok, "services": statuses}


def handle_webhook(server, payload):
    """Run reconciliation in background and post commit status to Gitea."""
    # Extract the head commit SHA
    sha = payload.get("after") or payload.get("head_commit", {}).get("id", "")
    token = server.gitea_token

    if sha and token:
        set_commit_status(sha, "pending", "Reconciling...", token,
                          server.gitea_url, server.gitea_org, server.gitea_repo)

    # Ensure repo exists before reconciling (first push triggers this)
    ensure_repo(server.repo_dir, server.gitea_url, server.gitea_org,
                server.gitea_repo, server.gitea_token)

    ok, msg = reconcile(server.repo_dir, server.machine, sha)

    # If we get here, switch didn't kill us — post final status directly
    if sha and token:
        state = "success" if ok else "failure"
        set_commit_status(sha, state, msg, token,
                          server.gitea_url, server.gitea_org, server.gitea_repo)
        clear_pending_job()


class OverseerHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/webhook":
            # Read and parse payload
            content_len = int(self.headers.get("Content-Length", 0))
            payload = {}
            if content_len > 0:
                body = self.rfile.read(content_len)
                try:
                    payload = json.loads(body)
                    ref = payload.get("ref", "")
                    pusher = payload.get("pusher", {}).get("login", "unknown")
                    commits = len(payload.get("commits", []))
                    print(f"[overseer] Webhook: {pusher} pushed {commits} commit(s) to {ref}", flush=True)
                except (json.JSONDecodeError, KeyError):
                    print("[overseer] Webhook: received push event", flush=True)

            # Ack immediately, reconcile in background
            self.send_response(202)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "message": "accepted"}).encode())

            # Only reconcile pushes to main
            ref = payload.get("ref", "")
            if ref == "refs/heads/main":
                threading.Thread(
                    target=handle_webhook,
                    args=(self.server, payload),
                    daemon=True,
                ).start()
            else:
                print(f"[overseer] Ignoring push to {ref} (not main)", flush=True)
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == "/health":
            health = get_health(self.server.managed_services)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(health, indent=2).encode())
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        print(f"[overseer] {args[0]}", flush=True)


def gitea_remote_url(gitea_url, gitea_org, gitea_repo, token):
    """Build an authenticated Gitea remote URL."""
    from urllib.parse import urlparse, urlunparse
    parsed = urlparse(f"{gitea_url}/{gitea_org}/{gitea_repo}.git")
    return urlunparse(parsed._replace(
        netloc=f"homie-admin:{token}@{parsed.hostname}" +
               (f":{parsed.port}" if parsed.port else "")
    ))


def ensure_repo(repo_dir, gitea_url, gitea_org, gitea_repo, token):
    """Ensure repo_dir is a working clone of the Gitea repo.

    On first boot the Gitea repo may be empty. In that case the overseer
    waits — the user pushes to Gitea from their initial clone, which
    triggers a webhook that calls reconcile() which does git pull.
    """
    if not token:
        return

    remote_url = gitea_remote_url(gitea_url, gitea_org, gitea_repo, token)

    # Already a git repo — just make sure origin points to gitea
    if os.path.isdir(os.path.join(repo_dir, ".git")):
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=repo_dir, capture_output=True, text=True,
        )
        current = result.stdout.strip() if result.returncode == 0 else ""
        if gitea_url.rstrip("/") not in current:
            if current:
                subprocess.run(["git", "remote", "set-url", "origin", remote_url],
                               cwd=repo_dir, capture_output=True)
            else:
                subprocess.run(["git", "remote", "add", "origin", remote_url],
                               cwd=repo_dir, capture_output=True)
            print(f"[overseer] Set origin remote to Gitea", flush=True)
        return

    # No repo yet — check if Gitea has content to clone
    api = f"{gitea_url}/api/v1/repos/{gitea_org}/{gitea_repo}"
    headers = {"Authorization": f"token {token}"}
    try:
        req = urllib.request.Request(api, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            repo_info = json.loads(resp.read())
    except Exception as e:
        print(f"[overseer] Failed to check Gitea repo: {e}", flush=True)
        return

    if repo_info.get("empty", False):
        print(f"[overseer] Gitea repo is empty — waiting for initial push", flush=True)
        return

    # Clone from Gitea
    print(f"[overseer] Cloning from Gitea to {repo_dir}...", flush=True)
    result = subprocess.run(
        ["git", "clone", remote_url, repo_dir],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode == 0:
        # Set git identity for commits
        subprocess.run(["git", "config", "user.email", "overseer@homie.local"],
                       cwd=repo_dir, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Homie Overseer"],
                       cwd=repo_dir, capture_output=True)
        print(f"[overseer] Cloned repo to {repo_dir}", flush=True)
    else:
        print(f"[overseer] Clone failed: {result.stderr}", flush=True)


def ensure_webhooks(gitea_url, gitea_org, gitea_repo, token, webhooks):
    """Ensure required webhooks exist on the Gitea repo. Creates missing ones.

    webhooks: list of {"url": ..., "events": [...]} dicts
    """
    if not token:
        return

    api = f"{gitea_url}/api/v1/repos/{gitea_org}/{gitea_repo}/hooks"
    headers = {"Authorization": f"token {token}", "Content-Type": "application/json"}

    # List existing hooks
    try:
        req = urllib.request.Request(api, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            existing = json.loads(resp.read())
    except Exception as e:
        print(f"[overseer] Failed to list webhooks: {e}", flush=True)
        return

    existing_urls = {h.get("config", {}).get("url", "") for h in existing}

    for hook in webhooks:
        if hook["url"] in existing_urls:
            continue
        data = json.dumps({
            "type": "gitea",
            "active": True,
            "events": hook["events"],
            "config": {
                "url": hook["url"],
                "content_type": "json",
            },
        }).encode()
        try:
            req = urllib.request.Request(api, data=data, method="POST", headers=headers)
            urllib.request.urlopen(req, timeout=10)
            print(f"[overseer] Created webhook: {hook['url']}", flush=True)
        except Exception as e:
            print(f"[overseer] Failed to create webhook {hook['url']}: {e}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Homie Overseer")
    parser.add_argument("--machine", required=True, help="Machine name (spark, storage, gpu-box)")
    parser.add_argument("--repo", default="/var/lib/homie/repo", help="Path to homie repo")
    parser.add_argument("--port", type=int, default=9100, help="Listen port")
    parser.add_argument("--services", nargs="*", default=[], help="Service names to monitor")
    parser.add_argument("--gitea-token", default="", help="Gitea API token for commit statuses")
    parser.add_argument("--gitea-url", default="http://localhost:3000", help="Gitea base URL")
    parser.add_argument("--gitea-org", default="homie", help="Gitea organization name")
    parser.add_argument("--gitea-repo", default="infra", help="Gitea repository name")
    parser.add_argument("--homie-port", type=int, default=0, help="Homie server port (for issue webhook)")
    args = parser.parse_args()

    server = HTTPServer(("0.0.0.0", args.port), OverseerHandler)
    server.repo_dir = args.repo
    server.machine = args.machine
    server.managed_services = args.services
    server.gitea_token = args.gitea_token
    server.gitea_url = args.gitea_url
    server.gitea_org = args.gitea_org
    server.gitea_repo = args.gitea_repo

    # Finish any jobs that were interrupted by a restart
    finish_pending_jobs(server)

    # Ensure repo is cloned from Gitea and origin remote is correct
    ensure_repo(args.repo, args.gitea_url, args.gitea_org, args.gitea_repo, args.gitea_token)

    # Ensure required webhooks exist on the Gitea repo
    webhooks = [
        {"url": f"http://localhost:{args.port}/webhook", "events": ["push"]},
    ]
    if args.homie_port:
        webhooks.append({
            "url": f"http://localhost:{args.homie_port}/api/webhook/gitea",
            "events": ["issues", "issue_comment"],
        })
    ensure_webhooks(args.gitea_url, args.gitea_org, args.gitea_repo, args.gitea_token, webhooks)

    print(f"[overseer] Listening on :{args.port} for {args.machine}", flush=True)
    print(f"[overseer] Repo: {args.repo}", flush=True)
    print(f"[overseer] Monitoring: {args.services}", flush=True)
    if args.gitea_token:
        print(f"[overseer] Commit statuses: enabled", flush=True)

    server.serve_forever()


if __name__ == "__main__":
    main()
