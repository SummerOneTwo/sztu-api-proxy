#!/usr/bin/env node
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function fetchText(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

function claudeRequestOptions(body) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "any",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
}

async function waitForHealth(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10000) {
    try {
      const res = await fetchText(url, {}, 1000);
      if (res.status === 200) {
        return;
      }
      lastError = new Error(`health status ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error("proxy health timed out");
}

function postClaude(port, body) {
  return fetchText(`http://127.0.0.1:${port}/v1/messages`, claudeRequestOptions(body));
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

function assertAnthropicMessage(res, expectedText) {
  assert.strictEqual(res.status, 200, res.text);
  const json = JSON.parse(res.text);
  assert.strictEqual(json.type, "message", res.text);
  assert.strictEqual(json.role, "assistant", res.text);
  assert(!Array.isArray(json.choices), res.text);
  const text = (json.content || []).map((part) => part.type === "text" ? part.text : "").join("");
  assert(text.includes(expectedText), res.text);
  assert(Number.isFinite(json.usage?.input_tokens), res.text);
  assert(Number.isFinite(json.usage?.output_tokens), res.text);
}

function assertAnthropicSse(res, expectedText) {
  assert.strictEqual(res.status, 200, res.text);
  const events = parseSse(res.text);
  assert.strictEqual(events[0]?.event, "message_start", res.text);
  assert(events.some((event) => event.event === "content_block_start"), res.text);
  const deltas = events.filter((event) => event.event === "content_block_delta").map((event) => JSON.parse(event.data));
  const text = deltas.map((event) => event?.delta?.type === "text_delta" ? event.delta.text : "").join("");
  assert(text.includes(expectedText), res.text);
  assert(events.some((event) => event.event === "message_delta" && event.data.includes("usage")), res.text);
  assert.strictEqual(events[events.length - 1]?.event, "message_stop", res.text);
  assert(!res.text.includes("\"choices\""), res.text);
}

async function postClaudeResponse(port, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      ...claudeRequestOptions(body),
      signal: controller.signal,
    });
    return { res, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    const text = await readBody(req);
    const body = JSON.parse(text || "{}");
    requests.push(body);
    const messageText = (body.messages || []).map((message) => String(message.content || "")).join("\n");
    if (body.model === "glm-5.1") {
      if (messageText.includes("network error")) {
        res.destroy(new Error("mock glm network error"));
        return;
      }
      if (body.stream === true && messageText.includes("slow stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"choices\":[{\"delta\":{\"content\":\"SLOW_STREAM_OK\"},\"finish_reason\":null}]}\n\n");
        await new Promise((resolve) => setTimeout(resolve, 1800));
        res.end([
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
        return;
      }
      if (body.stream === true && messageText.includes("usage-only empty stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":0}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
        return;
      }
      if (body.stream === true && messageText.includes("empty stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":0}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
        return;
      }
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("mock glm unavailable");
      return;
    }
    if (body.model === "deepseek-v4-pro") {
      if (messageText.includes("fallback failure")) {
        res.destroy(new Error("mock fallback network error"));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"FALLBACK_OK\"},\"finish_reason\":null}]}",
          "",
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
        return;
      }
      const payload = {
        id: "mock_fallback",
        object: "chat.completion",
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "FALLBACK_OK" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`unexpected model ${body.model}`);
  });

  const mockPort = await listen(mock);
  const proxyPort = await freePort();
  const child = spawn(process.execPath, ["claudecode/claudecode-proxy.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SZTU_API_KEY: "mock-key",
      SZTU_UPSTREAM_URL: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
      CLAUDE_SZTU_PROXY_PORT: String(proxyPort),
      SZTU_DEFAULT_MODEL: "glm-5.1",
      CLAUDE_SZTU_FALLBACK_MODEL: "deepseek-v4-pro",
      CLAUDE_SZTU_UPSTREAM_RETRY_ATTEMPTS: "1",
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(`http://127.0.0.1:${proxyPort}/health`);

    requests.length = 0;
    const fallbackRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "reply fallback ok" }],
      max_tokens: 128,
    });
    assertAnthropicMessage(fallbackRes, "FALLBACK_OK");
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1", "deepseek-v4-pro"]);

    requests.length = 0;
    const networkFallbackRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "network error should fall back" }],
      max_tokens: 128,
    });
    assertAnthropicMessage(networkFallbackRes, "FALLBACK_OK");
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1", "deepseek-v4-pro"]);

    requests.length = 0;
    const emptyStreamFallbackRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "empty stream should fall back" }],
      max_tokens: 128,
      stream: true,
    });
    assertAnthropicSse(emptyStreamFallbackRes, "FALLBACK_OK");
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1", "deepseek-v4-pro"]);

    requests.length = 0;
    const usageOnlyFallbackRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "usage-only empty stream should fall back" }],
      max_tokens: 128,
      stream: true,
    });
    assertAnthropicSse(usageOnlyFallbackRes, "FALLBACK_OK");
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1", "deepseek-v4-pro"]);

    requests.length = 0;
    const fallbackFailureRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "empty stream fallback failure" }],
      max_tokens: 128,
      stream: true,
    });
    assert.strictEqual(fallbackFailureRes.status, 424, fallbackFailureRes.text);
    assert.strictEqual(JSON.parse(fallbackFailureRes.text)?.error?.type, "api_error", fallbackFailureRes.text);
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1", "deepseek-v4-pro"]);

    requests.length = 0;
    const earlyStream = await postClaudeResponse(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "slow stream should send headers early" }],
      max_tokens: 128,
      stream: true,
    }, 1000);
    assert.strictEqual(earlyStream.res.status, 200);
    assert(earlyStream.elapsedMs < 1000, `stream headers were delayed ${earlyStream.elapsedMs}ms`);
    assertAnthropicSse({ status: earlyStream.res.status, text: await earlyStream.res.text() }, "SLOW_STREAM_OK");
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1"]);

    requests.length = 0;
    const readOnlyFallbackRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "read README" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "tool output" }] },
      ],
      max_tokens: 128,
      tools: [{
        name: "Read",
        description: "Read file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      }],
    });
    assertAnthropicMessage(readOnlyFallbackRes, "FALLBACK_OK");
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1", "deepseek-v4-pro"]);

    requests.length = 0;
    const noFallbackRes = await postClaude(proxyPort, {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "run command" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "Bash", input: { command: "echo hi" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "hi" }] },
      ],
      max_tokens: 128,
      tools: [{
        name: "Bash",
        description: "Run shell command",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      }],
    });
    assert.strictEqual(noFallbackRes.status, 424, noFallbackRes.text);
    assert.deepStrictEqual(requests.map((body) => body.model), ["glm-5.1"]);
    console.log("claudecode fallback tests ok");
  } finally {
    child.kill();
    await close(mock);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
