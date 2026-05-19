const http = require("http");
const fs = require("fs");
const path = require("path");
const { getApiKey, envNumber } = require("../shared/env");
const { createLogger, durationMs, makeRequestId, preview, summarizeBody } = require("../shared/logger");

const HOST = "127.0.0.1";
const PORT = envNumber("OPENCODE_PROXY_PORT", 8788);
const UPSTREAM_HOST = "apiai.sztu.edu.cn";
const UPSTREAM_PATH = "/v1/chat/completions";
const CONFIG_DIR = __dirname;
const RUNTIME_DIR = path.join(CONFIG_DIR, ".runtime");
const LOG_PATH = path.join(RUNTIME_DIR, "opencode-proxy.log");
const PID_PATH = path.join(RUNTIME_DIR, "opencode-proxy.pid");
const DEFAULT_MAX_TOKENS = envNumber("SZTU_DEFAULT_MAX_TOKENS", 16384);
const MAX_TOKENS = envNumber("SZTU_MAX_TOKENS", 32768);

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

const log = createLogger("opencode", LOG_PATH);

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

function normalizeMaxTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return Math.min(DEFAULT_MAX_TOKENS, MAX_TOKENS);
  }
  return Math.min(Math.trunc(number), DEFAULT_MAX_TOKENS, MAX_TOKENS);
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
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    next.tool_calls = message.tool_calls;
  }
  if (Object.prototype.hasOwnProperty.call(message || {}, "content")) {
    next.content = Array.isArray(message.content) ? flattenContent(message.content) : message.content;
    if (next.content && typeof next.content === "object") {
      next.content = JSON.stringify(next.content);
    }
  }
  if (next.role === "tool" && typeof next.content !== "string") {
    next.content = next.content == null ? "" : JSON.stringify(next.content);
  }
  return next;
}

function normalizeBody(body) {
  const maxTokens = normalizeMaxTokens(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens);
  const requestedModel = typeof body.model === "string" ? body.model.split("/").pop() : "";
  const model = requestedModel === "deepseek-v4-pro" ? "deepseek-v4-pro" : "glm-5.1";
  const next = {
    ...body,
    model,
  };

  if (Array.isArray(body.messages)) {
    next.messages = body.messages.map(normalizeMessage).filter((message) => message.role);
  }

  if (maxTokens !== undefined) {
    next.max_tokens = maxTokens;
  }

  const template = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" ? body.chat_template_kwargs : {};
  if (model === "deepseek-v4-pro") {
    next.chat_template_kwargs = {
      thinking: false,
      ...template,
    };
  } else {
    next.chat_template_kwargs = {
      enable_thinking: false,
      ...template,
    };
  }

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

function transformSseEvent(eventText, upstreamModel) {
  const lines = eventText.split(/\r?\n/);
  return lines
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }

      const prefixMatch = line.match(/^data:\s*/);
      const prefix = prefixMatch ? prefixMatch[0] : "data: ";
      const dataText = line.slice(prefix.length);
      if (dataText === "[DONE]") {
        return line;
      }

      try {
        const payload = JSON.parse(dataText);
        if (upstreamModel === "glm-5.1") {
          for (const choice of payload.choices || []) {
            const delta = choice.delta;
            if (delta && typeof delta.reasoning === "string" && delta.reasoning_content === undefined) {
              delta.reasoning_content = delta.reasoning;
              delete delta.reasoning;
            }
          }
        }
        return `${prefix}${JSON.stringify(payload)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
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
  log("request", {
    requestId,
    method: req.method,
    url: req.url,
    client: summarizeBody(body),
    upstream: summarizeBody(upstreamBody),
    upstreamBytes: Buffer.byteLength(payload),
  });

  fetch(`https://${UPSTREAM_HOST}${UPSTREAM_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: upstreamBody.stream === true ? "text/event-stream" : "application/json",
    },
    body: payload,
  })
    .then(async (upstreamRes) => {
      const contentType = upstreamRes.headers.get("content-type") || "";
      log("upstream-response-start", {
        requestId,
        status: upstreamRes.status,
        contentType,
        durationMs: durationMs(startedAt),
      });
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
      let sseBuffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (upstreamBody.stream === true && upstreamBody.model === "glm-5.1") {
          sseBuffer += chunk.toString("utf8");
          const events = sseBuffer.split(/\r?\n\r?\n/);
          sseBuffer = events.pop() || "";
          for (const eventText of events) {
            res.write(`${transformSseEvent(eventText, upstreamBody.model)}\n\n`);
          }
        } else {
          res.write(chunk);
        }
      }
      if (sseBuffer) {
        res.write(transformSseEvent(sseBuffer, upstreamBody.model));
      }
      log("response", {
        requestId,
        status: upstreamRes.status,
        bytes,
        durationMs: durationMs(startedAt),
        errorPreview: upstreamRes.status >= 400 ? preview(sseBuffer, 1000) : undefined,
      });
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
      writeJson(res, 200, { ok: true, models: ["glm-5.1", "deepseek-v4-pro"] });
      return;
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      writeJson(res, 200, {
        object: "list",
        data: [
          { id: "glm-5.1", object: "model", created: 0, owned_by: "sztu" },
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
