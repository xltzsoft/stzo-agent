import assert from "node:assert/strict";
import { test } from "node:test";

const { compareVersions } = await import("../dist/brand.js");
const { toModelConfig, pickDefaultModel } = await import("../dist/providers.js");

test("compareVersions", () => {
	assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
	assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
	assert.equal(compareVersions("v1.0.0", "1.0.1"), -1);
	assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
	assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
});

test("model metadata comes from the pi catalog with the group multiplier", () => {
	const key = { group_id: 30, group_name: "Claude Max", platform: "anthropic", api: "anthropic-messages", rate_multiplier: 2, key: "k", id: 1, base_url: "x" };
	const m = toModelConfig(key, "claude-sonnet-4-5-20250929");
	assert.equal(m.reasoning, true);
	assert.equal(m.contextWindow, 200000);
	assert.equal(m.cost.input, 6);
	const unknown = toModelConfig(key, "some-new-model");
	assert.equal(unknown.id, "some-new-model");
	assert.ok(unknown.maxTokens > 0);
});

test("pickDefaultModel prefers sonnet", () => {
	const account = { keys: [{ group_id: 999001, api: "anthropic-messages" }] };
	const pick = pickDefaultModel(account);
	assert.equal(pick.provider, "stzo-g999001");
	assert.match(pick.id, /sonnet/);
});

test("relay stream: structured thinking content becomes reasoning_text + plain text", async () => {
	const { normalizeSseLine, stripRequest } = await import("../dist/relay-fetch.js");
	const line = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "think" }] }, { type: "text", text: "391" }] } }] })}`;
	const out = JSON.parse(normalizeSseLine(line).slice(6));
	assert.equal(out.choices[0].delta.content, "391");
	assert.equal(out.choices[0].delta.reasoning_text, "think");
	const plain = `data: {"choices":[{"delta":{"content":"hi"}}]}`;
	assert.equal(normalizeSseLine(plain), plain);
	assert.equal(normalizeSseLine("data: [DONE]"), "data: [DONE]");
	const body = JSON.stringify({ messages: [{ role: "assistant", content: "391", reasoning_text: "think" }, { role: "user", content: "reasoning_text" }] });
	const stripped = JSON.parse(stripRequest(body));
	assert.equal("reasoning_text" in stripped.messages[0], false);
	assert.equal(stripped.messages[1].content, "reasoning_text");
});

test("relay chat models use the system role; DeepSeek V4 has no medium effort", () => {
	const key = { group_id: 2, group_name: "ALL", platform: "openai", api: "openai-completions", rate_multiplier: 1, key: "k", id: 1, base_url: "x" };
	const ds = toModelConfig(key, "deepseek-v4.1-flash1");
	assert.equal(ds.compat.supportsDeveloperRole, false);
	assert.equal(ds.compat.supportsStore, false);
	assert.equal(ds.thinkingLevelMap.medium, null);
	const gpt = toModelConfig(key, "gpt-5");
	assert.equal(gpt.compat.supportsDeveloperRole, false);
	assert.notEqual(gpt.compat.supportsStore, false);
});
