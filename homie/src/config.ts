import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { getModel, type Model, type Api, type OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { SpecialistName } from "./types.js";

export interface HostConfig {
	name: string;
	address: string;
	ssh_user: string;
	gpu?: boolean;
}

export interface AgentModelConfig {
	model: string;
	endpoint?: string;
}

export interface LxdConfig {
	remote: string;
}

export interface DockerConfig {
	host: string;
}

export interface ProxyRoute {
	subdomain: string;
	port: number;
	container?: string;
}

export interface GiteaConfig {
	url: string;
	token: string;
	org: string;
	repo: string;
}

export interface HomieConfig {
	lab: {
		name: string;
		domain: string;
		hosts: HostConfig[];
		repo_dir?: string;
	};
	agents: Record<string, AgentModelConfig>;
	services: {
		lxd: LxdConfig;
		docker: DockerConfig;
	};
	gitea?: GiteaConfig;
	proxy?: {
		routes?: ProxyRoute[];
	};
	data_dir: string;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".homie", "config.yaml");

export function loadConfig(configPath?: string): HomieConfig {
	const path = configPath ?? DEFAULT_CONFIG_PATH;
	if (!existsSync(path)) {
		throw new Error(`Config file not found: ${path}`);
	}
	const raw = readFileSync(path, "utf-8");
	const config = parseYaml(raw) as HomieConfig;

	// Resolve ~ in paths
	if (config.data_dir?.startsWith("~")) {
		config.data_dir = config.data_dir.replace("~", homedir());
	}
	return config;
}

/**
 * Resolve a model from config. Known providers use pi-ai's getModel().
 * OpenAI-compatible endpoints construct a custom Model object.
 */
export function resolveModel(agentConfig: AgentModelConfig): Model<Api> {
	const [provider, ...rest] = agentConfig.model.split("/");
	const modelId = rest.join("/");

	if (provider === "openai-compatible") {
		if (!agentConfig.endpoint) {
			throw new Error(`openai-compatible model "${agentConfig.model}" requires an endpoint`);
		}
		const isGlm = modelId.toLowerCase().includes("glm");
		const isQwen = !isGlm; // default to qwen compat for non-GLM models
		return {
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: "openai-compatible",
			baseUrl: agentConfig.endpoint,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 2048,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				requiresToolResultName: false,
				requiresAssistantAfterToolResult: false,
				requiresThinkingAsText: isQwen,
				thinkingFormat: isGlm ? "zai" : "qwen",
				supportsStrictMode: false,
				...(isQwen ? { chatTemplateKwargs: { enable_thinking: true, thinking_budget: 200 } } : {}),
			} satisfies OpenAICompletionsCompat,
		} satisfies Model<"openai-completions">;
	}

	// Known provider — use pi-ai registry
	const model = getModel(provider as any, modelId as any);
	if (!model) {
		throw new Error(`Unknown model: ${agentConfig.model}`);
	}
	return model;
}

export function getAgentModel(config: HomieConfig, agentName: string): Model<Api> {
	const agentConfig = config.agents[agentName];
	if (!agentConfig) {
		throw new Error(`No config for agent: ${agentName}`);
	}
	return resolveModel(agentConfig);
}

export function getDataDir(config: HomieConfig): string {
	return config.data_dir || join(homedir(), ".homie");
}
