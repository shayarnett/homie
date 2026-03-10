import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getCachedLabState, refreshLabState, type LabStateServices } from "./lab-state.js";

const schema = Type.Object({});

export function createListServicesTool(services: LabStateServices): AgentTool<typeof schema> {
	return {
		name: "list_services",
		label: "List Services",
		description: "List all running services and nginx routes in the lab. Uses cached state if recent, otherwise refreshes.",
		parameters: schema,
		execute: async () => {
			const state = getCachedLabState() ?? await refreshLabState(services);
			const lines: string[] = [];

			if (state.services.length === 0) {
				lines.push("No nginx routes configured.");
			} else {
				lines.push("## Nginx Routes");
				for (const s of state.services) {
					lines.push(`- ${s.subdomain} -> ${s.upstream}:${s.port}`);
				}
			}

			if (state.containers.length > 0) {
				lines.push("\n## Running Containers");
				for (const c of state.containers) {
					if (c.status.toLowerCase().includes("running") || c.status.toLowerCase().includes("up")) {
						lines.push(`- [${c.type}] ${c.name}${c.ip ? ` (${c.ip})` : ""}`);
					}
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") || "No services found." }],
				details: { services: state.services, containers: state.containers },
			};
		},
	};
}
