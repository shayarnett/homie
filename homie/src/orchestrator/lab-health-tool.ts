import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { refreshLabState, formatLabState, type LabStateServices } from "./lab-state.js";

const schema = Type.Object({});

export function createLabHealthTool(services: LabStateServices): AgentTool<typeof schema> {
	return {
		name: "lab_health",
		label: "Lab Health Check",
		description: "Check the health of all lab hosts, containers, and services. Refreshes the cached lab state.",
		parameters: schema,
		execute: async () => {
			const state = await refreshLabState(services);
			const summary = formatLabState(state);
			return {
				content: [{ type: "text", text: summary }],
				details: state,
			};
		},
	};
}
