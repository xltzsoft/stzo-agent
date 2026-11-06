import { join } from "node:path";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Account, RelayKey } from "./account.ts";
import { CACHE_DIR, readJson, writeJson } from "./brand.ts";

type ChatModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: any;
	promptCache?: any;
	compat?: any;
	inputLimits?: any;
};

const CATALOGS: Record<string, Record<string, any>> = {
	"anthropic-messages": ANTHROPIC_MODELS as any,
	"openai-completions": OPENAI_MODELS as any,
	"openai-responses": OPENAI_MODELS as any,
	"google-generative-ai": GOOGLE_MODELS as any,
};
const ALL_CATALOG: Record<string, any> = { ...(GOOGLE_MODELS as any), ...(OPENAI_MODELS as any), ...(ANTHROPIC_MODELS as any) };

export const providerId = (k: RelayKey) => `stzo-g${k.group_id}`;
const providerName = (k: RelayKey) => `STZO · ${k.group_name}`;
const cacheFile = (k: RelayKey) => join(CACHE_DIR, `models-g${k.group_id}.json`);

/** Strip date suffixes and relay prefixes so "claude-sonnet-4-5-20250929" or "anthropic/claude-x" still match. */
function catalogEntry(api: string, id: string) {
	const cat = CATALOGS[api] || {};
	const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	const undated = bare.replace(/-\d{8}$/, "");
	return cat[id] || cat[bare] || cat[undated] || ALL_CATALOG[bare] || ALL_CATALOG[undated];
}

function guessModel(api: string, id: string): ChatModelConfig {
	const lower = id.toLowerCase();
	const isClaude = lower.includes("claude");
	const reasoning = isClaude || /gpt-5|gpt-6|o\d|thinking|reason|r1|deepseek-v[34]|qwen3|glm-[45]|kimi-k2|gemini-[23]/.test(lower);
	const vision = isClaude || /gpt-[456]|gemini|vl|vision|4o/.test(lower);
	return {
		id,
		name: id,
		reasoning,
		input: vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: isClaude ? 200000 : api === "google-generative-ai" ? 1000000 : 128000,
		maxTokens: isClaude ? 64000 : 32000,
		// DeepSeek V4 upstreams reject reasoning_effort "medium" (400 "supported values: none, low,
		// high, xhigh, max"). Mark it unsupported like pi's own DeepSeek catalog; pi clamps to "high".
		...(api === "openai-completions" && /deepseek-v[34]/.test(lower)
			? { thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } }
			: {}),
	};
}

/**
 * The relay forwards chat completions to many upstreams (Mistral, DeepSeek, Qwen…). Several reject
 * the "developer" role (422 "Input tag 'developer' … does not match") and the OpenAI-only `store`
 * field, and pi enables both for any non-OpenAI base URL. "system" is accepted everywhere,
 * including OpenAI reasoning models, so always use it.
 */
function relayCompat(api: string, compat: any, openaiNative: boolean) {
	if (api !== "openai-completions") return compat;
	return { ...(compat || {}), supportsDeveloperRole: false, ...(openaiNative ? {} : { supportsStore: false }) };
}

export function toModelConfig(k: RelayKey, id: string): ChatModelConfig {
	const known = catalogEntry(k.api, id);
	if (!known) {
		const guessed = guessModel(k.api, id);
		const compat = relayCompat(k.api, undefined, false);
		return compat ? { ...guessed, compat } : guessed;
	}
	const rate = k.rate_multiplier && k.rate_multiplier > 0 ? k.rate_multiplier : 1;
	return {
		id,
		name: known.name ? String(known.name).replace(/\s*\(latest\)$/, "") : id,
		reasoning: !!known.reasoning,
		input: known.input ?? ["text"],
		// Show relay-billed cost: list price × group multiplier.
		cost: {
			input: (known.cost?.input ?? 0) * rate,
			output: (known.cost?.output ?? 0) * rate,
			cacheRead: (known.cost?.cacheRead ?? 0) * rate,
			cacheWrite: (known.cost?.cacheWrite ?? 0) * rate,
		},
		contextWindow: known.contextWindow ?? 128000,
		maxTokens: known.maxTokens ?? 32000,
		thinkingLevelMap: known.thinkingLevelMap,
		promptCache: known.promptCache,
		compat: relayCompat(k.api, known.compat, !!(OPENAI_MODELS as any)[known.id]),
		inputLimits: known.inputLimits,
	};
}

/** Fetch model ids the relay exposes for this key. */
export async function fetchModelIds(k: RelayKey, timeoutMs = 8000, signal?: AbortSignal): Promise<string[]> {
	const root = k.base_url.replace(/\/v1beta$/, "").replace(/\/v1$/, "");
	const signals = [AbortSignal.timeout(timeoutMs)];
	if (signal) signals.push(signal);
	const res = await fetch(`${root}/v1/models`, {
		headers: {
			Authorization: `Bearer ${k.key}`,
			"x-api-key": k.key,
			"anthropic-version": "2023-06-01",
			Accept: "application/json",
		},
		signal: AbortSignal.any(signals),
	});
	if (!res.ok) throw new Error(`models ${res.status}`);
	const json: any = await res.json();
	const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
	const ids = list
		.map((m) => String(m?.id ?? m?.name ?? "").replace(/^models\//, ""))
		.filter((id) => id && !/embed|whisper|tts|dall-e|image|moderation|rerank/i.test(id));
	return [...new Set(ids)];
}

export function cachedModelIds(k: RelayKey): string[] | undefined {
	const c = readJson<{ ids?: string[] } | null>(cacheFile(k), null);
	return Array.isArray(c?.ids) ? c!.ids : undefined;
}

function defaultIds(k: RelayKey): string[] {
	if (k.api === "anthropic-messages") return ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"];
	return [];
}

export function registerKey(pi: ExtensionAPI, k: RelayKey, ids: string[]) {
	const models = (ids.length ? ids : defaultIds(k)).map((id) => toModelConfig(k, id));
	if (models.length === 0) return 0;
	pi.registerProvider(providerId(k), {
		name: providerName(k),
		baseUrl: k.base_url,
		apiKey: k.key,
		api: k.api as any,
		models,
	});
	return models.length;
}

export function unregisterAll(pi: ExtensionAPI, keys: RelayKey[]) {
	for (const k of keys) pi.unregisterProvider(providerId(k));
}

/**
 * Register providers for every key. Uses the on-disk model cache when present so startup
 * does not block on the network; otherwise waits (bounded) for the live list.
 */
export async function registerAccountProviders(pi: ExtensionAPI, account: Account, opts: { live?: boolean } = {}) {
	let total = 0;
	await Promise.all(
		account.keys.map(async (k) => {
			let ids = opts.live ? undefined : cachedModelIds(k);
			if (!ids) {
				try {
					ids = await fetchModelIds(k, opts.live ? 10000 : 5000);
					writeJson(cacheFile(k), { ids, at: Date.now() });
				} catch {
					ids = cachedModelIds(k) ?? [];
				}
			}
			total += registerKey(pi, k, ids);
		}),
	);
	return total;
}

/** Background refresh; re-registers only when the list changed. */
export async function refreshAccountModels(pi: ExtensionAPI, account: Account) {
	let changed = false;
	await Promise.all(
		account.keys.map(async (k) => {
			try {
				const ids = await fetchModelIds(k);
				const old = cachedModelIds(k) ?? [];
				writeJson(cacheFile(k), { ids, at: Date.now() });
				if (ids.join("\n") !== old.join("\n")) {
					registerKey(pi, k, ids);
					changed = true;
				}
			} catch {}
		}),
	);
	return changed;
}

/** Best default model among the account's providers. */
export function pickDefaultModel(account: Account, preferred?: string): { provider: string; id: string } | undefined {
	const prefs = [preferred, "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-7", "claude-opus-4-6", "gpt-5", "gemini-2.5-pro"].filter(
		Boolean,
	) as string[];
	const all: { provider: string; id: string }[] = [];
	// Cheapest group first, so a new user's default never lands on a premium multiplier.
	const keys = [...account.keys].sort((a, b) => (a.rate_multiplier ?? 1) - (b.rate_multiplier ?? 1));
	for (const k of keys) {
		for (const id of cachedModelIds(k) ?? defaultIds(k)) all.push({ provider: providerId(k), id });
	}
	for (const p of prefs) {
		const hit = all.find((m) => m.id === p || m.id.startsWith(`${p}-`));
		if (hit) return hit;
	}
	return all.find((m) => /sonnet|opus/.test(m.id)) ?? all[0];
}
