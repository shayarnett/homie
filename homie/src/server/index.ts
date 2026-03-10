import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname, resolve } from "path";
import { WebSocketServer } from "ws";
import type { ConversationManager } from "../conversations/manager.js";
import { handleWebSocket } from "./websocket.js";
import { extractResponseText } from "../util.js";
import type { GiteaService } from "../services/gitea.js";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
};

export interface ServerConfig {
	port: number;
	host: string;
	staticDir: string;
	gitea?: GiteaService;
}

function sendJson(res: ServerResponse, status: number, data: any): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
	});
	res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => resolve(body));
	});
}

export function startServer(config: ServerConfig, manager: ConversationManager): void {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		// ── Conversation CRUD ──

		// GET /api/conversations
		if (url.pathname === "/api/conversations" && req.method === "GET") {
			sendJson(res, 200, { conversations: manager.list() });
			return;
		}

		// POST /api/conversations
		if (url.pathname === "/api/conversations" && req.method === "POST") {
			try {
				const body = JSON.parse(await readBody(req));
				const meta = manager.create({
					title: body.title,
					source: body.source,
					sourceRef: body.sourceRef,
				});
				sendJson(res, 201, meta);
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// DELETE /api/conversations/:id
		const deleteMatch = url.pathname.match(/^\/api\/conversations\/([a-f0-9-]+)$/);
		if (deleteMatch && req.method === "DELETE") {
			manager.remove(deleteMatch[1]);
			sendJson(res, 200, { ok: true });
			return;
		}

		// PATCH /api/conversations/:id (rename)
		const patchMatch = url.pathname.match(/^\/api\/conversations\/([a-f0-9-]+)$/);
		if (patchMatch && req.method === "PATCH") {
			try {
				const body = JSON.parse(await readBody(req));
				if (body.title) {
					manager.updateTitle(patchMatch[1], body.title);
				}
				const meta = manager.getMeta(patchMatch[1]);
				sendJson(res, 200, meta ?? { error: "not found" });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// ── Legacy chat endpoint (uses first conversation or creates one) ──

		if (url.pathname === "/api/chat" && req.method === "POST") {
			try {
				const body = JSON.parse(await readBody(req));
				const { message, conversationId } = body;
				if (!message) {
					sendJson(res, 400, { error: "Missing message" });
					return;
				}

				const convId = conversationId || getOrCreateDefaultConversation(manager);
				const homie = manager.get(convId);

				await homie.prompt(message);

				const messages = homie.getMessages();
				const lastAssistant = messages
					.filter((m: any) => m.role === "assistant")
					.pop();

				let cleanedText = "";
				if (lastAssistant) {
					cleanedText = extractResponseText(lastAssistant.content || []).join("\n");
				}

				sendJson(res, 200, { messages, lastAssistant, text: cleanedText, conversationId: convId });
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// API: GET /api/lab-state
		if (url.pathname === "/api/lab-state" && req.method === "GET") {
			try {
				const state = await manager.getLabState();
				sendJson(res, 200, state);
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// API: POST /api/review-pr
		if (url.pathname === "/api/review-pr" && req.method === "POST") {
			try {
				const { pr_number } = JSON.parse(await readBody(req));
				if (!pr_number) {
					sendJson(res, 400, { error: "pr_number required" });
					return;
				}
				const meta = manager.create({
					title: `PR Review #${pr_number}`,
					source: "pr-review",
					sourceRef: String(pr_number),
				});
				sendJson(res, 202, { ok: true, message: "review started", conversationId: meta.id });
				handlePrReview(pr_number, meta.id, manager, config.gitea);
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// API: POST /api/ci-failed
		if (url.pathname === "/api/ci-failed" && req.method === "POST") {
			try {
				const { pr_number, error: ciError } = JSON.parse(await readBody(req));
				if (!pr_number) {
					sendJson(res, 400, { error: "pr_number required" });
					return;
				}
				const meta = manager.create({
					title: `CI Failed: PR #${pr_number}`,
					source: "ci-failure",
					sourceRef: String(pr_number),
				});
				sendJson(res, 202, { ok: true, message: "failure handling started", conversationId: meta.id });
				handleCiFailure(pr_number, ciError || "unknown error", meta.id, manager, config.gitea);
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// Webhook: Gitea issues
		if (url.pathname === "/api/webhook/gitea" && req.method === "POST") {
			try {
				const payload = JSON.parse(await readBody(req));
				const event = req.headers["x-gitea-event"] as string;
				handleGiteaWebhook(event, payload, manager, config.gitea);
				sendJson(res, 202, { ok: true });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// CORS preflight
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			});
			res.end();
			return;
		}

		// Static files
		let filePath = resolve(config.staticDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
		const resolvedStaticDir = resolve(config.staticDir);
		if (!filePath.startsWith(resolvedStaticDir + "/") && filePath !== resolvedStaticDir) {
			res.writeHead(403);
			res.end("Forbidden");
			return;
		}
		if (!existsSync(filePath)) {
			res.writeHead(404);
			res.end("Not Found");
			return;
		}

		const ext = extname(filePath);
		const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

		try {
			const content = readFileSync(filePath);
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		} catch {
			res.writeHead(500);
			res.end("Internal Server Error");
		}
	});

	// WebSocket
	const wss = new WebSocketServer({ server });
	wss.on("connection", (ws, req) => {
		handleWebSocket(ws, req, manager, wss);
	});

	server.listen(config.port, config.host, () => {
		console.log(`Homie server running at http://${config.host}:${config.port}`);
	});
}

function getOrCreateDefaultConversation(manager: ConversationManager): string {
	const convs = manager.list();
	if (convs.length > 0) return convs[0].id;
	const meta = manager.create({ title: "Chat" });
	return meta.id;
}

async function handlePrReview(
	prNumber: number,
	conversationId: string,
	manager: ConversationManager,
	gitea?: GiteaService,
): Promise<void> {
	if (!gitea) {
		console.error("[review-pr] No gitea service configured");
		return;
	}

	try {
		const pr = await gitea.getPullRequest(prNumber);
		const diff = await gitea.getPullRequestDiff(prNumber);

		const maxDiffLen = 8000;
		const truncatedDiff = diff.length > maxDiffLen
			? diff.slice(0, maxDiffLen) + `\n... (diff truncated, ${diff.length - maxDiffLen} chars omitted)`
			: diff;

		console.log(`[review-pr] Reviewing PR #${prNumber}: ${pr.title}`);
		manager.updateTitle(conversationId, `PR Review: ${pr.title}`);

		const prompt = `REVIEW PR — DO NOT DELEGATE. This is YOUR job, not a specialist's.

PR #${prNumber} "${pr.title}" has passed CI checks (nix config validated).

${pr.body ? `Description: ${pr.body}\n\n` : ""}Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Review the diff above:
- If the changes look correct and safe → call merge_pull_request with pr_number=${prNumber}
- If something looks wrong → delegate to Nixie to fix the issue on branch "${pr.head.ref}", explaining what's wrong`;

		const homie = manager.get(conversationId);
		await homie.prompt(prompt);

		const messages = homie.getMessages();
		const lastAssistant = messages
			.filter((m: any) => m.role === "assistant")
			.pop();
		const text = lastAssistant
			? extractResponseText(lastAssistant.content || []).join("\n")
			: "(no response)";
		await gitea.commentOnIssue(prNumber, text);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[review-pr] Failed reviewing PR #${prNumber}: ${msg}`);
		if (gitea) {
			await gitea.commentOnIssue(prNumber, `Failed to review: ${msg}`).catch(() => {});
		}
	}
}

async function handleCiFailure(
	prNumber: number,
	ciError: string,
	conversationId: string,
	manager: ConversationManager,
	gitea?: GiteaService,
): Promise<void> {
	if (!gitea) {
		console.error("[ci-failed] No gitea service configured");
		return;
	}

	try {
		const pr = await gitea.getPullRequest(prNumber);
		console.log(`[ci-failed] PR #${prNumber} failed CI: ${pr.title}`);
		manager.updateTitle(conversationId, `CI Failed: ${pr.title}`);

		const maxLen = 4000;
		const truncatedError = ciError.length > maxLen
			? ciError.slice(0, maxLen) + "\n... (truncated)"
			: ciError;

		const prompt = `PR #${prNumber} "${pr.title}" FAILED CI checks. The nix config has errors that need fixing. Delegate to Nixie to fix the issue on branch "${pr.head.ref}".\n\nCI error output:\n\`\`\`\n${truncatedError}\n\`\`\`\n\nNixie should read the current file, fix the error, and push a fix to the same branch (the PR will update automatically).`;

		const homie = manager.get(conversationId);
		await homie.prompt(prompt);

		const messages = homie.getMessages();
		const lastAssistant = messages
			.filter((m: any) => m.role === "assistant")
			.pop();
		const text = lastAssistant
			? extractResponseText(lastAssistant.content || []).join("\n")
			: "(no response)";
		await gitea.commentOnIssue(prNumber, text);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[ci-failed] Failed handling CI failure for PR #${prNumber}: ${msg}`);
		if (gitea) {
			await gitea.commentOnIssue(prNumber, `Failed to handle CI failure: ${msg}`).catch(() => {});
		}
	}
}

function handleGiteaWebhook(
	event: string,
	payload: any,
	manager: ConversationManager,
	gitea?: GiteaService,
): void {
	if (event === "issues" && payload.action === "opened") {
		const issue = payload.issue;
		const number = issue.number as number;
		const title = issue.title as string;
		const body = issue.body as string;
		console.log(`[gitea] Issue #${number} opened: ${title}`);

		const meta = manager.create({
			title: `Issue #${number}: ${title}`,
			source: "gitea-issue",
			sourceRef: String(number),
		});

		const prompt = `Gitea issue #${number}: "${title}"\n\n${body || "(no description)"}\n\nIMPORTANT: When delegating to Nixie for this issue, tell her to use the pull_request tool (not deploy) and include "closes #${number}" in the PR body.`;

		(async () => {
			if (gitea) {
				await gitea.addLabel(number, "homie").catch((e: Error) =>
					console.error(`[gitea] Failed to add label: ${e.message}`));
			}
			try {
				const homie = manager.get(meta.id);
				await homie.prompt(prompt);
				if (gitea) {
					const messages = homie.getMessages();
					const lastAssistant = messages
						.filter((m: any) => m.role === "assistant")
						.pop();
					const text = lastAssistant
						? extractResponseText(lastAssistant.content || []).join("\n")
						: "(no response)";
					await gitea.commentOnIssue(number, text);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[gitea] Failed processing issue #${number}: ${msg}`);
				if (gitea) {
					await gitea.commentOnIssue(number, `Failed to process this issue: ${msg}`).catch(() => {});
				}
			}
		})();
	} else if (event === "issue_comment" && payload.action === "created") {
		const issue = payload.issue;
		const comment = payload.comment;
		if (comment.user?.login === "homie-admin") return;
		if (!comment.body?.includes("@homie")) return;

		const number = issue.number as number;
		console.log(`[gitea] Comment on issue #${number} mentioning @homie`);

		// Find existing conversation for this issue, or create a new one
		const existing = manager.list().find(
			(c) => c.source === "gitea-issue" && c.sourceRef === String(number),
		);
		const convId = existing?.id ?? manager.create({
			title: `Issue #${number}: ${issue.title}`,
			source: "gitea-comment",
			sourceRef: String(number),
		}).id;

		const prompt = `Follow-up on Gitea issue #${number}: "${issue.title}"\n\nComment from ${comment.user.login}:\n${comment.body}`;

		(async () => {
			try {
				const homie = manager.get(convId);
				await homie.prompt(prompt);
				if (gitea) {
					const messages = homie.getMessages();
					const lastAssistant = messages
						.filter((m: any) => m.role === "assistant")
						.pop();
					const text = lastAssistant
						? extractResponseText(lastAssistant.content || []).join("\n")
						: "(no response)";
					await gitea.commentOnIssue(number, text);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[gitea] Failed processing comment on issue #${number}: ${msg}`);
			}
		})();
	}
}
