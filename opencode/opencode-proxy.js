const http = require("http");
const fs = require("fs");
const path = require("path");
const { getApiKey, envNumber } = require("../shared/env");
const { pidPath, streamPath: streamFilePath } = require("../shared/runtime-paths");
const { createLogger, durationMs, makeRequestId, requestMeta } = require("../shared/logger");

const HOST = "127.0.0.1";
const PORT = envNumber("OPENCODE_PROXY_PORT", 8788);
const UPSTREAM_HOST = "apiai.sztu.edu.cn";
const UPSTREAM_PATH = "/v1/chat/completions";
const SERVICE_DIR = __dirname;
const RUNTIME_DIR = path.join(SERVICE_DIR, ".runtime");
const PID_PATH = pidPath(SERVICE_DIR, "opencode-proxy");
const DEFAULT_MAX_TOKENS = 8192;
const MAX_TOKENS = 32768;

const { log, logPayload, logRequestBodies, logStream } = createLogger("opencode", SERVICE_DIR);

function readApiKey() {
  return getApiKey();
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, requestId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === 3) {
        return response;
      }
      const text = await response.text().catch(() => "");
      logPayload(requestId, `retry-${attempt}.txt`, text);
      log("upstream-retryable-status", { requestId, attempt, status: response.status });
    } catch (error) {
      lastError = error;
      if (attempt === 3) {
        break;
      }
      log("upstream-retryable-error", { requestId, attempt, error });
    }
    await delay(500 * attempt);
  }
  throw lastError;
}

function normalizeMaxTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(Math.trunc(number), MAX_TOKENS);
}

function flattenContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : String(content);
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "image_url" || part.type === "input_image") {
        return "[image omitted]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeMessage(message) {
  const next = {};
  if (typeof message?.role === "string") {
    next.role = message.role;
  }
  if (typeof message?.name === "string") {
    next.name = message.name;
  }
  if (typeof message?.tool_call_id === "string") {
    next.tool_call_id = message.tool_call_id;
  }
  if (Object.prototype.hasOwnProperty.call(message || {}, "content")) {
    next.content = Array.isArray(message.content) ? flattenContent(message.content) : message.content;
    if (next.content && typeof next.content === "object") {
      next.content = JSON.stringify(next.content);
    }
  }
  if (next.role === "tool") {
    next.role = "user";
    next.content = `Tool result${next.tool_call_id ? ` ${next.tool_call_id}` : ""}:\n${next.content == null ? "" : next.content}`;
    delete next.tool_call_id;
  }
  if (next.role === "tool" && typeof next.content !== "string") {
    next.content = next.content == null ? "" : JSON.stringify(next.content);
  }
  return next;
}

function normalizeBody(body) {
  const maxTokens = normalizeMaxTokens(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens);
  const next = {
    ...body,
    model: "deepseek-v4-pro",
  };

  if (Array.isArray(body.messages)) {
    next.messages = body.messages.map(normalizeMessage).filter((message) => message.role);
  }

  if (maxTokens !== undefined) {
    next.max_tokens = maxTokens;
  }

  const template = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" ? body.chat_template_kwargs : {};
  next.chat_template_kwargs = {
    thinking: false,
    ...template,
  };

  if (next.stream === true) {
    next.stream_options = {
      ...(body.stream_options && typeof body.stream_options === "object" ? body.stream_options : {}),
      include_usage: true,
    };
  } else {
    delete next.stream_options;
  }

  if (Array.isArray(next.tools) && next.tools.length === 0) {
    delete next.tools;
  }

  delete next.max_completion_tokens;
  delete next.max_output_tokens;
  delete next.reasoning;
  delete next.reasoning_effort;
  delete next.providerOptions;
  delete next.experimental_providerMetadata;
  delete next.experimental_telemetry;
  delete next.headers;
  delete next.user;

  return next;
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function proxyRequest(req, res, body) {
  const requestId = makeRequestId("oc");
  const startedAt = Date.now();
  const apiKey = readApiKey();
  if (!apiKey) {
    log("missing-api-key", { requestId });
    writeJson(res, 500, { error: "missing SZTU API key" });
    return;
  }

  const upstreamBody = normalizeBody(body);
  const payload = JSON.stringify(upstreamBody);
  logRequestBodies(requestId, body, upstreamBody);
  log("request", {
    requestId,
    method: req.method,
    url: req.url,
    ...requestMeta(upstreamBody),
    upstreamBytes: Buffer.byteLength(payload),
  });

  fetchWithRetry(`https://${UPSTREAM_HOST}${UPSTREAM_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: upstreamBody.stream === true ? "text/event-stream" : "application/json",
    },
    body: payload,
  }, requestId)
    .then(async (upstreamRes) => {
      const contentType = upstreamRes.headers.get("content-type") || "";
      log("upstream-response-start", {
        requestId,
        status: upstreamRes.status,
        contentType,
        durationMs: durationMs(startedAt),
      });

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => "");
        logPayload(requestId, "error.txt", text);
        log("upstream-error-response", {
          requestId,
          status: upstreamRes.status,
          durationMs: durationMs(startedAt),
        });
        writeJson(res, upstreamRes.status, {
          error: {
            message: text.slice(0, 1000) || `upstream returned ${upstreamRes.status}`,
            type: "upstream_error",
            status: upstreamRes.status,
          },
        });
        return;
      }

      res.writeHead(upstreamRes.status, {
        "Content-Type":
          upstreamBody.stream === true
            ? "text/event-stream; charset=utf-8"
            : contentType || "application/json; charset=utf-8",
        "Cache-Control": upstreamRes.headers.get("cache-control") || "no-cache",
        Connection: "keep-alive",
      });

      if (!upstreamRes.body) {
        log("response", { requestId, status: upstreamRes.status, bytes: 0, durationMs: durationMs(startedAt) });
        res.end();
        return;
      }

      const reader = upstreamRes.body.getReader();
      let bytes = 0;
      let responseBody = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        responseBody += chunk.toString("utf8");
        res.write(chunk);
      }
      if (upstreamBody.stream === true) {
        logStream(requestId, responseBody);
        log("stream-response", {
          requestId,
          status: upstreamRes.status,
          bytes,
          streamFile: path.relative(RUNTIME_DIR, streamFilePath(SERVICE_DIR, requestId)).replace(/\\/g, "/"),
          durationMs: durationMs(startedAt),
        });
      } else {
        let parsed;
        try {
          parsed = JSON.parse(responseBody);
          logPayload(requestId, "response.json", parsed);
        } catch {
          logPayload(requestId, "response.txt", responseBody);
        }
        log("response", {
          requestId,
          status: upstreamRes.status,
          bytes,
          usage: parsed?.usage,
          finishReason: parsed?.choices?.[0]?.finish_reason,
          durationMs: durationMs(startedAt),
        });
      }
      res.end();
    })
    .catch((error) => {
      log("upstream-error", { requestId, durationMs: durationMs(startedAt), error });
      if (!res.headersSent) {
        writeJson(res, 502, { error: error.message, cause: error.cause?.message });
        return;
      }
      res.end();
    });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true, models: ["deepseek-v4-pro"] });
      return;
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      writeJson(res, 200, {
        object: "list",
        data: [
          { id: "deepseek-v4-pro", object: "model", created: 0, owned_by: "sztu" },
        ],
      });
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      writeJson(res, 404, { error: "not found" });
      return;
    }

    const body = await readRequestJson(req);
    proxyRequest(req, res, body);
  } catch (error) {
    log("proxy-error", { message: error.message, stack: error.stack });
    writeJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
  log("listening", { host: HOST, port: PORT });
});

function cleanup() {
  try {
    if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch {}
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);
