#!/usr/bin/env node
const { spawnSync } = require("child_process");
const http = require("http");
const path = require("path");
const { getApiKey, envNumber, loadDotEnv } = require("../shared/env");

loadDotEnv();

const UPSTREAM_URL = process.env.SZTU_UPSTREAM_URL || "https://apiai.sztu.edu.cn/v1/chat/completions";
const OPENCODE_URL = `http://127.0.0.1:${envNumber("OPENCODE_PROXY_PORT", 8788)}/v1/chat/completions`;
const CODEBUDDY_CHAT_URL = `http://127.0.0.1:${envNumber("CODEBUDDY_PROXY_PORT", envNumber("PORT", 8787))}/v1/chat/completions`;
const CODEBUDDY_RESPONSES_URL = `http://127.0.0.1:${envNumber("CODEBUDDY_PROXY_PORT", envNumber("PORT", 8787))}/v1/responses`;
const CLAUDE_URL = `http://127.0.0.1:${envNumber("CLAUDE_SZTU_PROXY_PORT", 8790)}/v1/messages`;
const CLAUDE_HEALTH_URL = `http://127.0.0.1:${envNumber("CLAUDE_SZTU_PROXY_PORT", 8790)}/health`;
const EXPECTED_CLAUDE_PRIMARY_MODEL = process.env.SZTU_DEFAULT_MODEL || "glm-5.1";
const EXPECTED_CLAUDE_FALLBACK_MODEL = String(process.env.CLAUDE_SZTU_FALLBACK_MODEL || "deepseek-v4-pro").trim();

const DEFAULT_TIMEOUT_MS = envNumber("TEST_TIMEOUT_MS", 120000);

function expectedClaudeFallbackModel() {
  return EXPECTED_CLAUDE_FALLBACK_MODEL && EXPECTED_CLAUDE_FALLBACK_MODEL !== EXPECTED_CLAUDE_PRIMARY_MODEL
    ? EXPECTED_CLAUDE_FALLBACK_MODEL
    : "";
}

function usage() {
  console.log(`Usage: node scripts/test-api.js [suite...]

Suites:
  direct          Test SZTU upstream directly
  opencode        Test opencode proxy on ${OPENCODE_URL}
  codebuddy       Test codebuddy proxy on ${CODEBUDDY_CHAT_URL}
  claudecode      Test Claude Code Anthropic proxy on ${CLAUDE_URL}
  fallback        Test Claude Code GLM-to-DeepSeek fallback with local mocks
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
    return ["direct", "opencode", "codebuddy", "claudecode", "fallback"];
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
  ok.push(await openAiNonStream("codebuddy proxy chat glm non-stream", CODEBUDDY_CHAT_URL, "glm-5.1", "GLM_OK"));
  ok.push(await openAiStream("codebuddy proxy chat glm stream usage", CODEBUDDY_CHAT_URL, "glm-5.1", "GLM_STREAM_OK"));
  ok.push(await testCase("codebuddy proxy responses non-stream", async () => {
    const res = await postJson(CODEBUDDY_RESPONSES_URL, {
      model: "glm-5.1",
      input: "请只回复 RESP_OK",
      max_output_tokens: 128,
    });
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const json = parseJson(res.text);
    const text = json?.output?.[0]?.content?.[0]?.text || "";
    assertOk(text.includes("RESP_OK"), `unexpected response text=${JSON.stringify(text)}`);
    assertOk(json?.usage?.input_tokens !== undefined, "missing response usage");
    return `usage=${json.usage.input_tokens}/${json.usage.output_tokens}`;
  }));
  return ok;
}

async function anthropicNonStream(name, model, expectedText) {
  return testCase(name, async () => {
    const res = await postJson(CLAUDE_URL, {
      model,
      messages: [{ role: "user", content: `请只回复 ${expectedText}` }],
      max_tokens: 128,
      stream: false,
    }, {
      "x-api-key": "any",
      "anthropic-version": "2023-06-01",
    });
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const json = parseJson(res.text);
    const text = json?.content?.map((part) => part.text || "").join("") || "";
    assertOk(text.includes(expectedText), `unexpected content=${JSON.stringify(text)}`);
    assertOk(json?.usage?.input_tokens !== undefined, "missing anthropic usage");
    return `usage=${json.usage.input_tokens}/${json.usage.output_tokens}`;
  });
}

async function anthropicStream(name, model, expectedText) {
  return testCase(name, async () => {
    const res = await postJson(CLAUDE_URL, {
      model,
      messages: [{ role: "user", content: `请只回复 ${expectedText}` }],
      max_tokens: 128,
      stream: true,
    }, {
      "x-api-key": "any",
      "anthropic-version": "2023-06-01",
    });
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const events = parseSse(res.text);
    const joined = events.map((event) => event.data).join("\n");
    assertOk(joined.includes(expectedText), `missing expected text in SSE: ${joined.slice(0, 500)}`);
    assertOk(events.some((event) => event.event === "message_delta" && event.data.includes("usage")), "missing message_delta usage");
    return `events=${events.length}`;
  });
}

async function anthropicToolBridge(name, model) {
  return testCase(name, async () => {
    const res = await postJson(CLAUDE_URL, {
      model,
      messages: [{ role: "user", content: "请使用 Read 工具读取 CLAUDE.md。只发工具调用。" }],
      max_tokens: 512,
      stream: false,
      tools: [{
        name: "Read",
        description: "Read a file from disk",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      }],
    }, {
      "x-api-key": "any",
      "anthropic-version": "2023-06-01",
    });
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const json = parseJson(res.text);
    const tool = json?.content?.find((part) => part.type === "tool_use");
    assertOk(tool, `missing tool_use content=${res.text.slice(0, 500)}`);
    assertOk(tool.name === "Read", `unexpected tool name=${tool.name}`);
    assertOk(tool.input && typeof tool.input.file_path === "string", `missing file_path input=${JSON.stringify(tool.input)}`);
    return `tool=${tool.name}`;
  });
}

async function anthropicToolBridgeStream(name, model) {
  return testCase(name, async () => {
    const res = await postJson(CLAUDE_URL, {
      model,
      messages: [{ role: "user", content: "请使用 Read 工具读取 CLAUDE.md。只发工具调用。" }],
      max_tokens: 512,
      stream: true,
      tools: [{
        name: "Read",
        description: "Read a file from disk",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      }],
    }, {
      "x-api-key": "any",
      "anthropic-version": "2023-06-01",
    });
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const events = parseSse(res.text);
    const starts = events
      .filter((event) => event.event === "content_block_start")
      .map((event) => parseJson(event.data));
    const toolStart = starts.find((event) => event?.content_block?.type === "tool_use");
    assertOk(toolStart, `missing streaming tool_use start=${res.text.slice(0, 500)}`);
    assertOk(toolStart.content_block.name === "Read", `unexpected streaming tool name=${toolStart.content_block.name}`);
    const deltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => parseJson(event.data));
    assertOk(
      deltas.some((event) => event?.delta?.type === "input_json_delta" && event.delta.partial_json.includes("file_path")),
      `missing streaming tool input delta=${res.text.slice(0, 500)}`,
    );
    return `tool=${toolStart.content_block.name}`;
  });
}

async function anthropicToolResultLoop(name, model) {
  return testCase(name, async () => {
    const res = await postJson(CLAUDE_URL, {
      model,
      messages: [
        { role: "user", content: "请使用 Read 工具读取 README.md，然后只回复工具结果里的标记。" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_read_1", name: "Read", input: { file_path: "README.md" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_read_1", content: "LOOP_OK_FROM_TOOL" }],
        },
      ],
      max_tokens: 512,
      stream: false,
      tools: [{
        name: "Read",
        description: "Read a file from disk",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      }],
    }, {
      "x-api-key": "any",
      "anthropic-version": "2023-06-01",
    });
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 300)}`);
    const json = parseJson(res.text);
    const text = json?.content?.map((part) => part.text || "").join("") || "";
    assertOk(text.includes("LOOP_OK_FROM_TOOL"), `unexpected loop response=${res.text.slice(0, 500)}`);
    return "loop=ok";
  });
}

async function testClaudeCode() {
  const ok = [];
  ok.push(await testCase("claudecode proxy health", async () => {
    const res = await fetchText(CLAUDE_HEALTH_URL);
    assertOk(res.status === 200, `status=${res.status} body=${res.text.slice(0, 200)}`);
    const health = parseJson(res.text);
    const expectedFallback = expectedClaudeFallbackModel();
    assertOk(health?.primary === EXPECTED_CLAUDE_PRIMARY_MODEL, `expected primary ${EXPECTED_CLAUDE_PRIMARY_MODEL}, got ${res.text.slice(0, 200)}`);
    assertOk(Array.isArray(health?.models) && health.models.includes(EXPECTED_CLAUDE_PRIMARY_MODEL), `missing primary model=${res.text.slice(0, 200)}`);
    if (expectedFallback) {
      assertOk(health?.fallback === expectedFallback, `expected fallback ${expectedFallback}, got ${res.text.slice(0, 200)}`);
      assertOk(health.models.includes(expectedFallback), `missing fallback model=${res.text.slice(0, 200)}`);
    } else {
      assertOk(health?.fallback === null, `expected no fallback, got ${res.text.slice(0, 200)}`);
    }
    return res.text;
  }));
  ok.push(await anthropicNonStream("claudecode glm-first sonnet alias non-stream", "claude-sonnet-4-5", "SONNET_ALIAS_OK"));
  ok.push(await anthropicStream("claudecode glm-first sonnet alias stream usage", "claude-sonnet-4-5", "SONNET_ALIAS_STREAM_OK"));
  ok.push(await anthropicNonStream("claudecode glm-first haiku alias non-stream", "claude-3-5-haiku-latest", "HAIKU_ALIAS_OK"));
  ok.push(await anthropicStream("claudecode glm-first haiku alias stream usage", "claude-3-5-haiku-latest", "HAIKU_ALIAS_STREAM_OK"));
  ok.push(await anthropicToolBridge("claudecode glm-first sonnet alias tool bridge", "claude-sonnet-4-5"));
  ok.push(await anthropicToolBridge("claudecode glm-first haiku alias tool bridge", "claude-3-5-haiku-latest"));
  ok.push(await anthropicToolBridgeStream("claudecode glm-first haiku alias tool bridge stream", "claude-3-5-haiku-latest"));
  ok.push(await anthropicToolResultLoop("claudecode glm-first haiku alias tool result loop", "claude-3-5-haiku-latest"));
  return ok;
}

async function testClaudeCodeFallback() {
  const ok = [];
  ok.push(await testCase("claudecode GLM fallback mock suite", async () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "test-claudecode-fallback.js")], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: process.env,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    assertOk(result.status === 0, output.slice(-1000) || `exit status ${result.status}`);
    return output.split(/\r?\n/).filter(Boolean).pop();
  }));
  return ok;
}

async function main() {
  const suites = parseSuites();
  const valid = new Set(["direct", "opencode", "codebuddy", "claudecode", "fallback"]);
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
    } else if (suite === "claudecode") {
      results.push(...await testClaudeCode());
    } else if (suite === "fallback") {
      results.push(...await testClaudeCodeFallback());
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
