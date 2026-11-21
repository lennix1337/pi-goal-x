import { asRecord } from "./goal-record.ts";

// external: Pi marks the final user block for explicit caching.
/** Relocate an existing cache breakpoint from live tails to preceding history. */
export function cacheGoalHistory(payload: unknown, liveContent: string | readonly string[] | undefined): unknown {
	const live = liveContent === undefined
		? undefined
		: new Set((typeof liveContent === "string" ? [liveContent] : liveContent).filter(text => text.length > 0));
	const root = asRecord(payload);
	if (!live || live.size === 0 || !Array.isArray(root?.messages)) return undefined;
	const messages = root.messages;
	let lastIndex = messages.length - 1;
	for (; lastIndex >= 0; lastIndex--) {
		const content = asRecord(messages[lastIndex])?.content;
		if (typeof content === "string" || Array.isArray(content) ? content.length > 0 : content != null) break;
	}
	const last = asRecord(messages[lastIndex]);
	if (last?.role !== "user" || !Array.isArray(last.content)) return undefined;
	// external: Bedrock text blocks may omit a type tag.
	const isLiveText = (block: unknown): boolean => {
		const record = asRecord(block);
		return typeof record?.text === "string" && live.has(record.text);
	};
	const bedrockPoint = asRecord(last.content.at(-1));
	if (asRecord(bedrockPoint?.cachePoint)) {
		if (!isLiveText(last.content.at(-2))) return undefined;
		for (let i = lastIndex; i >= 0; i--) {
			const previous = asRecord(messages[i]);
			if (!Array.isArray(previous?.content)) continue;
			for (let j = previous.content.length - 1; j >= 0; j--) {
				const block = asRecord(previous.content[j]);
				if (!block || isLiveText(block) || !["text", "image", "document", "toolUse", "toolResult"].some(key => key in block)) continue;
				last.content.pop();
				if (!asRecord(previous.content[j + 1])?.cachePoint) previous.content.splice(j + 1, 0, { ...bedrockPoint });
				return payload;
			}
		}
		return undefined;
	}
	const tail = asRecord(last.content.at(-1));
	if (tail?.type !== "text" || typeof tail.text !== "string" || !live.has(tail.text) || !asRecord(tail.cache_control)) return undefined;
	for (let i = lastIndex; i >= 0; i--) {
		const message = asRecord(messages[i]);
		if (!message || !["user", "assistant", "tool"].includes(String(message.role))) continue;
		if (typeof message.content === "string" && message.content.length > 0 && !live.has(message.content)) {
			message.content = [{ type: "text", text: message.content, cache_control: tail.cache_control }];
			delete tail.cache_control;
			return payload;
		}
		if (!Array.isArray(message.content)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = asRecord(message.content[j]);
			// external: thinking blocks cannot carry cache_control; tool pairs must not be split.
			if (!block || isLiveText(block) || !["text", "image", "tool_use", "tool_result"].includes(String(block.type))) continue;
			block.cache_control ??= tail.cache_control;
			delete tail.cache_control;
			return payload;
		}
	}
	return undefined;
}
