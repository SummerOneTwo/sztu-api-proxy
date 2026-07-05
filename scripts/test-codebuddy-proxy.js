#!/usr/bin/env node
const assert = require("assert");
const {
  normalizeMaxTokens,
  resolveModel,
  sanitizeBody,
} = require("../codebuddy/codebuddy-proxy");

function testResolveModel() {
  const high = resolveModel("deepseek-v4-pro");
  assert.strictEqual(high.clientModel, "deepseek-v4-pro");
  assert.strictEqual(high.apiModel, "deepseek-v4-pro");
  assert.strictEqual(high.reasoningEffort, "high");
  assert.strictEqual(high.tier, "high");

  const instruct = resolveModel("deepseek-v4-pro-instruct");
  assert.strictEqual(instruct.thinking, false);
  assert.strictEqual(instruct.tier, "instruct");

  const max = resolveModel("deepseek-v4-pro-max");
  assert.strictEqual(max.reasoningEffort, "max");
  assert.strictEqual(max.tier, "max");

  assert.strictEqual(resolveModel("deepseek-v4-pro-nothink").tier, "instruct");
  assert.strictEqual(resolveModel(null), null);
  assert.strictEqual(resolveModel("unknown-model"), null);
}

function testNormalizeMaxTokens() {
  const defaultTokens = normalizeMaxTokens(undefined, "high");
  assert.ok(defaultTokens > 0, "default max_tokens should be positive");
  assert.ok(defaultTokens <= 32768, "default max_tokens should not exceed cap");

  const large = normalizeMaxTokens(20000, "high");
  assert.ok(large >= 20000 || large === 32768, "explicit large request should not be capped to default");

  assert.strictEqual(normalizeMaxTokens(512, "max"), 4000);
  assert.strictEqual(normalizeMaxTokens(8000, "max"), 8000);
  assert.strictEqual(normalizeMaxTokens(512, "instruct"), 512);
}

function testSanitizeBodyTiers() {
  const high = sanitizeBody({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.strictEqual(high.model, "deepseek-v4-pro");
  assert.deepStrictEqual(high.chat_template_kwargs, {
    thinking: true,
    reasoning_effort: "high",
  });

  const instruct = sanitizeBody({
    model: "deepseek-v4-pro-instruct",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepStrictEqual(instruct.chat_template_kwargs, { thinking: false });

  const max = sanitizeBody({
    model: "deepseek-v4-pro-max",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128,
  });
  assert.strictEqual(max.max_tokens, 4000);
  assert.deepStrictEqual(max.chat_template_kwargs, {
    thinking: true,
    reasoning_effort: "max",
  });
}

function testEmptyToolCallsPreserved() {
  const body = sanitizeBody({
    model: "deepseek-v4-pro-instruct",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", tool_calls: [] },
    ],
  });
  assert.strictEqual(body.messages.length, 2);
  assert.strictEqual(body.messages[1].content, "hello");
}

function testUnsupportedModel() {
  assert.throws(
    () => sanitizeBody({ model: "unknown-model", messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "UNSUPPORTED_MODEL"
  );
}

function main() {
  testResolveModel();
  testNormalizeMaxTokens();
  testSanitizeBodyTiers();
  testEmptyToolCallsPreserved();
  testUnsupportedModel();
  console.log("codebuddy proxy unit tests ok");
}

main();
