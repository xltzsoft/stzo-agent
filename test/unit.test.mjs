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
