import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import { runSpecialist, type SpecialistConfig } from "../specialists/runner.js";
import { createTermieConfig, type TermieServices } from "../specialists/termie.js";
import { createNixieConfig, type NixieServices } from "../specialists/nixie.js";
import { createDoxieConfig, type DoxieServices } from "../specialists/doxie.js";
import { createJinxieConfig, type JinxieServices } from "../specialists/jinxie.js";
import type { HomieConfig } from "../config.js";
import { resolveModel } from "../config.js";
import type { SpecialistName } from "../types.js";

const delegateSchema = Type.Object({
	specialist: Type.Union([Type.Literal("nixie"), Type.Literal("termie"), Type.Literal("doxie"), Type.Literal("jinxie")], {
		description: "Which specialist to delegate to",
	}),
	task: Type.String({ description: "The task for the specialist to perform" }),
	context: Type.Optional(Type.String({ description: "Additional context to provide to the specialist" })),
});

export interface DelegateServices {
	termie: TermieServices;
	nixie: NixieServices;
	doxie: DoxieServices;
	jinxie: JinxieServices;
}

export type DelegationEventCallback = (
	specialist: SpecialistName,
	task: string,
	event: AgentEvent,
	delegationId: string,
) => void;

const ALL_SPECIALISTS: SpecialistName[] = ["nixie", "termie", "doxie", "jinxie"];

const specialistDescriptions: Record<SpecialistName, string> = {
	nixie: "Infrastructure deployment (edit nix config, deploy services via Gitea + system-manager)",
	termie: "Terminal debugging (ssh exec, container exec, logs)",
	doxie: "Docker inspection & GPU (docker ps/logs/exec, nvidia-smi). NOT for deploying new services.",
	jinxie: "nginx configuration (reverse proxy, server blocks, SSL, reload)",
};

function buildSpecialistConfig(
	specialist: SpecialistName,
	config: HomieConfig,
	services: DelegateServices,
): SpecialistConfig {
	const agentConfig = config.agents[specialist];
	if (!agentConfig) {
		throw new Error(`No config for specialist: ${specialist}`);
	}
	const model = resolveModel(agentConfig);

	switch (specialist) {
		case "termie":
			return createTermieConfig(model, services.termie);
		case "nixie":
			return createNixieConfig(model, services.nixie);
		case "doxie":
			return createDoxieConfig(model, services.doxie);
		case "jinxie":
			return createJinxieConfig(model, services.jinxie);
		default:
			throw new Error(`Unknown specialist: ${specialist}`);
	}
}

function createDelegateToolForAgent(
	config: HomieConfig,
	services: DelegateServices,
	onDelegationEvent: DelegationEventCallback | undefined,
	exclude: SpecialistName,
	depth: number,
): AgentTool<any> {
	const available = ALL_SPECIALISTS.filter((s) => s !== exclude);
	const desc = available.map((s) => `- ${s}: ${specialistDescriptions[s]}`).join("\n");
	const schema = Type.Object({
		specialist: Type.Union(available.map((s) => Type.Literal(s)) as any, {
			description: "Which specialist to delegate to",
		}),
		task: Type.String({ description: "The task for the specialist to perform" }),
		context: Type.Optional(Type.String({ description: "Additional context to provide to the specialist" })),
	});

	return {
		name: "delegate",
		label: "Delegate to Specialist",
		description: `Delegate a task to another specialist:\n${desc}\n\nThe specialist runs the task autonomously and returns a result.`,
		parameters: schema,
		execute: async (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
			return executeDelegation(config, services, onDelegationEvent, params, id, signal, onUpdate, depth);
		},
	};
}

const MAX_DELEGATION_DEPTH = 2;

async function executeDelegation(
	config: HomieConfig,
	services: DelegateServices,
	onDelegationEvent: DelegationEventCallback | undefined,
	params: { specialist: SpecialistName; task: string; context?: string },
	id: string,
	signal?: AbortSignal,
	onUpdate?: any,
	depth: number = 0,
) {
	const { specialist, task, context } = params;

	const specialistConfig = buildSpecialistConfig(specialist, config, services);

	// Inject delegate tool so specialists can sub-delegate (up to max depth)
	// Route sub-delegation events to the parent delegation card in the UI
	if (depth < MAX_DELEGATION_DEPTH) {
		const parentOnDelegationEvent: DelegationEventCallback | undefined = onDelegationEvent
			? (subSpecialist, subTask, event, _subId) => onDelegationEvent(subSpecialist, subTask, event, id)
			: undefined;
		specialistConfig.tools.push(
			createDelegateToolForAgent(config, services, parentOnDelegationEvent, specialist, depth + 1),
		);
	}

	// Relay progress updates (id = delegate tool call ID for routing)
	const onEvent = (event: AgentEvent) => {
		onDelegationEvent?.(specialist, task, event, id);

		// Stream text updates back via onUpdate
		if (onUpdate && event.type === "message_end" && "message" in event) {
			const msg = event.message;
			if (msg.role === "assistant") {
				const texts = (msg.content as any[])
					.filter((c) => c.type === "text")
					.map((c) => c.text);
				if (texts.length > 0) {
					onUpdate({
						content: [{ type: "text", text: `[${specialist}] ${texts.join("\n")}` }],
						details: { specialist, event: event.type },
					});
				}
			}
		}
	};

	const result = await runSpecialist(specialistConfig, task, context, onEvent, signal);

	const statusPrefix = result.success ? "Completed" : "Failed";
	const output = `[${specialist}] ${statusPrefix}: ${result.output}`;

	return {
		content: [{ type: "text" as const, text: output }],
		details: {
			specialist,
			task,
			success: result.success,
			eventCount: result.events.length,
		},
	};
}

export function createDelegateTool(
	config: HomieConfig,
	services: DelegateServices,
	onDelegationEvent?: DelegationEventCallback,
): AgentTool<typeof delegateSchema> {
	return {
		name: "delegate",
		label: "Delegate to Specialist",
		description: `Delegate a task to a specialist agent:
${ALL_SPECIALISTS.map((s) => `- ${s}: ${specialistDescriptions[s]}`).join("\n")}

The specialist runs the task autonomously and returns a result.`,
		parameters: delegateSchema,
		execute: async (id: string, params: Static<typeof delegateSchema>, signal?: AbortSignal, onUpdate?: any) => {
			return executeDelegation(config, services, onDelegationEvent, params, id, signal, onUpdate, 0);
		},
	};
}
