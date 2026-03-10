import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { HomieConfig } from "../config.js";
import { getDataDir } from "../config.js";
import { initSharedServices, createHomieInstance, type SharedServices, type HomieInstance } from "../orchestrator/homie.js";
import { JsonlLogger } from "./jsonl-logger.js";
import type { ConversationMeta, ConversationIndex, ConversationSource } from "./types.js";
import type { DelegationEventCallback } from "../orchestrator/delegate-tool.js";
import type { LabState } from "../types.js";

export interface ConversationManager {
	create: (opts?: { title?: string; source?: ConversationSource; sourceRef?: string }) => ConversationMeta;
	get: (id: string) => HomieInstance;
	getMeta: (id: string) => ConversationMeta | undefined;
	list: () => ConversationMeta[];
	remove: (id: string) => void;
	updateTitle: (id: string, title: string) => void;
	subscribe: (id: string, fn: (event: AgentEvent) => void) => () => void;
	subscribeDelegation: (id: string, fn: DelegationEventCallback) => () => void;
	getLabState: () => Promise<LabState>;
	shared: SharedServices;
}

function getConversationsDir(config: HomieConfig): string {
	return join(getDataDir(config), "conversations");
}

function getIndexPath(config: HomieConfig): string {
	return join(getConversationsDir(config), "index.json");
}

function loadIndex(config: HomieConfig): ConversationIndex {
	const path = getIndexPath(config);
	if (!existsSync(path)) return { conversations: [] };
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { conversations: [] };
	}
}

function saveIndex(config: HomieConfig, index: ConversationIndex): void {
	const dir = getConversationsDir(config);
	mkdirSync(dir, { recursive: true });
	const path = getIndexPath(config);
	const tmp = path + ".tmp";
	writeFileSync(tmp, JSON.stringify(index, null, 2), "utf-8");
	renameSync(tmp, path);
}

export function createConversationManager(
	config: HomieConfig,
	onDelegationEvent?: DelegationEventCallback,
): ConversationManager {
	const shared = initSharedServices(config, onDelegationEvent);
	const convDir = getConversationsDir(config);
	mkdirSync(convDir, { recursive: true });

	// In-memory cache of active HomieInstances
	const instances = new Map<string, HomieInstance>();
	const loggers = new Map<string, JsonlLogger>();
	let index = loadIndex(config);

	// Migrate legacy single conversation if it exists
	migrateLegacy(config, index);

	function getOrCreateInstance(id: string): HomieInstance {
		let inst = instances.get(id);
		if (inst) return inst;

		const meta = index.conversations.find((c) => c.id === id);
		if (!meta) throw new Error(`Conversation not found: ${id}`);

		const dataDir = join(convDir, id);
		inst = createHomieInstance(shared, dataDir, onDelegationEvent);

		// Attach JSONL logger
		const logger = new JsonlLogger(dataDir, id);
		loggers.set(id, logger);
		inst.subscribe((event: AgentEvent) => {
			logger.logAgentEvent(event);
		});

		// Wrap prompt to also log user messages to JSONL
		const origPrompt = inst.prompt;
		inst.prompt = (message: string) => {
			logger.logUserMessage(message);
			// Update conversation timestamp
			const m = index.conversations.find((c) => c.id === id);
			if (m) {
				m.updatedAt = new Date().toISOString();
				saveIndex(config, index);
			}
			return origPrompt(message);
		};

		instances.set(id, inst);
		return inst;
	}

	return {
		shared,

		create(opts) {
			const id = randomUUID();
			const now = new Date().toISOString();
			const meta: ConversationMeta = {
				id,
				title: opts?.title || "New conversation",
				source: opts?.source || "user",
				createdAt: now,
				updatedAt: now,
				sourceRef: opts?.sourceRef,
			};
			index.conversations.unshift(meta);
			saveIndex(config, index);

			// Initialize JSONL session
			const dataDir = join(convDir, id);
			mkdirSync(dataDir, { recursive: true });
			const logger = new JsonlLogger(dataDir, id);
			logger.logSessionStart(meta.title, meta.source);

			return meta;
		},

		get(id: string) {
			return getOrCreateInstance(id);
		},

		getMeta(id: string) {
			return index.conversations.find((c) => c.id === id);
		},

		list() {
			return [...index.conversations];
		},

		remove(id: string) {
			const inst = instances.get(id);
			if (inst) {
				inst.abort();
				inst.reset();
				instances.delete(id);
			}
			loggers.delete(id);
			index.conversations = index.conversations.filter((c) => c.id !== id);
			saveIndex(config, index);
			const dataDir = join(convDir, id);
			try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
		},

		updateTitle(id: string, title: string) {
			const meta = index.conversations.find((c) => c.id === id);
			if (meta) {
				meta.title = title;
				meta.updatedAt = new Date().toISOString();
				saveIndex(config, index);
			}
		},

		subscribe(id: string, fn: (event: AgentEvent) => void) {
			const inst = getOrCreateInstance(id);
			return inst.subscribe(fn);
		},

		subscribeDelegation(id: string, fn: DelegationEventCallback) {
			const inst = getOrCreateInstance(id);
			return inst.subscribeDelegation(fn);
		},

		async getLabState() {
			// Lab state is shared across all conversations
			const { getCachedLabState, refreshLabState } = await import("../orchestrator/lab-state.js");
			return getCachedLabState() ?? await refreshLabState(shared.labStateServices);
		},
	};
}

/** Migrate the old single conversation.json to the new multi-conversation structure. */
function migrateLegacy(config: HomieConfig, index: ConversationIndex): void {
	const legacyPath = join(getDataDir(config), "conversation.json");
	if (!existsSync(legacyPath)) return;
	if (index.conversations.length > 0) return; // Already migrated

	try {
		const data = readFileSync(legacyPath, "utf-8");
		const messages = JSON.parse(data);
		if (!Array.isArray(messages) || messages.length === 0) return;

		const id = randomUUID();
		const now = new Date().toISOString();
		const meta: ConversationMeta = {
			id,
			title: "Previous session",
			source: "user",
			createdAt: now,
			updatedAt: now,
		};

		const convDir = getConversationsDir(config);
		const dataDir = join(convDir, id);
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "conversation.json"), data, "utf-8");

		index.conversations.push(meta);
		saveIndex(config, index);
		console.log(`Migrated legacy conversation to ${id}`);
	} catch {
		// Ignore migration errors
	}
}
