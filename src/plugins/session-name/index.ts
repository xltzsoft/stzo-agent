/**
 * Session naming.
 *
 * Names a session automatically once its first real exchange has finished, with one short, cheap
 * request to the current model (no tools, no thinking). Names the user set themselves are never
 * replaced. `/session-name [name]` sets or shows the name by hand.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";

const PROMPT =
	"Give this conversation a short title: at most 12 Chinese characters or 6 English words, in the same language the user writes in. " +
	"Describe the task, not the greeting. Output only the title, without quotes or trailing punctuation.";

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

function clean(raw: string): string {
	const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	return line
		.replace(/^(title|标题)\s*[:：]\s*/i, "")
		.replace(/^["'“”‘’「」《》*#\s]+|["'“”‘’「」《》*#。．.!！?？\s]+$/g, "")
		.slice(0, 40)
		.trim();
}

export default function (pi: ExtensionAPI) {
	// Per session: how many user messages the last attempt saw, so a trivial opener ("你好") gets
	// another chance once there is a real task, without retrying on every turn.
	const attempted = new Map<string, number>();

	async function autoName(ctx: ExtensionContext) {
		if (pi.getSessionName()) return;
		const model = ctx.model;
		if (!model) return;
		const entries = ctx.sessionManager.getBranch();
		const users: string[] = [];
		let reply = "";
		for (const e of entries as any[]) {
			if (e.type !== "message") continue;
			if (e.message.role === "user") users.push(text(e.message.content).trim());
			else if (e.message.role === "assistant" && e.message.stopReason !== "error") reply = text(e.message.content).trim() || reply;
		}
		const userText = users.filter(Boolean);
		if (!userText.length) return;
		const substantive = userText.join("").length >= 8 || userText.length >= 2;
		const key = ctx.sessionManager.getSessionId();
		const seen = attempted.get(key) ?? 0;
		if (!substantive || seen >= userText.length || seen >= 3) return;
		attempted.set(key, userText.length);

		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
		if (!apiKey) return;
		const convo = [
			...userText.slice(0, 3).map((t) => `User: ${t.slice(0, 600)}`),
			reply ? `Assistant: ${reply.slice(0, 400)}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		const res = await completeSimple(
			{ ...model, reasoning: false } as any,
			{ systemPrompt: PROMPT, messages: [{ role: "user", content: convo, timestamp: Date.now() }] as any },
			{ apiKey, maxTokens: 40, signal: AbortSignal.timeout(20_000) } as any,
		);
		if (res.stopReason === "error" || res.stopReason === "toolUse" || pi.getSessionName()) return;
		const title = clean(text(res.content));
		if (title.length >= 2) pi.setSessionName(title);
	}

	pi.on("agent_settled", async (event: any, ctx) => {
		if (event?.aborted) return;
		// Never let naming break or delay the session.
		void autoName(ctx).catch(() => {});
	});

	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [new name])",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name) {
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
