import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, Api, Message } from "@mariozechner/pi-ai";
import { stripLeakedThinking } from "../util.js";

export interface SpecialistConfig {
	name: string;
	systemPrompt: string;
	model: Model<Api>;
	tools: AgentTool<any>[];
	apiKey?: string;
	/** At least one of these tools MUST be called for the task to count as successful */
	requiredTools?: string[];
}

export interface SpecialistResult {
	success: boolean;
	output: string;
	events: AgentEvent[];
}

/**
 * Run a specialist agent ephemerally: create Agent, run prompt, collect result.
 * The onEvent callback relays progress to the orchestrator/UI.
 */
export async function runSpecialist(
	config: SpecialistConfig,
	task: string,
	context?: string,
	onEvent?: (event: AgentEvent) => void,
	signal?: AbortSignal,
): Promise<SpecialistResult> {
	const events: AgentEvent[] = [];

	const agent = new Agent({
		initialState: {
			systemPrompt: config.systemPrompt,
			model: config.model,
			thinkingLevel: "off",
			tools: config.tools,
		},
		convertToLlm: (messages: AgentMessage[]) =>
			messages.filter(
				(m: AgentMessage): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
			),
		getApiKey: async (provider: string) => {
			if (config.apiKey) return config.apiKey;
			if (provider === "openai-compatible") return "none";
			return process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
		},
	});

	// Forward parent abort signal to specialist agent
	if (signal) {
		if (signal.aborted) {
			return { success: false, output: "Error: Aborted before start", events };
		}
		signal.addEventListener("abort", () => agent.abort(), { once: true });
	}

	const toolsCalled = new Set<string>();
	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		events.push(event);
		if (event.type === "tool_execution_start") {
			toolsCalled.add(event.toolName);
		}
		onEvent?.(event);
	});

	try {
		const prompt = context ? `${context}\n\n## Task\n${task}` : task;
		await agent.prompt(prompt);

		// Extract final text from the last assistant message
		const messages = agent.state.messages;
		const lastAssistant = messages
			.filter((m: AgentMessage) => m.role === "assistant")
			.pop();

		let output = "";
		if (lastAssistant && "content" in lastAssistant) {
			const textParts = (lastAssistant.content as any[])
				.filter((c) => c.type === "text")
				.map((c) => c.text);
			output = stripLeakedThinking(textParts.join("\n"));
		}

		// Validate at least one required tool was called
		if (config.requiredTools && config.requiredTools.length > 0) {
			const calledAny = config.requiredTools.some((t) => toolsCalled.has(t));
			if (!calledAny) {
				const msg = `FAILED: ${config.name} did not call any required tool (need one of: ${config.requiredTools.join(", ")}). Tools actually called: ${[...toolsCalled].join(", ") || "none"}`;
				console.error(`[${config.name}] ${msg}`);
				return { success: false, output: msg, events };
			}
		}

		return { success: true, output, events };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, output: `Error: ${message}`, events };
	} finally {
		unsubscribe();
	}
}
