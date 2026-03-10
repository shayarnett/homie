import type { IncomingMessage } from "http";
import type { WebSocket, WebSocketServer } from "ws";
import type { ConversationManager } from "../conversations/manager.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { stripLeakedThinking, extractResponseText } from "../util.js";

interface WsMessage {
	type: string;
	[key: string]: any;
}

/** Per-client state */
interface ClientState {
	conversationId: string | null;
	unsubAgent: (() => void) | null;
	unsubDelegation: (() => void) | null;
}

/** Send an event to all connected WS clients that are on the same conversation. */
function broadcastToConversation(
	wss: WebSocketServer,
	conversationId: string,
	data: any,
	exclude?: WebSocket,
): void {
	const json = JSON.stringify(data);
	for (const client of wss.clients) {
		if (client !== exclude && client.readyState === 1) {
			const state = (client as any).__homieState as ClientState | undefined;
			if (state?.conversationId === conversationId) {
				client.send(json);
			}
		}
	}
}

export function handleWebSocket(
	ws: WebSocket,
	_req: IncomingMessage,
	manager: ConversationManager,
	wss: WebSocketServer,
): void {
	const clientState: ClientState = {
		conversationId: null,
		unsubAgent: null,
		unsubDelegation: null,
	};
	(ws as any).__homieState = clientState;

	// Send conversation list on connect
	sendEvent(ws, { type: "conversation_list", conversations: manager.list() });

	// Send lab state on connect
	manager.getLabState().then((state) => {
		sendEvent(ws, { type: "lab_state", state });
	}).catch(() => {});

	function joinConversation(conversationId: string): void {
		// Unsubscribe from previous conversation
		leaveConversation();

		clientState.conversationId = conversationId;

		const homie = manager.get(conversationId);

		clientState.unsubAgent = homie.subscribe((event: AgentEvent) => {
			sendEvent(ws, { ...mapAgentEvent(event), conversationId });
		});

		clientState.unsubDelegation = homie.subscribeDelegation((specialist, task, event, delegationId) => {
			sendEvent(ws, {
				type: "delegation_event",
				specialist,
				task,
				delegationId,
				conversationId,
				event: mapAgentEvent(event),
			});
		});

		// Send joined first so client resets state, then history, then busy status
		sendEvent(ws, { type: "joined", conversationId });

		const history = buildHistory(homie.getMessages());
		sendEvent(ws, { type: "history", messages: history, conversationId });

		if (homie.isBusy()) {
			sendEvent(ws, { type: "status", busy: true, conversationId });
		}
	}

	function leaveConversation(): void {
		if (clientState.unsubAgent) {
			clientState.unsubAgent();
			clientState.unsubAgent = null;
		}
		if (clientState.unsubDelegation) {
			clientState.unsubDelegation();
			clientState.unsubDelegation = null;
		}
		clientState.conversationId = null;
	}

	ws.on("message", async (data) => {
		let msg: WsMessage;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			sendEvent(ws, { type: "error", message: "Invalid JSON" });
			return;
		}

		// Join a conversation
		if (msg.type === "join") {
			const id = msg.conversationId as string;
			if (!id) {
				sendEvent(ws, { type: "error", message: "Missing conversationId" });
				return;
			}
			try {
				joinConversation(id);
			} catch (error) {
				sendEvent(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// Create a new conversation and join it
		if (msg.type === "create") {
			const meta = manager.create({ title: msg.title || "New conversation" });
			// Broadcast updated list to all clients
			broadcastConversationList(wss, manager);
			joinConversation(meta.id);
			return;
		}

		// Delete a conversation
		if (msg.type === "delete") {
			const id = msg.conversationId as string;
			if (!id) return;
			if (clientState.conversationId === id) {
				leaveConversation();
			}
			manager.remove(id);
			broadcastConversationList(wss, manager);
			sendEvent(ws, { type: "deleted", conversationId: id });
			return;
		}

		// Rename a conversation
		if (msg.type === "rename") {
			const id = msg.conversationId as string;
			const title = msg.title as string;
			if (id && title) {
				manager.updateTitle(id, title);
				broadcastConversationList(wss, manager);
			}
			return;
		}

		// List conversations
		if (msg.type === "list") {
			sendEvent(ws, { type: "conversation_list", conversations: manager.list() });
			return;
		}

		// Stop current agent run
		if (msg.type === "stop") {
			if (clientState.conversationId) {
				try {
					manager.get(clientState.conversationId).abort();
				} catch { /* ignore */ }
			}
			return;
		}

		// Clear conversation
		if (msg.type === "clear") {
			if (clientState.conversationId) {
				const id = clientState.conversationId;
				try {
					const homie = manager.get(id);
					homie.abort();
					homie.reset();
					sendEvent(ws, { type: "cleared", conversationId: id });
					broadcastToConversation(wss, id, { type: "cleared", conversationId: id }, ws);
				} catch { /* ignore */ }
			}
			return;
		}

		// Chat message
		if (msg.type === "chat") {
			const text = msg.text as string;
			if (!text) {
				sendEvent(ws, { type: "error", message: "Missing text" });
				return;
			}

			// Auto-create and join a conversation if not in one
			if (!clientState.conversationId) {
				const meta = manager.create({ title: text.slice(0, 60) });
				broadcastConversationList(wss, manager);
				joinConversation(meta.id);
			}

			const convId = clientState.conversationId!;

			// Broadcast user message to other clients in the same conversation
			broadcastToConversation(wss, convId, { type: "user_message", text, conversationId: convId }, ws);

			// Auto-title: if first message, use it as title
			const homie = manager.get(convId);
			if (homie.getMessages().length === 0) {
				const title = text.length > 60 ? text.slice(0, 57) + "..." : text;
				manager.updateTitle(convId, title);
				broadcastConversationList(wss, manager);
			}

			try {
				await homie.prompt(text);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== "Request was aborted") {
					sendEvent(ws, { type: "error", message, conversationId: convId });
				}
			}
		}
	});

	ws.on("error", (err) => {
		console.error("[ws] socket error:", err.message);
	});

	ws.on("close", () => {
		leaveConversation();
	});
}

function broadcastConversationList(wss: WebSocketServer, manager: ConversationManager): void {
	const data = JSON.stringify({ type: "conversation_list", conversations: manager.list() });
	for (const client of wss.clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

function sendEvent(ws: WebSocket, data: any): void {
	if (ws.readyState === 1 /* OPEN */) {
		ws.send(JSON.stringify(data));
	}
}

function buildHistory(messages: any[]): any[] {
	const history: any[] = [];
	const toolCallMap = new Map<string, { name: string; args: any }>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const texts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.filter((t: string) => t && t.length > 0);
			if (texts.length > 0) {
				history.push({ role: "user", text: texts.join("\n") });
			}
		} else if (msg.role === "assistant") {
			const texts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => stripLeakedThinking(c.text))
				.filter((t: string) => t.length > 0);

			const toolCalls = (msg.content || [])
				.filter((c: any) => c.type === "toolCall")
				.map((c: any) => {
					if (c.id) toolCallMap.set(c.id, { name: c.name, args: c.arguments });
					return { id: c.id, name: c.name, args: c.arguments };
				});

			if (texts.length > 0) {
				history.push({ role: "assistant", text: texts.join("\n") });
			}
			for (const tc of toolCalls) {
				history.push({ role: "toolCall", toolName: tc.name, args: tc.args, toolCallId: tc.id });
			}
			if (texts.length === 0 && toolCalls.length === 0) {
				const fallback = extractResponseText(msg.content || []);
				if (fallback.length > 0) {
					history.push({ role: "assistant", text: fallback.join("\n") });
				}
			}
		} else if (msg.role === "toolResult") {
			const texts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.filter((t: string) => t && t.length > 0);
			if (texts.length > 0) {
				const toolInfo = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
				history.push({
					role: "tool",
					toolName: toolInfo?.name,
					toolCallId: msg.toolCallId,
					text: texts.join("\n"),
					isError: msg.isError ?? false,
				});
			}
		}
	}
	return history;
}

function mapAgentEvent(event: AgentEvent): WsMessage {
	switch (event.type) {
		case "agent_start":
			return { type: "thinking" };
		case "agent_end":
			return { type: "agent_end" };
		case "tool_execution_start":
			return {
				type: "tool_start",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				args: event.args,
			};
		case "tool_execution_update":
			return {
				type: "tool_update",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				type: "tool_end",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				result: event.result,
				isError: event.isError,
			};
		case "message_start":
			return { type: event.type, message: event.message };
		case "message_update": {
			const ame = event.assistantMessageEvent;
			const base: WsMessage = { type: "message_update", message: event.message };
			if (ame.type === "text_delta") {
				base.delta = stripLeakedThinking(ame.delta);
				base.deltaType = "text";
			} else if (ame.type === "thinking_delta") {
				base.delta = ame.delta;
				base.deltaType = "thinking";
			} else if (ame.type === "text_start" || ame.type === "text_end" ||
				ame.type === "thinking_start" || ame.type === "thinking_end") {
				base.deltaType = ame.type;
			}
			return base;
		}
		case "message_end": {
			const msg = event.message;
			if (msg.role === "assistant") {
				const hasToolCalls = msg.content.some((c: any) => c.type === "toolCall");

				const cleaned = msg.content
					.map((c: any) => {
						if (c.type === "text") {
							let text = stripLeakedThinking(c.text);
							if (hasToolCalls && text.length > 0) {
								const trimmed = text.trim();
								if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
									try {
										const parsed = JSON.parse(trimmed);
										if (parsed.name && parsed.arguments !== undefined) {
											return null;
										}
									} catch { /* not JSON, keep it */ }
								}
							}
							return text.length > 0 ? { type: "text", text } : null;
						}
						return c;
					})
					.filter(Boolean);

				const hasText = cleaned.some((c: any) => c.type === "text");
				if (!hasText) {
					const fallbackTexts = extractResponseText(msg.content);
					if (fallbackTexts.length > 0) {
						cleaned.push({ type: "text", text: fallbackTexts.join("\n") });
					}
				}

				return {
					type: "message_end",
					message: { role: msg.role, content: cleaned },
				};
			}
			return { type: event.type, message: msg };
		}
		default:
			return { type: event.type };
	}
}
