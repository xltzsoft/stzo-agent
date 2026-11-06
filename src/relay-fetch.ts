/**
 * Normalizes Chat Completions traffic to the STZO relay.
 *
 * Some upstreams behind the relay (Mistral, incl. the DeepSeek models it hosts) stream reasoning as
 * structured content: `delta.content = [{type:"thinking", thinking:[{type:"text",text}]}, {type:"text",text}]`.
 * pi expects `content` to be a string, so it concatenated the objects into "[object Object]" — in
 * the UI and in the history it sends back. Those upstreams also reject any reasoning field on
 * assistant messages (422 extra_forbidden).
 *
 * We rewrite structured content into `reasoning_text` (pi renders it as thinking) + plain `content`,
 * and drop `reasoning_text` from outgoing assistant messages. Only this shim produces that field, so
 * other upstreams are unaffected.
 */
import { BRAND } from "./brand.ts";
import { loadAccount } from "./account.ts";

const MARK = "reasoning_text";

function relayHosts(): Set<string> {
	const hosts = new Set<string>();
	try {
		hosts.add(new URL(BRAND.server).host);
	} catch {}
	try {
		for (const k of loadAccount()?.keys ?? []) hosts.add(new URL(k.base_url).host);
	} catch {}
	return hosts;
}

function partsText(parts: unknown): string {
	if (typeof parts === "string") return parts;
	if (!Array.isArray(parts)) return "";
	return parts.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
}

/** Split structured content into { text, thinking }. Returns undefined when content is already a string. */
export function splitContent(content: unknown): { text: string; thinking: string } | undefined {
	if (!Array.isArray(content)) return undefined;
	let text = "";
	let thinking = "";
	for (const part of content as any[]) {
		if (typeof part === "string") text += part;
		else if (part?.type === "thinking" || part?.type === "reasoning") thinking += partsText(part.thinking ?? part.reasoning ?? part.text);
		else if (typeof part?.text === "string") text += part.text;
	}
	return { text, thinking };
}

function normalizeTarget(target: any) {
	if (!target || typeof target !== "object") return false;
	const parts = splitContent(target.content);
	if (!parts) return false;
	target.content = parts.text;
	if (parts.thinking) target[MARK] = (typeof target[MARK] === "string" ? target[MARK] : "") + parts.thinking;
	return true;
}

/** Rewrites one parsed chunk / response in place. Returns true if anything changed. */
export function normalizeChunk(obj: any): boolean {
	let changed = false;
	for (const choice of obj?.choices ?? []) {
		if (normalizeTarget(choice?.delta)) changed = true;
		if (normalizeTarget(choice?.message)) changed = true;
	}
	return changed;
}

export function normalizeSseLine(line: string): string {
	if (!line.startsWith("data:")) return line;
	const payload = line.slice(5).trimStart();
	if (!payload.startsWith("{") || !payload.includes('"content":[')) return line;
	try {
		const obj = JSON.parse(payload);
		return normalizeChunk(obj) ? `data: ${JSON.stringify(obj)}` : line;
	} catch {
		return line;
	}
}

function sseTransform(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buf = "";
	return new TransformStream({
		transform(chunk, controller) {
			buf += decoder.decode(chunk, { stream: true });
			let nl = buf.indexOf("\n");
			if (nl < 0) return;
			let out = "";
			while (nl >= 0) {
				const raw = buf.slice(0, nl);
				const cr = raw.endsWith("\r");
				out += `${normalizeSseLine(cr ? raw.slice(0, -1) : raw)}${cr ? "\r" : ""}\n`;
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
			}
			controller.enqueue(encoder.encode(out));
		},
		flush(controller) {
			buf += decoder.decode();
			if (buf) controller.enqueue(encoder.encode(normalizeSseLine(buf)));
		},
	});
}

export function stripRequest(body: string): string {
	if (!body.includes(`"${MARK}"`)) return body;
	try {
		const json = JSON.parse(body);
		let changed = false;
		for (const m of json?.messages ?? []) {
			if (m?.role === "assistant" && MARK in m) {
				delete m[MARK];
				changed = true;
			}
		}
		return changed ? JSON.stringify(json) : body;
	} catch {
		return body;
	}
}

let installed = false;
export function installRelayFetch() {
	if (installed || typeof globalThis.fetch !== "function") return;
	installed = true;
	// pi installs undici's fetch as the global at startup (for proxy support), replacing whatever
	// was there. Keep our wrapper in place and wrap whichever fetch gets assigned.
	let current: typeof fetch = globalThis.fetch;
	const original = (input: any, init?: any) => current.call(globalThis, input, init);
	let hosts: Set<string> | undefined;
	const wrapped = async (input: any, init?: any): Promise<Response> => {
		let url: URL | undefined;
		try {
			url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		} catch {}
		if (!url || !url.pathname.endsWith("/chat/completions")) return original(input, init);
		hosts ??= relayHosts();
		if (!hosts.has(url.host)) {
			hosts = relayHosts(); // keys may have changed after login
			if (!hosts.has(url.host)) return original(input, init);
		}
		if (init && typeof init.body === "string") init = { ...init, body: stripRequest(init.body) };
		const res = await original(input, init);
		const type = res.headers.get("content-type") || "";
		if (!res.ok || !res.body) return res;
		const headers = new Headers(res.headers);
		headers.delete("content-length");
		headers.delete("content-encoding");
		if (type.includes("text/event-stream")) {
			return new Response(res.body.pipeThrough(sseTransform()), { status: res.status, statusText: res.statusText, headers });
		}
		if (type.includes("application/json")) {
			const text = await res.text();
			let body = text;
			try {
				const obj = JSON.parse(text);
				if (normalizeChunk(obj)) body = JSON.stringify(obj);
			} catch {}
			return new Response(body, { status: res.status, statusText: res.statusText, headers });
		}
		return res;
	};
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		enumerable: true,
		get: () => wrapped,
		set: (next: typeof fetch) => {
			if (typeof next === "function" && next !== wrapped) current = next;
		},
	});
}
