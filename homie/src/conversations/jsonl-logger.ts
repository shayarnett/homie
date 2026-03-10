import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

/**
 * Writes agent events to a JSONL file for AgentsView compatibility.
 *
 * Format: one JSON object per line with fields:
 *   type, uuid, parentUuid, sessionId, timestamp, message/toolName/args/result
 *
 * AgentsView can parse this with a homie-specific parser, or we can adapt
 * the format to match Claude Code's JSONL schema for out-of-the-box support.
 */
export class JsonlLogger {
	private filePath: string;
	private sessionId: string;
	private lastAssistantUuid: string | undefined;
	private lastUserUuid: string | undefined;

	constructor(dir: string, sessionId: string) {
		this.sessionId = sessionId;
		mkdirSync(dir, { recursive: true });
		this.filePath = join(dir, "session.jsonl");
	}

	private write(entry: Record<string, unknown>): void {
		const line = JSON.stringify(entry) + "\n";
		appendFileSync(this.filePath, line, "utf-8");
	}

	logSessionStart(title: string, source: string): void {
		this.write({
			type: "summary",
			sessionId: this.sessionId,
			timestamp: new Date().toISOString(),
			title,
			source,
		});
	}

	logUserMessage(text: string): void {
		const uuid = randomUUID();
		this.lastUserUuid = uuid;
		this.write({
			type: "user",
			uuid,
			sessionId: this.sessionId,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text }],
			},
		});
	}

	logAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_end": {
				const msg = event.message as any;
				if (msg.role === "assistant") {
					const uuid = randomUUID();
					this.lastAssistantUuid = uuid;
					this.write({
						type: "assistant",
						uuid,
						parentUuid: this.lastUserUuid,
						sessionId: this.sessionId,
						timestamp: new Date().toISOString(),
						message: {
							role: "assistant",
							content: msg.content,
						},
					});
				}
				break;
			}
			case "tool_execution_start": {
				this.write({
					type: "tool_call",
					uuid: event.toolCallId ?? randomUUID(),
					parentUuid: this.lastAssistantUuid,
					sessionId: this.sessionId,
					timestamp: new Date().toISOString(),
					toolName: event.toolName,
					args: event.args,
				});
				break;
			}
			case "tool_execution_end": {
				this.write({
					type: "tool_result",
					uuid: randomUUID(),
					parentUuid: event.toolCallId,
					sessionId: this.sessionId,
					timestamp: new Date().toISOString(),
					toolName: event.toolName,
					isError: event.isError,
					result: typeof event.result === "string"
						? event.result
						: event.result?.content
							?.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("\n") ?? "",
				});
				break;
			}
		}
	}
}
