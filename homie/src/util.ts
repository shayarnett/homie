/**
 * Shell-quote a string for safe interpolation into shell commands.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Strip leaked thinking/reasoning from model text output.
 *
 * The Nemotron model sometimes leaks chain-of-thought reasoning into text
 * blocks, typically delimited by </think> tags. Everything before the last
 * </think> is internal reasoning and should not be shown to the user.
 */
export function stripLeakedThinking(text: string): string {
	// Strip everything up to and including the last </think> tag
	const thinkEnd = text.lastIndexOf("</think>");
	if (thinkEnd !== -1) {
		text = text.substring(thinkEnd + "</think>".length);
	}

	// Also strip orphaned opening <think> tags
	text = text.replace(/<think>/g, "");

	// Strip leaked <tool_call> fragments — vLLM's hermes parser sometimes
	// kicks in mid-stream, leaving a partial "<tool_call" prefix in the text
	// block while the actual tool call is parsed as a structured toolCall block.
	text = text.replace(/<\/?tool_call[^>]*>?/g, "");

	// Strip hermes chat template instructions that the model echoes back.
	// vLLM's hermes template injects function-calling instructions into the
	// prompt, and the model sometimes parrots them as its response text.
	// Match patterns like: "For each function call return a json object..."
	// or "You are a function calling AI model..."
	text = text.replace(/(?:You are a function calling AI model[\s\S]*?)?For each function call,?\s*return a json object with function name and arguments[\s\S]*/i, "");
	text = text.replace(/^<\/?tools>[\s\S]*?<\/?tools>/gm, "");

	text = text.trim();

	// Strip wrapping quotation marks — the model sometimes wraps its entire
	// response in quotes, imitating example formatting from the system prompt.
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		const isQuoted =
			(first === '"' && last === '"') ||
			(first === '\u201C' && last === '\u201D') ||
			(first === '\u201C' && last === '"') ||
			(first === '"' && last === '\u201D');
		if (isQuoted) {
			text = text.slice(1, -1).trim();
		}
	}

	return text;
}

/**
 * Extract displayable response text from assistant message content blocks.
 *
 * The Nemotron model sometimes generates only a thinking block with no text
 * block, leaving the user with no visible response. This function first tries
 * text blocks (normal path), then falls back to thinking blocks if no text
 * is available.
 */
export function extractResponseText(content: any[]): string[] {
	if (!content || content.length === 0) return [];

	// Normal path: text blocks
	const texts = content
		.filter((c: any) => c.type === "text")
		.map((c: any) => stripLeakedThinking(c.text))
		.filter((t: string) => t.length > 0);

	if (texts.length > 0) return texts;

	// Fallback: extract answer from thinking blocks when model produced no text.
	// The model's conclusion/answer is typically near the END of its thinking,
	// so we extract from the tail rather than dumping reasoning from the start.
	const thinkingBlocks = content
		.filter((c: any) => c.type === "thinking" && c.thinking)
		.map((c: any) => c.thinking as string);

	if (thinkingBlocks.length === 0) return [];

	const thinking = thinkingBlocks.join("\n");
	const cleaned = stripLeakedThinking(thinking);
	const raw = cleaned.length > 0 ? cleaned : thinking.trim();

	// Try to find a quoted short answer — the model often wraps its intended
	// response in quotes like "Hello!" within reasoning. Find the last one.
	const quoteMatches = [...raw.matchAll(/[""\u201C]([^""\u201D]{1,200})[""\u201D]/g)];
	if (quoteMatches.length > 0) {
		const lastQuote = quoteMatches[quoteMatches.length - 1][1].trim();
		// Only use if it looks like a response (not a reference to a guideline etc.)
		if (lastQuote.length > 0 && lastQuote.length < 200 && !lastQuote.includes("should") && !lastQuote.includes("guideline")) {
			return [lastQuote];
		}
	}

	// Take the last few paragraphs — the conclusion is at the end
	const paragraphs = raw.split(/\n\n+/).filter(p => p.trim().length > 0);
	if (paragraphs.length === 0) return [];

	// Take the last paragraph, trimmed
	const lastParagraph = paragraphs[paragraphs.length - 1].trim();

	// Strip reasoning prefixes that leak into conclusions
	const reasoningPrefixes = /^(So |Therefore |Thus |Hence |In conclusion,? |Let me |We should |We need to |I think |I should |I'll |The answer is |The response is )/i;
	let answer = lastParagraph;
	answer = answer.replace(reasoningPrefixes, "");

	// Cap at 500 chars — this is a fallback, keep it concise
	if (answer.length > 500) {
		answer = answer.substring(0, 500) + "...";
	}

	return answer.length > 0 ? [answer] : [];
}
