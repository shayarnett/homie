import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { DockerService } from "../services/docker.js";
import type { SshService } from "../services/ssh.js";
import type { SpecialistConfig } from "./runner.js";
import { shellQuote } from "../util.js";

export interface JinxieServices {
	docker: DockerService;
	ssh: SshService;
	container: string;
}

const execSchema = Type.Object({
	command: Type.String({ description: "Command to execute inside the nginx container" }),
});

const hostExecSchema = Type.Object({
	command: Type.String({ description: "Command to execute on the host via SSH (for port/DNS checks)" }),
});

const readSchema = Type.Object({
	path: Type.String({ description: "Absolute path to the file inside the nginx container" }),
});

const writeSchema = Type.Object({
	path: Type.String({ description: "Absolute path to write inside the nginx container" }),
	content: Type.String({ description: "File content to write" }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Absolute path to the file inside the nginx container" }),
	old_string: Type.String({ description: "The exact string to find and replace" }),
	new_string: Type.String({ description: "The replacement string" }),
});

const nginxTestSchema = Type.Object({});

const nginxReloadSchema = Type.Object({});

function createJinxieTools(services: JinxieServices): AgentTool<any>[] {
	const ctr = services.container;

	return [
		{
			name: "exec",
			label: "Container Exec",
			description: "Execute a command inside the nginx container",
			parameters: execSchema,
			execute: async (_id: string, params: Static<typeof execSchema>) => {
				const result = await services.docker.exec(ctr, ["sh", "-c", params.command]);
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { exitCode: result.exitCode },
				};
			},
		},
		{
			name: "host_exec",
			label: "Host SSH",
			description: "Execute a command on the host via SSH (for port checks, DNS, network diagnostics)",
			parameters: hostExecSchema,
			execute: async (_id: string, params: Static<typeof hostExecSchema>) => {
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
			description: "Read a file from the nginx container",
			parameters: readSchema,
			execute: async (_id: string, params: Static<typeof readSchema>) => {
				const result = await services.docker.exec(ctr, ["cat", params.path]);
				if (result.exitCode !== 0) {
					throw new Error(`Failed to read ${params.path}: ${result.stderr}`);
				}
				return {
					content: [{ type: "text", text: result.stdout }],
					details: {},
				};
			},
		},
		{
			name: "write",
			label: "Write File",
			description: "Write a file inside the nginx container",
			parameters: writeSchema,
			execute: async (_id: string, params: Static<typeof writeSchema>) => {
				const writeResult = await services.docker.exec(ctr, [
					"sh", "-c", `printf '%s' ${shellQuote(params.content)} > ${params.path}`,
				]);
				if (writeResult.exitCode !== 0) {
					throw new Error(`Failed to write ${params.path}: ${writeResult.stderr}`);
				}
				return {
					content: [{ type: "text", text: `Wrote ${params.path}` }],
					details: {},
				};
			},
		},
		{
			name: "edit",
			label: "Edit File",
			description: "Find and replace a string in a file inside the nginx container",
			parameters: editSchema,
			execute: async (_id: string, params: Static<typeof editSchema>) => {
				// Read current content
				const readResult = await services.docker.exec(ctr, ["cat", params.path]);
				if (readResult.exitCode !== 0) {
					throw new Error(`Failed to read ${params.path}: ${readResult.stderr}`);
				}
				const content = readResult.stdout;
				if (!content.includes(params.old_string)) {
					throw new Error(`String not found in ${params.path}: ${params.old_string.substring(0, 100)}`);
				}
				const updated = content.replaceAll(params.old_string, params.new_string);
				// Write back
				const writeResult = await services.docker.exec(ctr, [
					"sh", "-c", `printf '%s' ${shellQuote(updated)} > ${params.path}`,
				]);
				if (writeResult.exitCode !== 0) {
					throw new Error(`Failed to write ${params.path}: ${writeResult.stderr}`);
				}
				return {
					content: [{ type: "text", text: `Edited ${params.path}` }],
					details: {},
				};
			},
		},
		{
			name: "nginx_test",
			label: "Nginx Test",
			description: "Test nginx configuration for syntax errors (nginx -t)",
			parameters: nginxTestSchema,
			execute: async () => {
				const result = await services.docker.exec(ctr, ["nginx", "-t"]);
				const output = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
				return {
					content: [{ type: "text", text: output || "nginx config test passed" }],
					details: { exitCode: result.exitCode },
				};
			},
		},
		{
			name: "nginx_reload",
			label: "Nginx Reload",
			description: "Reload nginx to apply configuration changes (runs nginx -t first)",
			parameters: nginxReloadSchema,
			execute: async () => {
				// Test first
				const test = await services.docker.exec(ctr, ["nginx", "-t"]);
				if (test.exitCode !== 0) {
					const output = test.stdout + (test.stderr ? `\n${test.stderr}` : "");
					throw new Error(`nginx config test failed — not reloading:\n${output}`);
				}
				// Reload
				const result = await services.docker.exec(ctr, ["nginx", "-s", "reload"]);
				if (result.exitCode !== 0) {
					const output = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
					throw new Error(`nginx reload failed:\n${output}`);
				}
				return {
					content: [{ type: "text", text: "nginx reloaded successfully" }],
					details: {},
				};
			},
		},
	];
}

const SYSTEM_PROMPT = `You are Jinxie, an nginx configuration specialist for homelab management.

nginx runs inside a Docker container. All nginx commands (read, write, edit, nginx_test, nginx_reload) operate inside that container where you have full root access.

Your capabilities:
- Read, write, and edit nginx configuration files inside the container
- Test nginx config before applying (nginx -t)
- Reload nginx to apply changes
- Set up reverse proxies, server blocks, SSL, and subdomains
- Execute commands on the host via host_exec for port/DNS checks

## IMPORTANT: nginx is Nix-managed
nginx and its virtualHost configs are managed declaratively in machines/spark.nix (in the homie repo) via \`services.nginx\`.
Do NOT manually edit nginx config files — they are generated by system-manager and will be overwritten on next deploy.
To add or change proxy routes, delegate to Nixie to edit spark.nix.

When modifying nginx configs:
1. Read the existing config first to understand current setup
2. Make targeted edits (prefer edit over full rewrites)
3. Always run nginx_test before nginx_reload
4. Report what changed and whether the reload succeeded

Common config paths (inside the container):
- /etc/nginx/nginx.conf — main config
- /etc/nginx/conf.d/ — site configs
- /usr/share/nginx/html/ — default document root (landing page)

When proxying to services on the host, use the host's LAN IP address (check with host_exec "hostname -I"), NOT host.docker.internal (unsupported on Linux).

Always explain what you're changing and why. Be cautious with existing configurations.`;

export function createJinxieConfig(model: Model<Api>, services: JinxieServices, apiKey?: string): SpecialistConfig {
	return {
		name: "jinxie",
		systemPrompt: SYSTEM_PROMPT,
		model,
		tools: createJinxieTools(services),
		apiKey,
	};
}
