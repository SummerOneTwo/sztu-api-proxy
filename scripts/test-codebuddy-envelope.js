#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  parseClientBody,
  parseEnvelopeHeaders,
  salvageTruncatedEnvelope,
  sanitizeBody,
  sendEnvelopeRetryResponse,
} = require("../codebuddy/codebuddy-proxy");

const { fixturesDir } = require("../shared/runtime-paths");

const CODEBUDDY_DIR = path.join(__dirname, "../codebuddy");
const FIXTURES_DIR = fixturesDir(CODEBUDDY_DIR);
const RUNTIME_DIR = path.join(CODEBUDDY_DIR, ".runtime");
const PROXY_URL = `http://127.0.0.1:${process.env.CODEBUDDY_PROXY_PORT || 8787}`;

function log(status, name, detail = "") {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[${status.padEnd(4)}] ${name}${suffix}`);
}

function makeEnvelopeHeaders(conversationId, contentLength) {
  return [
    "POST http://127.0.0.1:8787/v1/chat/completions HTTP/1.1",
    "Accept: application/json",
    "Content-Type: application/json",
    "x-codebuddy-request: 1",
    `X-Conversation-ID: ${conversationId}`,
    `Content-Length: ${contentLength}`,
    "",
    "",
  ].join("\r\n");
}

function testPureJsonBody() {
  const body = {
    model: "deepseek-v4-pro-instruct",
    messages: [{ role: "user", content: "ping" }],
    stream: false,
  };
  const parsed = parseClientBody(JSON.stringify(body), "test-json");
  assert.strictEqual(parsed.messages[0].content, "ping");
  log("PASS", "pure JSON body parse");
}

function testHeaderOnlyEnvelope() {
  const conversationId = "test-header-only";
  const raw = makeEnvelopeHeaders(conversationId, 158559);
  const metrics = parseEnvelopeHeaders(raw);
  assert(metrics.incomplete, "expected incomplete content length");
  let threw = false;
  try {
    parseClientBody(raw, "test-header", { "x-conversation-id": conversationId });
  } catch (error) {
    threw = true;
    assert.strictEqual(error.message, "http_envelope_without_json_body");
    assert.strictEqual(error.envelopeReason, "incomplete_content_length");
  }
  assert(threw, "header-only envelope should throw");
  log("PASS", "header-only envelope throws retryable error");
}

function testTruncatedEnvelopeSalvage() {
  const names = [
    "envelope-fail-cb_mquz401x_qhwduv.txt",
    path.join("..", "envelope-fail-cb_mquz401x_qhwduv.txt"),
  ];
  let fixturePath = null;
  for (const name of names) {
    const candidate = path.join(FIXTURES_DIR, path.basename(name));
    if (fs.existsSync(candidate)) {
      fixturePath = candidate;
      break;
    }
    const legacy = path.join(RUNTIME_DIR, path.basename(name));
    if (fs.existsSync(legacy)) {
      fixturePath = legacy;
      break;
    }
  }
  if (!fixturePath) {
    log("SKIP", "truncated envelope salvage", "fixture missing");
    return;
  }
  const full = fs.readFileSync(fixturePath, "utf8");
  const bodyStart = full.indexOf("\r\n\r\n");
  assert(bodyStart >= 0, "fixture should contain envelope separator");
  const truncated = full.slice(0, bodyStart + 4 + 120000);
  const conversationId = "test-salvage";
  const prior = {
    model: "deepseek-v4-pro-instruct",
    messages: [{ role: "user", content: "seed" }],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: {} } } }],
    stream: true,
    max_tokens: 4096,
  };
  parseClientBody(JSON.stringify(prior), "seed", { "x-conversation-id": conversationId });
  const salvaged = salvageTruncatedEnvelope(truncated, conversationId);
  assert(salvaged, "expected salvage from truncated fixture");
  assert(Array.isArray(salvaged.body.messages) && salvaged.body.messages.length > 0);
  assert(salvaged.meta.toolsCount > 0, "expected tools from cache/body");
  log("PASS", "truncated envelope salvage", `messages=${salvaged.body.messages.length} tools=${salvaged.meta.toolsCount}`);
}

function testEnvelopeRetryResponse() {
  const server = http.createServer((req, res) => {
    sendEnvelopeRetryResponse(res, "test-req", Date.now(), {
      reason: "missing_json_body",
      bodyBytes: 10288,
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          server.close();
          try {
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.headers["retry-after"], "1");
            const json = JSON.parse(data);
            assert.strictEqual(json.error.type, "incomplete_envelope");
            assert.strictEqual(json.error.retryable, true);
            log("PASS", "envelope retry response");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }).on("error", reject);
    });
  });
}

function proxyPost(raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/chat/completions", PROXY_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer any",
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

async function testProxyHeaderOnlyReturns503() {
  const conversationId = "proxy-header-only-test";
  const raw = makeEnvelopeHeaders(conversationId, 158559);
  try {
    const res = await proxyPost(raw, { "x-conversation-id": conversationId });
    assert.strictEqual(res.status, 503, `expected 503, got ${res.status} body=${res.body.slice(0, 200)}`);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.error.retryable, true);
    log("PASS", "proxy header-only returns 503");
  } catch (error) {
    if (error.code === "ECONNREFUSED") {
      log("SKIP", "proxy header-only returns 503", "proxy not running");
      return;
    }
    throw error;
  }
}

async function main() {
  testPureJsonBody();
  testHeaderOnlyEnvelope();
  testTruncatedEnvelopeSalvage();
  await testEnvelopeRetryResponse();
  await testProxyHeaderOnlyReturns503();
  console.log("\nAll codebuddy envelope tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
