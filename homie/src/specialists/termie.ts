import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { LxdService } from "../services/lxd.js";
import type { DockerService } from "../services/docker.js";
import type { SshService } from "../services/ssh.js";
import type { SpecialistConfig } from "./runner.js";
import { shellQuote } from "../util.js";

export interface TermieServices {
	lxd: LxdService;
	docker: DockerService;
	ssh: SshService;
}

const containerExecSchema = Type.Object({
	container: Type.String({ description: "LXD container name" }),
	command: Type.String({ description: "Command to run inside the container" }),
});

const dockerExecSchema = Type.Object({
	container: Type.String({ description: "Docker container name or ID" }),
	command: Type.String({ description: "Command to run inside the container" }),
});

const sshExecSchema = Type.Object({
	command: Type.String({ description: "Command to execute via SSH" }),
});

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute locally" }),
});

const readLogsSchema = Type.Object({
	source: Type.Union([Type.Literal("journalctl"), Type.Literal("docker"), Type.Literal("file")]),
	target: Type.String({ description: "Unit name, container name, or file path" }),
	lines: Type.Optional(Type.Number({ description: "Number of lines to tail (default: 100)" })),
});

function formatExecResult(result: { stdout: string; stderr: string; exitCode: number }) {
	const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
	const text = result.exitCode !== 0
		? `[exit code ${result.exitCode}]\n${output || "(no output)"}`
		: output || "(no output)";
	return {
		content: [{ type: "text" as const, text }],
		details: { exitCode: result.exitCode },
	};
}

function createTermieTools(services: TermieServices): AgentTool<any>[] {
	return [
		{
			name: "container_exec",
			label: "LXD Exec",
			description: "Execute a command inside an LXD container",
			parameters: containerExecSchema,
			execute: async (_id: string, params: Static<typeof containerExecSchema>) => {
				const result = await services.lxd.exec(params.container, ["sh", "-c", params.command]);
				return formatExecResult(result);
			},
		},
		{
			name: "docker_exec",
			label: "Docker Exec",
			description: "Execute a command inside a Docker container",
			parameters: dockerExecSchema,
			execute: async (_id: string, params: Static<typeof dockerExecSchema>) => {
				const result = await services.docker.exec(params.container, ["sh", "-c", params.command]);
				return formatExecResult(result);
			},
		},
		{
			name: "ssh_exec",
			label: "SSH Exec",
			description: "Execute a command on the remote host via SSH",
			parameters: sshExecSchema,
			execute: async (_id: string, params: Static<typeof sshExecSchema>) => {
				const result = await services.ssh.exec(params.command);
				return formatExecResult(result);
			},
		},
		{
			name: "bash",
			label: "Bash",
			description: "Execute a bash command on the local host",
			parameters: bashSchema,
			execute: async (_id: string, params: Static<typeof bashSchema>) => {
				const { execFile } = await import("child_process");
				return new Promise((resolve, reject) => {
					execFile("bash", ["-c", params.command], {
						timeout: 30000,
						maxBuffer: 10 * 1024 * 1024,
					}, (error, stdout, stderr) => {
						const exitCode = (error as any)?.code ?? 0;
						resolve(formatExecResult({ stdout, stderr, exitCode }));
					});
				});
			},
		},
		{
			name: "read_logs",
			label: "Read Logs",
			description: "Read logs from journalctl, docker, or a file",
			parameters: readLogsSchema,
			execute: async (_id: string, params: Static<typeof readLogsSchema>) => {
				const lines = params.lines ?? 100;
				let output: string;

				if (params.source === "journalctl") {
					const result = await services.ssh.exec(`journalctl -u ${shellQuote(params.target)} -n ${lines} --no-pager`);
					output = result.stdout;
				} else if (params.source === "docker") {
					const result = await services.docker.logs(params.target, lines);
					output = result.stdout + result.stderr;
				} else {
					const result = await services.ssh.exec(`tail -n ${lines} ${shellQuote(params.target)}`);
					output = result.stdout;
				}

				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: {},
				};
			},
		},
	];
}

const SYSTEM_PROMPT = `You are Termie, a terminal debugging and inspection specialist for homelab management.

Your capabilities:
- Execute commands in LXD containers, Docker containers, or via SSH
- Read and tail logs from journalctl, docker, or files
- Run local bash commands for quick checks

Be concise and focused. When debugging:
1. Check the relevant logs first
2. Verify service status
3. Test connectivity if needed
4. Report findings clearly

Always explain what you're doing and why. If a command fails, try to diagnose the issue.`;

export function createTermieConfig(model: Model<Api>, services: TermieServices, apiKey?: string): SpecialistConfig {
	return {
		name: "termie",
		systemPrompt: SYSTEM_PROMPT,
		model,
		tools: createTermieTools(services),
		apiKey,
	};
}
