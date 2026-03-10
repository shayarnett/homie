import { createInterface } from "readline";
import type { ConversationManager } from "./conversations/manager.js";
import type { HomieInstance } from "./orchestrator/homie.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { extractResponseText, stripLeakedThinking } from "./util.js";

export function startCli(manager: ConversationManager, initialPrompt?: string): void {
	// Use first existing conversation or create a new one for CLI mode
	const convs = manager.list();
	const convId = convs.length > 0
		? convs[0].id
		: manager.create({ title: "CLI session" }).id;
	const homie = manager.get(convId);

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const debug = process.argv.includes("--debug");

	let streamBuffer = "";
	let streamPrintedLen = 0;
	let didStream = false;
	let streamSuppressed = false;

	function resetStreamState() {
		streamBuffer = "";
		streamPrintedLen = 0;
		didStream = false;
		streamSuppressed = false;
	}

	function looksLikeToolCallJson(text: string): boolean {
		const trimmed = text.trim();
		if (trimmed.startsWith('<tool_call>')) return true;
		if (trimmed.startsWith('{')) {
			const compact = trimmed.replace(/\s+/g, '');
			if (compact.startsWith('{"name"')) return true;
		}
		return false;
	}

	homie.subscribe((event: AgentEvent) => {
		if (debug) {
			const e = event as any;
			if (event.type === "message_end") {
				const blocks = e.message?.content?.map((c: any) => {
					if (c.type === "thinking") return { type: "thinking", len: c.thinking?.length };
					if (c.type === "text") return { type: "text", text: c.text?.substring(0, 120) };
					if (c.type === "toolCall") return { type: "toolCall", name: c.name, args: c.arguments };
					return { type: c.type };
				});
				console.log(`[${event.type}] role=${e.message?.role} content=${JSON.stringify(blocks)}`);
			} else if (event.type !== "message_update" && event.type !== "message_start") {
				console.log(`[${event.type}]`, event.type === "agent_end" ? `(${e.messages?.length} msgs)` : "");
			}
		}

		switch (event.type) {
			case "agent_start":
				process.stdout.write("\n[thinking...]\n");
				break;
			case "message_update": {
				const ame = (event as any).assistantMessageEvent;
				if (ame?.type === "text_delta") {
					streamBuffer += ame.delta;

					if (streamSuppressed) break;

					if (!didStream) {
						const trimmed = streamBuffer.trim();
						if (trimmed.length < 15) break;
						if (looksLikeToolCallJson(trimmed)) {
							streamSuppressed = true;
							break;
						}
						process.stdout.write("\nHomie: ");
						didStream = true;
					}

					const cleaned = stripLeakedThinking(streamBuffer);
					if (cleaned.length > streamPrintedLen) {
						process.stdout.write(cleaned.substring(streamPrintedLen));
						streamPrintedLen = cleaned.length;
					}
				}
				break;
			}
			case "tool_execution_start":
				if (didStream) {
					process.stdout.write("\n");
				}
				resetStreamState();
				process.stdout.write(`  -> ${event.toolName}`);
				if (event.args?.task) process.stdout.write(`: ${event.args.task}`);
				if (event.args?.command) process.stdout.write(`: ${event.args.command}`);
				process.stdout.write("\n");
				break;
			case "tool_execution_end":
				if (event.isError) {
					process.stdout.write(`  <- ERROR (${event.toolName}): ${extractText(event.result)}\n`);
				}
				break;
			case "message_end": {
				const msg = event.message as any;
				if (debug) {
					console.log(`[msg] role=${msg.role} content=${JSON.stringify(msg.content?.map((c: any) => ({ type: c.type, text: c.text?.substring(0, 100), thinking: c.thinking?.substring(0, 50) })))}`);
				}
				if (msg.role === "assistant") {
					if (didStream) {
						process.stdout.write("\n\n");
						resetStreamState();
					} else {
						resetStreamState();
						const hasToolCalls = (msg.content || []).some((c: any) => c.type === "toolCall");
						if (!hasToolCalls) {
							const texts = extractResponseText(msg.content || []);
							if (texts.length > 0) {
								console.log(`\nHomie: ${texts.join("\n")}\n`);
							}
						}
					}
				}
				break;
			}
		}
	});

	console.log("Homie CLI - type your message (Ctrl+C to exit)\n");

	const promptUser = () => {
		rl.question("You: ", async (input) => {
			const text = input.trim();
			if (!text) {
				promptUser();
				return;
			}

			try {
				await homie.prompt(text);
			} catch (error) {
				resetStreamState();
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`Error: ${msg}\n`);
			}

			promptUser();
		});
	};

	if (initialPrompt) {
		console.log(`You: ${initialPrompt}`);
		homie.prompt(initialPrompt).catch((error) => {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`Error: ${msg}\n`);
		}).then(() => promptUser());
	} else {
		promptUser();
	}
}

function extractText(result: any): string {
	if (!result) return "";
	if (typeof result === "string") return result;
	if (result.content && Array.isArray(result.content)) {
		return result.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return JSON.stringify(result);
}
