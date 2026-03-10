import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { SshService } from "../services/ssh.js";
import type { GiteaService } from "../services/gitea.js";
import type { SpecialistConfig } from "./runner.js";
import { shellQuote } from "../util.js";

export interface NixieServices {
	ssh: SshService;
	gitea: GiteaService;
	repoDir: string;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Command to execute on the host via SSH" }),
});

const readSchema = Type.Object({
	path: Type.String({ description: "Absolute path to the file on the host" }),
});

const writeSchema = Type.Object({
	path: Type.String({ description: "Absolute path to write on the host" }),
	content: Type.String({ description: "File content to write" }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Absolute path to the file on the host" }),
	old_string: Type.String({ description: "The exact string to find and replace" }),
	new_string: Type.String({ description: "The replacement string" }),
});

const pullRequestSchema = Type.Object({
	branch: Type.String({ description: "Branch name (e.g. 'add-uptime-kuma')" }),
	title: Type.String({ description: "PR title" }),
	body: Type.String({ description: "PR description (use 'closes #N' to link issues)" }),
	commit_message: Type.String({ description: "Git commit message for the changes" }),
});

const pushFixSchema = Type.Object({
	branch: Type.String({ description: "Existing branch name to push the fix to" }),
	commit_message: Type.String({ description: "Git commit message for the fix" }),
});

const nixSearchSchema = Type.Object({
	query: Type.String({ description: "Package name to search for" }),
});

function createNixieTools(services: NixieServices): AgentTool<any>[] {
	return [
		{
			name: "bash",
			label: "SSH Bash",
			description: "Execute a command on the host via SSH",
			parameters: bashSchema,
			execute: async (_id: string, params: Static<typeof bashSchema>) => {
				const result = await services.ssh.exec(params.command);
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { exitCode: result.exitCode },
				};
			},
		},
		{
			name: "read",
			label: "Read File",
			description: "Read a file from the host",
			parameters: readSchema,
			execute: async (_id: string, params: Static<typeof readSchema>) => {
				const content = await services.ssh.readFile(params.path);
				return {
					content: [{ type: "text", text: content }],
					details: {},
				};
			},
		},
		{
			name: "write",
			label: "Write File",
			description: "Write a file on the host",
			parameters: writeSchema,
			execute: async (_id: string, params: Static<typeof writeSchema>) => {
				await services.ssh.writeFile(params.path, params.content);
				return {
					content: [{ type: "text", text: `Wrote ${params.path}` }],
					details: {},
				};
			},
		},
		{
			name: "edit",
			label: "Edit File",
			description: "Find and replace a string in a file on the host",
			parameters: editSchema,
			execute: async (_id: string, params: Static<typeof editSchema>) => {
				const content = await services.ssh.readFile(params.path);
				if (!content.includes(params.old_string)) {
					throw new Error(`String not found in ${params.path}: ${params.old_string.substring(0, 100)}`);
				}
				const updated = content.replaceAll(params.old_string, params.new_string);
				await services.ssh.writeFile(params.path, updated);
				return {
					content: [{ type: "text", text: `Edited ${params.path}` }],
					details: {},
				};
			},
		},
		{
			name: "pull_request",
			label: "Create Pull Request",
			description: "Create a branch, commit changes, and open a pull request on Gitea.",
			parameters: pullRequestSchema,
			execute: async (_id: string, params: Static<typeof pullRequestSchema>) => {
				const branch = params.branch.replace(/[^a-zA-Z0-9_\-\/]/g, "-");
				const msg = params.commit_message.replace(/'/g, "'\\''");
				// Ensure we're on main and clean up any stale branch
				await services.ssh.exec(`cd ${services.repoDir} && git checkout main 2>/dev/null; git branch -D '${branch}' 2>/dev/null; git push origin --delete '${branch}' 2>/dev/null; true`);
				// Create branch, stage all changes, commit, and push
				const cmd = [
					"cd ${services.repoDir}",
					`git checkout -b '${branch}'`,
					"git add -A",
					"git diff --cached --quiet && echo NO_CHANGES && exit 0",
					`git commit -m '${msg}'`,
					`git push -u origin '${branch}' 2>&1`,
				].join(" && ");
				const result = await services.ssh.exec(cmd, { timeout: 60000 });
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");

				if (output.includes("NO_CHANGES")) {
					await services.ssh.exec("cd ${services.repoDir} && git checkout main");
					throw new Error("No changes found to commit. Did you forget to call edit first?");
				}

				if (result.exitCode !== 0) {
					await services.ssh.exec("cd ${services.repoDir} && git checkout main");
					throw new Error(`Failed to push branch (exit ${result.exitCode}):\n${output}`);
				}

				// Switch back to main so future operations aren't on the branch
				await services.ssh.exec("cd ${services.repoDir} && git checkout main");

				// Create the PR via Gitea API
				const pr = await services.gitea.createPullRequest({
					title: params.title,
					body: params.body,
					head: branch,
				});

				return {
					content: [{ type: "text", text: `PR #${pr.number} created: ${pr.html_url}\n\n${params.title}` }],
					details: { prNumber: pr.number, prUrl: pr.html_url },
				};
			},
		},
		{
			name: "push_fix",
			label: "Push Fix",
			description: "Push a fix commit to an existing PR branch (for fixing CI failures)",
			parameters: pushFixSchema,
			execute: async (_id: string, params: Static<typeof pushFixSchema>) => {
				const branch = params.branch.replace(/[^a-zA-Z0-9_\-\/]/g, "-");
				const msg = params.commit_message.replace(/'/g, "'\\''");
				// Checkout the existing branch, commit, and push
				const cmd = [
					"cd ${services.repoDir}",
					`git checkout '${branch}'`,
					"git add -A",
					"git diff --cached --quiet && echo NO_CHANGES && exit 0",
					`git commit -m '${msg}'`,
					`git push origin '${branch}' 2>&1`,
				].join(" && ");
				const result = await services.ssh.exec(cmd, { timeout: 60000 });
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");

				// Always switch back to main
				await services.ssh.exec("cd ${services.repoDir} && git checkout main");

				if (output.includes("NO_CHANGES")) {
					throw new Error("No changes found to commit. Did you forget to call edit first?");
				}
				if (result.exitCode !== 0) {
					throw new Error(`Failed to push fix (exit ${result.exitCode}):\n${output}`);
				}

				return {
					content: [{ type: "text", text: `Fix pushed to branch ${branch}. CI will re-run automatically.` }],
					details: {},
				};
			},
		},
		{
			name: "nix_search",
			label: "Nix Search",
			description: "Search nixpkgs for a package",
			parameters: nixSearchSchema,
			execute: async (_id: string, params: Static<typeof nixSearchSchema>) => {
				const result = await services.ssh.exec(`nix search nixpkgs ${shellQuote(params.query)} 2>&1`, { timeout: 60000 });
				return {
					content: [{ type: "text", text: result.stdout || "(no results)" }],
					details: {},
				};
			},
		},
	];
}

function buildNixiePrompt(repoDir: string): string {
return `You are Nixie, the infrastructure deployment specialist.

## CRITICAL: You MUST use tools to make changes
- You MUST call the \`edit\` tool to modify files. Describing changes is NOT the same as making them.
- You MUST call \`pull_request\` to submit changes. Without it, NOTHING is deployed.
- If you respond without calling edit + pull_request, you have FAILED the task.
- NEVER say "I have deployed" or "changes applied" unless you actually called pull_request and got a PR URL back.

## How Deployment Works
The infrastructure is defined declaratively in ${repoDir}/machines/spark.nix (a Nix flake).
When a PR is merged to main, the overseer service automatically pulls the update and runs \`system-manager switch\` to activate it.

## Your Workflow
1. Read ${repoDir}/machines/spark.nix to understand current services
2. Edit it to add/modify/remove services — you MUST call the \`edit\` tool for each change
3. Call \`pull_request\` to create a branch, commit, push, and open a PR on Gitea
4. Report the PR URL. If you don't have a PR URL, the task is NOT done.

## Adding a Docker Container as a Service
To run a Docker container as a managed service, add a systemd entry like:
\`\`\`nix
systemd.services.my-app = {
  serviceConfig = {
    Type = "simple";
    ExecStart = "/usr/bin/docker run --rm --name my-app -p 8080:80 nginx:alpine";
    ExecStop = "/usr/bin/docker stop my-app";
    Restart = "on-failure";
    RestartSec = "5";
    User = "shay";
  };
  after = [ "network.target" "docker.service" ];
  requires = [ "docker.service" ];
  wantedBy = [ "system-manager.target" ];
};
\`\`\`

## Adding a Native Package Service
For services available in nixpkgs, reference them with \${pkgs.package-name}:
\`\`\`nix
systemd.services.my-service = {
  serviceConfig = {
    Type = "simple";
    ExecStart = "\${pkgs.my-package}/bin/my-binary --flags";
    Restart = "on-failure";
    User = "shay";
  };
  after = [ "network.target" ];
  wantedBy = [ "system-manager.target" ];
};
\`\`\`

## Reverse Proxy (nginx)
nginx is managed declaratively in spark.nix via \`services.nginx.virtualHosts\`.
When adding a service that needs a subdomain, add a virtualHost entry:
\`\`\`nix
services.nginx.virtualHosts."myapp.\${domain}" = {
  locations."/".proxyPass = "http://127.0.0.1:\${toString ports.myapp}";
};
\`\`\`
For WebSocket support, add upgrade headers in \`locations."/".extraConfig\`.
There is a catch-all default virtualHost that returns 444 for unknown subdomains.

## New Service Checklist
When deploying a new service, you MUST do ALL of these steps:
1. **Add port** to the \`ports\` attrset at the top of spark.nix
2. **Add systemd service** (Docker or native package, see examples above)
3. **Add nginx virtualHost** for the subdomain (so it's reachable at \`myapp.spark.local\`)
4. **Add proxy route** to \`~/.homie/config.yaml\` under \`proxy.routes\` so the sidebar shows it:
   \`\`\`yaml
   proxy:
     routes:
       - subdomain: myapp
         port: 8080
   \`\`\`
5. **Create PR** via the pull_request tool

Missing any step means the service won't be fully operational — it might run but not be reachable via subdomain, or not show up in the dashboard.

## Pull Requests
Always use the \`pull_request\` tool to submit your changes. This creates a branch, commits, pushes, and opens a PR on Gitea.
- When working on a Gitea issue, include \`closes #N\` in the PR body so merging auto-closes the issue
- Use a descriptive branch name like \`add-uptime-kuma\` or \`fix-nginx-proxy\`
- The PR title should be concise and describe the change

## Common Pitfalls (IMPORTANT)
- **\`--network host\` + ports**: When using \`--network host\`, the container binds directly to the host's ports. You MUST set the port via env var (e.g., \`-e PORT=\${toString ports.myapp}\`) to avoid conflicts. Check the existing \`ports\` attrset AND hardcoded ports (meilisearch=7700, chrome=9222) before assigning.
- **Nix \`let\` scoping**: Each \`systemd.services.X\` that needs helper variables MUST have its own \`let/in\` block. Variables from one \`let\` block are NOT visible in sibling service definitions. Example:
  \`\`\`nix
  # CORRECT: each service has its own let block
  systemd.services.foo =
    let script = pkgs.writeShellScript "foo" ''...'';
    in { serviceConfig.ExecStart = script; ... };
  systemd.services.bar =
    let script = pkgs.writeShellScript "bar" ''...'';
    in { serviceConfig.ExecStart = script; ... };
  \`\`\`
- **System tools need full paths**: Inside \`writeShellScript\`, the PATH is minimal. Use \`/usr/bin/openssl\`, \`/usr/bin/docker\`, \`/usr/bin/curl\`, etc. — never bare command names for system binaries.
- **Secrets generation**: Use \`[ ! -s file ]\` (non-empty check), NOT \`[ ! -f file ]\` (exists check). A previous failed run may leave empty files. Generate with: \`/usr/bin/openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 40 > /var/lib/myapp/secret\`
- **Multi-container ordering**: If service A depends on service B (e.g., app needs its database), add \`after = [ "B.service" ]\` to A's definition.
- **State directories**: Add \`systemd.tmpfiles.rules\` entries for any \`/var/lib/myapp\` directories the service needs.

## Rules
- Always read the current config before editing
- Use \`edit\` for targeted changes, not full file rewrites
- Use \`nix_search\` to find package names when unsure
- After editing, use \`pull_request\` to submit changes (or \`push_fix\` to fix an existing PR branch)
- The file uses \`wantedBy = [ "system-manager.target" ]\` (not multi-user.target)
- Docker containers need \`requires = [ "docker.service" ]\` and use full path \`/usr/bin/docker\`
- Keep commit messages concise and descriptive`;
}

export function createNixieConfig(model: Model<Api>, services: NixieServices, apiKey?: string): SpecialistConfig {
	return {
		name: "nixie",
		systemPrompt: buildNixiePrompt(services.repoDir),
		model,
		tools: createNixieTools(services),
		apiKey,
		requiredTools: ["pull_request", "push_fix"],
	};
}
