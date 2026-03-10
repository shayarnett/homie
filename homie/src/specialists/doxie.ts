import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { DockerService } from "../services/docker.js";
import type { SpecialistConfig } from "./runner.js";

export interface DoxieServices {
	docker: DockerService;
}

const dockerPsSchema = Type.Object({
	all: Type.Optional(Type.Boolean({ description: "Show all containers including stopped (default: false)" })),
});

const dockerLogsSchema = Type.Object({
	container: Type.String({ description: "Container name or ID" }),
	tail: Type.Optional(Type.Number({ description: "Number of lines to show (default: 100)" })),
});

const dockerExecSchema = Type.Object({
	container: Type.String({ description: "Container name or ID" }),
	command: Type.String({ description: "Command to execute" }),
});

const dockerComposeSchema = Type.Object({
	file: Type.String({ description: "Path to docker-compose.yml" }),
	subcommand: Type.String({ description: "Compose subcommand (up, down, restart, logs, ps)" }),
	args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments" })),
});

const dockerRunSchema = Type.Object({
	image: Type.String({ description: "Docker image to run" }),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments to pass to the container" })),
	gpu: Type.Optional(Type.Boolean({ description: "Enable GPU access (--gpus all)" })),
});

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute locally" }),
});

function createDoxieTools(services: DoxieServices): AgentTool<any>[] {
	return [
		{
			name: "docker_ps",
			label: "Docker PS",
			description: "List running Docker containers",
			parameters: dockerPsSchema,
			execute: async (_id: string, params: Static<typeof dockerPsSchema>) => {
				const result = await services.docker.ps(params.all);
				return {
					content: [{ type: "text", text: result.stdout || "(no containers)" }],
					details: {},
				};
			},
		},
		{
			name: "docker_logs",
			label: "Docker Logs",
			description: "View logs from a Docker container",
			parameters: dockerLogsSchema,
			execute: async (_id: string, params: Static<typeof dockerLogsSchema>) => {
				const result = await services.docker.logs(params.container, params.tail ?? 100);
				const output = result.stdout + result.stderr;
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: {},
				};
			},
		},
		{
			name: "docker_exec",
			label: "Docker Exec",
			description: "Execute a command inside a Docker container",
			parameters: dockerExecSchema,
			execute: async (_id: string, params: Static<typeof dockerExecSchema>) => {
				const result = await services.docker.exec(params.container, ["sh", "-c", params.command]);
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { exitCode: result.exitCode },
				};
			},
		},
		{
			name: "docker_compose",
			label: "Docker Compose",
			description: "Run a docker compose command",
			parameters: dockerComposeSchema,
			execute: async (_id: string, params: Static<typeof dockerComposeSchema>) => {
				const result = await services.docker.compose(params.file, params.subcommand, params.args);
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { exitCode: result.exitCode },
				};
			},
		},
		{
			name: "docker_run",
			label: "Docker Run",
			description: "Run a new Docker container (with optional GPU support)",
			parameters: dockerRunSchema,
			execute: async (_id: string, params: Static<typeof dockerRunSchema>) => {
				const result = await services.docker.run(params.image, params.args, params.gpu);
				const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { exitCode: result.exitCode },
				};
			},
		},
		{
			name: "gpu_status",
			label: "GPU Status",
			description: "Check GPU status via nvidia-smi",
			parameters: Type.Object({}),
			execute: async () => {
				try {
					const output = await services.docker.nvidiaSmi();
					return {
						content: [{ type: "text", text: output }],
						details: {},
					};
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `GPU check failed: ${msg}` }],
						details: { error: true },
					};
				}
			},
		},
		{
			name: "bash",
			label: "Bash",
			description: "Execute a bash command on the local host",
			parameters: bashSchema,
			execute: async (_id: string, params: Static<typeof bashSchema>) => {
				const { execFile } = await import("child_process");
				return new Promise((resolve) => {
					execFile("bash", ["-c", params.command], {
						timeout: 30000,
						maxBuffer: 10 * 1024 * 1024,
					}, (error, stdout, stderr) => {
						const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
						resolve({
							content: [{ type: "text", text: output || "(no output)" }],
							details: { exitCode: (error as any)?.code ?? 0 },
						});
					});
				});
			},
		},
	];
}

const SYSTEM_PROMPT = `You are Doxie, a Docker inspection and GPU specialist for homelab management.

Your capabilities:
- List and inspect Docker containers
- View container logs
- Execute commands inside containers
- Run docker compose commands
- Check GPU status via nvidia-smi

When inspecting containers:
1. Check current state with docker_ps first
2. Review logs if troubleshooting
3. Use compose for multi-container setups
4. Always enable GPU (gpu: true) for ML/AI workloads

IMPORTANT: You are NOT responsible for deploying new services or setting up subdomain routing.
To deploy a new service, delegate to Nixie — she handles all of:
- Adding the systemd service to spark.nix
- Adding the nginx virtualHost for subdomain routing
- Adding the proxy route to ~/.homie/config.yaml for the dashboard sidebar
- Committing and pushing to trigger system-manager switch

Your role is inspecting and debugging existing containers only.

Be concise and report results clearly.`;

export function createDoxieConfig(model: Model<Api>, services: DoxieServices, apiKey?: string): SpecialistConfig {
	return {
		name: "doxie",
		systemPrompt: SYSTEM_PROMPT,
		model,
		tools: createDoxieTools(services),
		apiKey,
	};
}
