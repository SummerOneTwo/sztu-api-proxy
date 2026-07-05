#!/usr/bin/env node
const { getApiKey, envNumber, loadDotEnv } = require("../shared/env");

loadDotEnv();

const UPSTREAM_URL = process.env.SZTU_UPSTREAM_URL || "https://apiai.sztu.edu.cn/v1/chat/completions";
const OPENCODE_URL = `http://127.0.0.1:${envNumber("OPENCODE_PROXY_PORT", 8788)}/v1/chat/completions`;
const CODEBUDDY_CHAT_URL = `http://127.0.0.1:${envNumber("CODEBUDDY_PROXY_PORT", envNumber("PORT", 8787))}/v1/chat/completions`;

const DEFAULT_TIMEOUT_MS = envNumber("TEST_TIMEOUT_MS", 120000);

function usage() {
  console.log(`Usage: node scripts/test-api.js [suite...]

Suites:
  direct          Test SZTU upstream directly
  opencode        Test opencode proxy on ${OPENCODE_URL}
  codebuddy       Test codebuddy proxy on ${CODEBUDDY_CHAT_URL}
  all             Run every suite

Examples:
  node scripts/test-api.js direct
  node scripts/test-api.js opencode codebuddy
  node scripts/test-api.js all
`);
}

function parseSuites() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }
  const suites = args.length === 0 ? ["direct"] : args;
  if (suites.includes("all")) {
    return ["direct", "opencode", "codebuddy"];
  }
  return suites;
}

function log(status, name, detail = "") {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[${new Date().toISOString()}] ${status.padEnd(6)} ${name}${suffix}`);
}

async function fetchText(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, headers = {}) {
  return fetchText(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseSse(text) {
  const events = [];
  for (const eventText of text.split(/\r?\n\r?\n/)) {
    if (!eventText.trim()) {
      continue;
    }
    const event = {};
    const data = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    event.data = data.join("\n");
    events.push(event);
  }
  return events;
}

function openAiStreamTextAndUsage(events) {
  let text = "";
  let hasUsage = false;
  for (const event of events) {
    if (!event.data || event.data === "[DONE]") {
      continue;
    }
    const json = parseJson(event.data);
    if (!json) {
      continue;
    }
    const delta = json.choices?.[0]?.delta || {};
    if (typeof delta.content === "string") {
      text += delta.content;
    }
    if (json.usage) {
      hasUsage = true;
    }
  }
  return { text, hasUsage };
}

function chatBody(model, content, extra = {}) {
  return {
    model,
    messages: [{ role: "user", content }],
    stream: false,
    max_tokens: 128,
    ...extra,
  };
}

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function testCase(name, fn) {
  log("RUN", name);
  const started = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - started;
    log("PASS", name, `${ms}ms${result ? ` ${result}` : ""}`);
    return true;
  } catch (error) {
    const ms = Date.now() - started;
    log("FAIL", name, `${ms}ms ${error.message}`);
    return false;
  }
}

function upstreamHeaders() {
  const apiKey = getApiKey();
  assertOk(apiKey, "missing SZTU_API_KEY in .env or environment");
  return {
    authorization: `Bearer ${apiKey}`,
  };
}

async function openAiNonStream(name, url, model, expectedText, headers = {}) {
  return testCase(name, async () => {
    const res = await postJson(url, chatBody(model, `请只回复 ${expectedText}`, {
      chat_template_kwargs: model === "deepseek-v4-pro" ? { thinking: false } : { enable_thinking: false },
    }), headers);
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const json = parseJson(res.text);
    assertOk(json, `invalid json: ${res.text.slice(0, 200)}`);
    const content = json.choices?.[0]?.message?.content || "";
    assertOk(content.includes(expectedText), `unexpected content=${JSON.stringify(content)}`);
    const usage = json.usage || {};
    assertOk(Number.isFinite(Number(usage.prompt_tokens)), "missing usage.prompt_tokens");
    assertOk(Number.isFinite(Number(usage.completion_tokens)), "missing usage.completion_tokens");
    return `usage=${usage.prompt_tokens}/${usage.completion_tokens}`;
  });
}

async function openAiStream(name, url, model, expectedText, headers = {}) {
  return testCase(name, async () => {
    const body = chatBody(model, `请只回复 ${expectedText}`, {
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: model === "deepseek-v4-pro" ? { thinking: false } : { enable_thinking: false },
    });
    const res = await postJson(url, body, headers);
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const events = parseSse(res.text);
    const parsed = openAiStreamTextAndUsage(events);
    assertOk(parsed.text.includes(expectedText), `missing expected text in SSE: ${parsed.text}`);
    assertOk(parsed.hasUsage, "missing usage in SSE");
    return `events=${events.length}`;
  });
}

async function testDirect() {
  const headers = upstreamHeaders();
  const ok = [];
  ok.push(await openAiNonStream("direct glm non-stream", UPSTREAM_URL, "glm-5.1", "GLM_OK", headers));
  ok.push(await openAiStream("direct glm stream usage", UPSTREAM_URL, "glm-5.1", "GLM_STREAM_OK", headers));
  ok.push(await openAiNonStream("direct deepseek non-stream", UPSTREAM_URL, "deepseek-v4-pro", "DS_OK", headers));
  ok.push(await openAiStream("direct deepseek stream usage", UPSTREAM_URL, "deepseek-v4-pro", "DS_STREAM_OK", headers));
  return ok;
}

async function testOpenCode() {
  const ok = [];
  ok.push(await openAiNonStream("opencode proxy glm non-stream", OPENCODE_URL, "glm-5.1", "GLM_OK"));
  ok.push(await openAiStream("opencode proxy glm stream usage", OPENCODE_URL, "glm-5.1", "GLM_STREAM_OK"));
  ok.push(await openAiNonStream("opencode proxy deepseek non-stream", OPENCODE_URL, "deepseek-v4-pro", "DS_OK"));
  ok.push(await openAiStream("opencode proxy deepseek stream usage", OPENCODE_URL, "deepseek-v4-pro", "DS_STREAM_OK"));
  return ok;
}

async function testCodeBuddy() {
  const ok = [];
  ok.push(await openAiNonStream(
    "codebuddy proxy instruct non-stream",
    CODEBUDDY_CHAT_URL,
    "deepseek-v4-pro-instruct",
    "DS_INSTRUCT_OK"
  ));
  ok.push(await openAiStream(
    "codebuddy proxy high stream usage",
    CODEBUDDY_CHAT_URL,
    "deepseek-v4-pro",
    "DS_HIGH_STREAM_OK"
  ));
  ok.push(await openAiNonStream(
    "codebuddy proxy max non-stream",
    CODEBUDDY_CHAT_URL,
    "deepseek-v4-pro-max",
    "DS_MAX_OK"
  ));
  return ok;
}

async function main() {
  const suites = parseSuites();
  const valid = new Set(["direct", "opencode", "codebuddy"]);
  for (const suite of suites) {
    if (!valid.has(suite)) {
      throw new Error(`unknown suite: ${suite}`);
    }
  }

  const results = [];
  for (const suite of suites) {
    log("SUITE", suite);
    if (suite === "direct") {
      results.push(...await testDirect());
    } else if (suite === "opencode") {
      results.push(...await testOpenCode());
    } else if (suite === "codebuddy") {
      results.push(...await testCodeBuddy());
    }
  }

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  log(failed ? "FAIL" : "PASS", "summary", `passed=${passed} failed=${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  log("ERROR", "test-api", error.stack || error.message);
  process.exitCode = 1;
});
