import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { execFile } from "child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { LabState } from "../types.js";
import type { HomieConfig } from "../config.js";
import { getAgentModel, getDataDir } from "../config.js";
import { LxdService } from "../services/lxd.js";
import { DockerService } from "../services/docker.js";
import { SshService } from "../services/ssh.js";
import { GiteaService } from "../services/gitea.js";
import { createLabHealthTool } from "./lab-health-tool.js";
import { createListServicesTool } from "./list-services-tool.js";
import { createDelegateTool, type DelegationEventCallback } from "./delegate-tool.js";
import { getCachedLabState, refreshLabState, formatLabState, type LabStateServices } from "./lab-state.js";

export interface SharedServices {
	labStateServices: LabStateServices;
	gitea: GiteaService;
	config: HomieConfig;
	lxd: LxdService;
	docker: DockerService;
	ssh: SshService;
}

export interface HomieInstance {
	agent: Agent;
	subscribe: (fn: (event: AgentEvent) => void) => () => void;
	subscribeDelegation: (fn: DelegationEventCallback) => () => void;
	prompt: (message: string) => Promise<void>;
	abort: () => void;
	reset: () => void;
	getMessages: () => any[];
	getLabState: () => Promise<LabState>;
	isBusy: () => boolean;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute on the host" }),
});

function createBashTool(): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: "Execute a bash command on the local host for quick checks",
		parameters: bashSchema,
		execute: async (_id: string, params: Static<typeof bashSchema>) => {
			return new Promise((resolve) => {
				execFile("bash", ["-c", params.command], {
					timeout: 30000,
					maxBuffer: 10 * 1024 * 1024,
				}, (error, stdout, stderr) => {
					const exitCode = (error as any)?.code ?? 0;
					const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
					const text = exitCode !== 0
						? `[exit code ${exitCode}]\n${output || "(no output)"}`
						: output || "(no output)";
					resolve({
						content: [{ type: "text", text }],
						details: { exitCode },
					});
				});
			});
		},
	};
}

function loadConversationFromDir(dir: string): AgentMessage[] {
	const path = join(dir, "conversation.json");
	if (!existsSync(path)) return [];
	try {
		const data = readFileSync(path, "utf-8");
		return JSON.parse(data);
	} catch {
		return [];
	}
}

function saveConversationToDir(dir: string, messages: AgentMessage[]): void {
	const path = join(dir, "conversation.json");
	mkdirSync(dir, { recursive: true });
	const tmp = path + ".tmp";
	writeFileSync(tmp, JSON.stringify(messages), "utf-8");
	renameSync(tmp, path);
}

function deleteConversationFromDir(dir: string): void {
	const path = join(dir, "conversation.json");
	try { unlinkSync(path); } catch { /* ignore if doesn't exist */ }
}

/**
 * Rough token estimate: ~3.5 chars per token for English text mixed with code/JSON.
 */
function estimateTokens(messages: AgentMessage[]): number {
	const chars = JSON.stringify(messages).length;
	return Math.ceil(chars / 3.5);
}

const MAX_HISTORY_TOKENS = 24_000;
const MIN_TURNS_TO_KEEP = 2;

function trimConversation(messages: AgentMessage[]): AgentMessage[] {
	const tokens = estimateTokens(messages);
	if (tokens <= MAX_HISTORY_TOKENS) return messages;

	const turns: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user" && current.length > 0) {
			turns.push(current);
			current = [];
		}
		current.push(msg);
	}
	if (current.length > 0) turns.push(current);

	const originalCount = turns.length;
	while (turns.length > MIN_TURNS_TO_KEEP) {
		turns.shift();
		if (estimateTokens(turns.flat()) <= MAX_HISTORY_TOKENS) {
			const dropped = originalCount - turns.length;
			console.log(`Trimmed ${dropped} old turn(s) from conversation (${tokens} -> ~${estimateTokens(turns.flat())} tokens)`);
			return turns.flat();
		}
	}

	console.log(`Warning: conversation still ~${estimateTokens(turns.flat())} tokens after trimming to ${turns.length} turns`);
	return turns.flat();
}

export function initSharedServices(
	config: HomieConfig,
	onDelegationEvent?: DelegationEventCallback,
): SharedServices {
	const lxd = new LxdService({ remote: config.services.lxd.remote });
	const docker = new DockerService({ host: config.services.docker.host });

	const primaryHost = config.lab.hosts.find((h) => h.gpu) ?? config.lab.hosts[0];
	if (!primaryHost) {
		throw new Error("No hosts configured in config.yaml — at least one host is required for SSH access");
	}
	const ssh = new SshService({ host: primaryHost.address, user: primaryHost.ssh_user });

	const labStateServices: LabStateServices = {
		lxd,
		docker,
		hosts: config.lab.hosts,
		domain: config.lab.domain,
		hostIp: primaryHost.address,
		proxyRoutes: config.proxy?.routes,
	};

	const gitea = new GiteaService(config.gitea!);

	return { labStateServices, gitea, config, lxd, docker, ssh };
}

export function createHomieInstance(
	shared: SharedServices,
	dataDir: string,
	onDelegationEvent?: DelegationEventCallback,
): HomieInstance {
	const { config, labStateServices, gitea, lxd, docker, ssh } = shared;
	const model = getAgentModel(config, "homie");

	// Delegation event fan-out
	const delegationListeners = new Set<DelegationEventCallback>();
	if (onDelegationEvent) delegationListeners.add(onDelegationEvent);
	const delegationCallback: DelegationEventCallback = (specialist, task, event, delegationId) => {
		for (const fn of delegationListeners) fn(specialist, task, event, delegationId);
	};

	const mergePrSchema = Type.Object({
		pr_number: Type.Number({ description: "Pull request number to merge" }),
	});

	const tools = [
		createLabHealthTool(labStateServices),
		createListServicesTool(labStateServices),
		createDelegateTool(
			config,
			{
				termie: { lxd, docker, ssh },
				nixie: { ssh, gitea, repoDir: config.lab.repo_dir || "/var/lib/homie/repo" },
				doxie: { docker },
				jinxie: { docker, ssh, container: "nginx" },
			},
			delegationCallback,
		),
		createBashTool(),
		{
			name: "merge_pull_request",
			label: "Merge PR",
			description: "Merge a pull request on Gitea after reviewing it",
			parameters: mergePrSchema,
			execute: async (_id: string, params: Static<typeof mergePrSchema>) => {
				await gitea.mergePullRequest(params.pr_number);
				return {
					content: [{ type: "text" as const, text: `PR #${params.pr_number} merged successfully` }],
					details: {},
				};
			},
		},
	];

	const systemPrompt = buildSystemPrompt(config);

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm: (messages: AgentMessage[]) =>
			messages.filter(
				(m: AgentMessage): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
			),
		getApiKey: async (provider: string) => {
			if (provider === "openai-compatible") return "none";
			return process.env.ANTHROPIC_API_KEY ?? process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
		},
	});

	mkdirSync(dataDir, { recursive: true });

	// Restore persisted conversation
	const savedMessages = loadConversationFromDir(dataDir);
	if (savedMessages.length > 0) {
		agent.replaceMessages(savedMessages);
		console.log(`Restored ${savedMessages.length} messages from previous session`);
	}

	// Save conversation after each completed interaction
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "agent_end") {
			const messages = agent.state.messages.filter(
				(m: any) => m.stopReason !== "aborted" && m.stopReason !== "error",
			);
			saveConversationToDir(dataDir, [...messages]);
		}
	});

	let promptQueue: Promise<void> = Promise.resolve();
	let busy = false;

	return {
		agent,
		subscribe: (fn) => agent.subscribe(fn),
		abort: () => agent.abort(),
		reset: () => {
			agent.reset();
			promptQueue = Promise.resolve();
			busy = false;
			deleteConversationFromDir(dataDir);
		},
		subscribeDelegation: (fn: DelegationEventCallback) => {
			delegationListeners.add(fn);
			return () => { delegationListeners.delete(fn); };
		},
		prompt: (message: string) => {
			const task = promptQueue.then(async () => {
				busy = true;
				try {
					const trimmed = trimConversation([...agent.state.messages]);
					if (trimmed.length < agent.state.messages.length) {
						agent.replaceMessages(trimmed);
					}

					const labState = getCachedLabState();
					const prompt = buildSystemPrompt(config, labState ? formatLabState(labState) : undefined);
					agent.setSystemPrompt(prompt);
					await agent.prompt(message);
				} finally {
					busy = false;
				}
			});
			promptQueue = task.catch(() => {});
			return task;
		},
		getMessages: () => [...agent.state.messages],
		getLabState: async () => {
			return getCachedLabState() ?? await refreshLabState(labStateServices);
		},
		isBusy: () => busy,
	};
}

/** Backward-compatible wrapper that creates shared services + a single instance. */
export function createHomie(
	config: HomieConfig,
	onDelegationEvent?: DelegationEventCallback,
): HomieInstance {
	const shared = initSharedServices(config, onDelegationEvent);
	const dataDir = getDataDir(config);
	return createHomieInstance(shared, dataDir, onDelegationEvent);
}

export function buildSystemPrompt(config: HomieConfig, labStateStr?: string): string {
	const hostList = config.lab.hosts
		.map((h) => `- ${h.name} (${h.address})${h.gpu ? " [GPU]" : ""}`)
		.join("\n");

	const domain = config.lab.domain;
	const proxyInfo = `
## Subdomains
Domain: ${domain}
nginx is managed declaratively in spark.nix via services.nginx.virtualHosts.
When linking to services, use subdomains (e.g., http://chat.${domain}/) not IP:port.
To add a new subdomain, delegate to Nixie — she'll add a virtualHost entry to spark.nix.`;

	return `You are Homie, a homelab assistant for ${config.lab.name}.

## CRITICAL RULES
1. After calling a tool and getting its result, respond with a SHORT text summary. Do NOT call another tool unless absolutely necessary.
2. For "check lab health" or "status" — call lab_health ONCE, then summarize the result. Done.
3. For "list services" — call list_services ONCE, then summarize. Done.
4. Only delegate to specialists for complex multi-step tasks (debugging, config changes). Simple status checks do NOT need delegation.
5. Never narrate reasoning. Just give the answer.
6. Never wrap your answer in quotation marks.

## Tools
- **lab_health**: Check health of all hosts, containers, and services
- **list_services**: List running services and nginx routes
- **delegate**: Send a task to a specialist (nixie, termie, doxie, or jinxie)
- **merge_pull_request**: Merge a PR on Gitea (use after reviewing the diff)
- **bash**: Run quick commands on the local host

## Specialists (for delegation only)
- **Nixie**: Infrastructure deployment — edits machines/spark.nix in the repo and pushes to Gitea to deploy services declaratively via system-manager. **Use Nixie to deploy, add, remove, or modify any service.**
- **Termie**: Terminal debugging — SSH exec, container exec, logs
- **Doxie**: Docker inspection — docker ps/logs/exec, GPU status. Use for checking existing containers and debugging, NOT for deploying new services.
- **Jinxie**: nginx debugging — check nginx status, logs, test configs. Standard subdomain routing is managed declaratively in spark.nix.
${proxyInfo}

## Deploying Services
When asked to deploy, install, or add a service, ALWAYS delegate to **Nixie**. Nixie edits the Nix config and pushes to Gitea, which triggers automatic deployment via the overseer.

## Reviewing PRs
When asked to review a PR (via the REVIEW PR prompt), do NOT delegate — review it yourself:
- Read the diff carefully
- If it looks correct → call \`merge_pull_request\` to merge it
- If something is wrong → delegate to Nixie to fix the issue on the PR branch
This is YOUR responsibility, not a specialist's.

## Response Format
Always end with a direct text answer. Example:
User: "check lab health"
→ Call lab_health → All systems healthy. dgx-spark UP with GPU. 2 containers running.

## Lab
Hosts:
${hostList}

${labStateStr ? `## Current Lab State\n${labStateStr}` : ""}`;
}
