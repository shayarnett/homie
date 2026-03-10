#!/usr/bin/env node

import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { loadConfig, getDataDir } from "./config.js";
import { createConversationManager } from "./conversations/manager.js";
import { startServer } from "./server/index.js";
import { startCli } from "./cli.js";
import { GiteaService } from "./services/gitea.js";
import type { SpecialistName } from "./types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

const args = process.argv.slice(2);
const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
const promptArg = args.find((a) => a.startsWith("--prompt="))?.split("=").slice(1).join("=");
const wantsCli = args.includes("--cli") || !!promptArg;
const wantsServer = args.includes("--server");
const mode = wantsCli && wantsServer ? "both" : wantsCli ? "cli" : wantsServer ? "server" : "both";
const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "3456", 10);
const host = args.find((a) => a.startsWith("--host="))?.split("=")[1] ?? "localhost";

async function main() {
	console.log("Loading config...");
	const config = loadConfig(configPath);

	const dataDir = getDataDir(config);
	mkdirSync(dataDir, { recursive: true });

	console.log(`Lab: ${config.lab.name} (${config.lab.domain})`);
	console.log(`Hosts: ${config.lab.hosts.map((h) => h.name).join(", ")}`);
	console.log(`Data dir: ${dataDir}`);

	const onDelegationEvent = (specialist: SpecialistName, task: string, event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			console.log(`  [${specialist}] -> ${event.toolName}`);
		}
	};

	const manager = createConversationManager(config, onDelegationEvent);

	if (mode === "server" || mode === "both") {
		const staticDir = join(import.meta.dirname, "..", "static");
		const gitea = config.gitea
			? new GiteaService(config.gitea)
			: undefined;
		if (gitea) {
			console.log(`Gitea webhook: listening for issues from ${config.gitea!.url}`);
		}
		startServer({ port, host, staticDir, gitea }, manager);
	}

	if (mode === "cli" || mode === "both") {
		startCli(manager, promptArg);
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
