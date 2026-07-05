const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { getApiKey, envNumber } = require("../shared/env");
const { createLogger, durationMs, makeRequestId, preview, summarizeBody: summarizeSharedBody } = require("../shared/logger");

const PORT = envNumber("CODEBUDDY_PROXY_PORT", envNumber("PORT", 8787));
const TARGET_HOST = "apiai.sztu.edu.cn";
const TARGET_PATH = "/v1/chat/completions";
const LOG_DIR = path.join(__dirname, ".runtime");
const LOG_PATH = path.join(LOG_DIR, "codebuddy-proxy.log");
const PID_PATH = path.join(LOG_DIR, "codebuddy-proxy.pid");
const SZTU_DEFAULT_MAX_TOKENS = envNumber("SZTU_DEFAULT_MAX_TOKENS", 8192);
const SZTU_MAX_TOKENS = envNumber("SZTU_MAX_TOKENS", 32768);
const DSV4_API_MODEL = "deepseek-v4-pro";
const DSV4_MAX_TIER_FLOOR = 4000;
const CLIENT_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-pro-instruct",
  "deepseek-v4-pro-max",
];

fs.mkdirSync(LOG_DIR, { recursive: true });

const log = createLogger("codebuddy", LOG_PATH);

function cleanupAndExit(signal) {
  log("shutdown", { signal });
  try {
    if (fs.existsSync(PID_PATH)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch (error) {
    log("pid-cleanup-error", { error });
  }
  process.exit(0);
}

function normalizeMaxTokens(value, tier) {
  const n = Number(value);
  let result;
  if (!Number.isFinite(n) || n <= 0) {
    result = Math.min(SZTU_DEFAULT_MAX_TOKENS, SZTU_MAX_TOKENS);
  } else {
    result = Math.min(Math.trunc(n), SZTU_MAX_TOKENS);
  }
  if (tier === "max" && result < DSV4_MAX_TIER_FLOOR) {
    result = DSV4_MAX_TIER_FLOOR;
  }
  return result;
}

const DSV4_INSTRUCT_ALIASES = new Set([
  "deepseek-v4-pro-instruct",
  "deepseek-v4-pro-nothink",
]);

function parseClientModelId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  const normalized = raw.split(":").pop().trim();
  if (normalized.startsWith("deepseek-v4-pro")) {
    return normalized;
  }
  return normalized.split("/").pop().trim();
}

function resolveModel(value) {
  const model = parseClientModelId(value);
  if (DSV4_INSTRUCT_ALIASES.has(model)) {
    return {
      clientModel: "deepseek-v4-pro-instruct",
      apiModel: DSV4_API_MODEL,
      thinking: false,
      tier: "instruct",
    };
  }
  if (model === "deepseek-v4-pro-max") {
    return {
      clientModel: "deepseek-v4-pro-max",
      apiModel: DSV4_API_MODEL,
      thinking: true,
      reasoningEffort: "max",
      tier: "max",
    };
  }
  if (model === "deepseek-v4-pro") {
    return {
      clientModel: "deepseek-v4-pro",
      apiModel: DSV4_API_MODEL,
      thinking: true,
      reasoningEffort: "high",
      tier: "high",
    };
  }
  return null;
}

function normalizeModel(value) {
  const resolved = resolveModel(value);
  return resolved ? resolved.apiModel : DSV4_API_MODEL;
}

function sanitizeBody(body) {
  const next = { ...body };
  const resolved = resolveModel(next.model);
  if (!resolved) {
    const error = new Error(`unsupported model: ${next.model}`);
    error.code = "UNSUPPORTED_MODEL";
    throw error;
  }
  next.model = resolved.apiModel;

  next.max_tokens = normalizeMaxTokens(
    next.max_tokens ?? next.max_completion_tokens ?? next.max_output_tokens,
    resolved.tier
  );
  delete next.max_completion_tokens;
  delete next.max_output_tokens;

  // Keep unsupported request knobs out, but preserve the OpenAI tool-calling
  // fields CodeBuddy needs to execute tools across turns.
  delete next.reasoning_effort;
  delete next.reasoning;
  if (next.stream === true) {
    next.stream_options = {
      ...(next.stream_options && typeof next.stream_options === "object"
        ? next.stream_options
        : {}),
      include_usage: true,
    };
  } else {
    delete next.stream_options;
  }

  const template = next.chat_template_kwargs && typeof next.chat_template_kwargs === "object"
    ? next.chat_template_kwargs
    : {};
  if (resolved.thinking) {
    next.chat_template_kwargs = {
      ...template,
      thinking: true,
      reasoning_effort: resolved.reasoningEffort,
    };
  } else {
    next.chat_template_kwargs = {
      ...template,
      thinking: false,
    };
  }

  if (Array.isArray(next.tools) && next.tools.length === 0) {
    delete next.tools;
  }

  if (Array.isArray(next.messages)) {
    next.messages = next.messages
      .map((message) => {
        const clean = {};

        if (message && typeof message.role === "string") {
          clean.role = message.role;
        }

        if (message?.role === "tool") {
          clean.role = "user";
          const text = flattenContent(message.content) || String(message.content || "");
          clean.content = `Tool result${message.tool_call_id ? ` for ${message.tool_call_id}` : ""}:\n${text}`;
          return clean;
        } else if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
          // The SZTU endpoint can return tool calls, but rejects tool_calls in
          // historical assistant messages. Dropping those records is safer than
          // turning them into natural language that the model may later imitate.
          return null;
        } else if (Array.isArray(message?.content)) {
          clean.content = flattenContent(message.content);
        } else if (typeof message?.content === "string") {
          clean.content = message.content;
        } else if (message && Object.prototype.hasOwnProperty.call(message, "content")) {
          clean.content = message.content;
        }

        if (typeof message?.name === "string") {
          clean.name = message.name;
        }

        return clean;
      })
      .filter(Boolean);
  }

  return next;
}

function flattenContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") {
        return typeof item.text === "string" ? item.text : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function responsesToChatCompletions(body) {
  const messages = [];

  if (typeof body?.instructions === "string" && body.instructions.trim()) {
    messages.push({
      role: "system",
      content: body.instructions,
    });
  }

  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const role = typeof item.role === "string" ? item.role : "user";
      const content = flattenContent(item.content);
      if (!content) {
        continue;
      }

      messages.push({ role, content });
    }
  } else if (typeof body?.input === "string" && body.input.trim()) {
    messages.push({
      role: "user",
      content: body.input,
    });
  }

  return sanitizeBody({
    model: body.model,
    messages,
    stream: body.stream === true,
    stream_options: body.stream === true ? { include_usage: true } : undefined,
    max_tokens: body.max_output_tokens || body.max_tokens,
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    chat_template_kwargs: body.chat_template_kwargs,
  });
}

function chatCompletionsToResponses(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const createdAt = typeof payload?.created === "number" ? payload.created : Math.floor(Date.now() / 1000);

  return {
    id: payload?.id || `resp_${Date.now()}`,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model: payload?.model,
    output: [
      {
        type: "message",
        id: `msg_${Date.now()}`,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    output_text: text,
    tool_calls: message.tool_calls,
    usage: payload?.usage
      ? {
        input_tokens: payload.usage.prompt_tokens || 0,
        output_tokens: payload.usage.completion_tokens || 0,
        total_tokens: payload.usage.total_tokens || 0,
      }
      : undefined,
  };
}

function summarizeCodebuddyBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const inputItems = Array.isArray(body?.input) ? body.input : [];
  const contentChars = messages.reduce((sum, message) => {
    const content = typeof message?.content === "string" ? message.content : flattenContent(message?.content);
    return sum + content.length;
  }, 0);

  return {
    model: body?.model,
    stream: body?.stream === true,
    messages: messages.length || undefined,
    input_items: inputItems.length || undefined,
    content_chars: contentChars || undefined,
    tools: Array.isArray(body?.tools) ? body.tools.length : undefined,
    tool_choice: body?.tool_choice,
    max_tokens: body?.max_tokens,
    max_completion_tokens: body?.max_completion_tokens,
  };
}

function writeSse(res, payload, eventName) {
  if (eventName) {
    res.write(`event: ${eventName}\n`);
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

function forwardChatCompletionStream(res, upstreamRes, requestId, startedAt) {
  res.writeHead(upstreamRes.statusCode || 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": upstreamRes.headers["cache-control"] || "no-cache",
    Connection: "keep-alive",
  });
  let bytes = 0;
  upstreamRes.on("data", (chunk) => {
    bytes += chunk.length;
  });
  upstreamRes.on("end", () => {
    log("stream-response", {
      requestId,
      status: upstreamRes.statusCode,
      bytes,
      durationMs: durationMs(startedAt),
    });
  });
  upstreamRes.pipe(res);
}

function emitResponsesStreamFromChatStream(res, upstreamRes, requestId, startedAt) {
  const createdAt = Math.floor(Date.now() / 1000);
  const responseId = `resp_${Date.now()}`;
  let model;
  let outputText = "";
  let usage;
  let finishReason = "stop";
  let buffer = "";
  let completed = false;

  res.writeHead(upstreamRes.statusCode || 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  writeSse(
    res,
    {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status: "in_progress",
      type: "response.created",
    },
    "response.created"
  );

  function complete() {
    if (completed) {
      return;
    }
    completed = true;
    writeSse(
      res,
      {
        id: responseId,
        object: "response",
        created_at: createdAt,
        status: "completed",
        type: "response.completed",
        model,
        output: [
          {
            type: "message",
            id: `msg_${Date.now()}`,
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: outputText,
                annotations: [],
              },
            ],
          },
        ],
        output_text: outputText,
        usage: usage
          ? {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || 0,
          }
          : undefined,
        finish_reason: finishReason,
      },
      "response.completed"
    );
    writeSseDone(res);
  }

  function handleEvent(eventText) {
    const dataLines = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) {
      return;
    }

    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") {
      complete();
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(dataText);
    } catch (error) {
      log("invalid-upstream-sse-json", { requestId, error, dataPreview: preview(dataText, 1000) });
      return;
    }

    if (chunk.model && !model) {
      model = chunk.model;
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      return;
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      outputText += delta.content;
      writeSse(
        res,
        {
          type: "response.output_text.delta",
          response_id: responseId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        },
        "response.output_text.delta"
      );
    }
  }

  upstreamRes.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) {
      handleEvent(part);
    }
  });

  upstreamRes.on("end", () => {
    if (buffer.trim()) {
      handleEvent(buffer);
    }
    complete();
    log("responses-stream-response", {
      requestId,
      status: upstreamRes.statusCode,
      usage,
      finishReason,
      outputChars: outputText.length,
      durationMs: durationMs(startedAt),
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestUpstreamOnce(payload, apiKey, wantsStream, requestId, startedAt) {
  return new Promise((resolve, reject) => {
    const upstream = https.request(
      {
        hostname: TARGET_HOST,
        path: TARGET_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: wantsStream ? "text/event-stream" : "application/json",
        },
      },
      (upstreamRes) => {
        log("upstream-response-start", {
          requestId,
          status: upstreamRes.statusCode,
          contentType: upstreamRes.headers["content-type"],
          durationMs: durationMs(startedAt),
        });

        if (wantsStream && (upstreamRes.statusCode || 500) < 400) {
          resolve({ type: "stream", upstreamRes });
          return;
        }

        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const rawResponse = Buffer.concat(chunks);
          const text = rawResponse.toString("utf8");
          resolve({
            type: (upstreamRes.statusCode || 500) >= 400 ? "error" : "json",
            retryable: (upstreamRes.statusCode || 500) >= 500,
            upstreamRes,
            rawResponse,
            text,
          });
        });
      }
    );

    upstream.on("error", reject);
    upstream.write(payload);
    upstream.end();
  });
}

async function requestUpstreamWithRetry(payload, apiKey, wantsStream, requestId, startedAt) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await requestUpstreamOnce(payload, apiKey, wantsStream, requestId, startedAt);
      if (result.retryable && attempt < 3) {
        log("upstream-retryable-status", {
          requestId,
          attempt,
          status: result.upstreamRes.statusCode,
          bodyPreview: preview(result.text, 1000),
        });
        await delay(500 * attempt);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= 3) {
        break;
      }
      log("upstream-retryable-error", { requestId, attempt, error });
      await delay(500 * attempt);
    }
  }
  throw lastError;
}

function writeJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const requestId = makeRequestId("cb");
  const startedAt = Date.now();
  const pathName = new URL(req.url || "/", `http://127.0.0.1:${PORT}`).pathname;
  if (req.method === "GET" && pathName === "/health") {
    writeJson(res, 200, {
      ok: true,
      models: CLIENT_MODELS,
    });
    return;
  }
  if (req.method === "GET" && pathName === "/v1/models") {
    writeJson(res, 200, {
      object: "list",
      data: CLIENT_MODELS.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "sztu",
      })),
    });
    return;
  }
  if (req.method !== "POST" || (pathName !== "/v1/chat/completions" && pathName !== "/v1/responses")) {
    log("not-found", { requestId, method: req.method, url: req.url, pathName });
    writeJson(res, 404, { error: "not found" });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;

    try {
      body = JSON.parse(raw);
    } catch (error) {
      log("invalid-json", { requestId, error, bodyPreview: preview(raw, 1000) });
      writeJson(res, 400, { error: "invalid json" });
      return;
    }

    const isResponsesApi = pathName === "/v1/responses";
    let nextBody;
    try {
      nextBody = isResponsesApi ? responsesToChatCompletions(body) : sanitizeBody(body);
    } catch (error) {
      if (error && error.code === "UNSUPPORTED_MODEL") {
        log("unsupported-model", { requestId, model: body?.model });
        writeJson(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    const wantsStream = nextBody.stream === true;
    const upstreamBody = nextBody;
    const apiKey = getApiKey();
    if (!apiKey) {
      log("missing-api-key", { requestId });
      writeJson(res, 500, { error: "missing SZTU_API_KEY in environment or .env" });
      return;
    }
    const payload = JSON.stringify(upstreamBody);
    log("request", {
      requestId,
      method: req.method,
      url: req.url,
      isResponsesApi,
      client: summarizeSharedBody(body),
      sanitized: summarizeCodebuddyBody(nextBody),
      upstream: summarizeSharedBody(upstreamBody),
      upstreamBytes: Buffer.byteLength(payload),
    });

    requestUpstreamWithRetry(payload, apiKey, wantsStream, requestId, startedAt)
      .then((result) => {
        if (result.type === "stream") {
          if (isResponsesApi) {
            emitResponsesStreamFromChatStream(res, result.upstreamRes, requestId, startedAt);
          } else {
            forwardChatCompletionStream(res, result.upstreamRes, requestId, startedAt);
          }
          return;
        }

        if (result.type === "error") {
          const status = result.upstreamRes.statusCode || 502;
          log("upstream-error-response", {
            requestId,
            status,
            bodyPreview: preview(result.text, 2000),
            durationMs: durationMs(startedAt),
          });
          res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(result.text);
          return;
        }

        try {
          const parsed = JSON.parse(result.text);
          log("response", {
            requestId,
            status: result.upstreamRes.statusCode,
            bytes: result.rawResponse.length,
            usage: parsed?.usage,
            choices: Array.isArray(parsed?.choices) ? parsed.choices.length : undefined,
            finishReason: parsed?.choices?.[0]?.finish_reason,
            durationMs: durationMs(startedAt),
          });
          if (!isResponsesApi) {
            const headers = {
              "Content-Type": result.upstreamRes.headers["content-type"] || "application/json; charset=utf-8",
              "Cache-Control": result.upstreamRes.headers["cache-control"] || "no-cache",
              Connection: "keep-alive",
            };

            res.writeHead(result.upstreamRes.statusCode || 200, headers);
            res.end(result.rawResponse);
            return;
          }

          writeJson(res, result.upstreamRes.statusCode || 200, chatCompletionsToResponses(parsed));
        } catch (error) {
          log("invalid-upstream-json", { requestId, error, bodyPreview: preview(result.text, 4000) });
          writeJson(res, 502, { error: "invalid upstream json" });
        }
      })
      .catch((error) => {
        log("upstream-error", { requestId, durationMs: durationMs(startedAt), error });
        if (!res.headersSent) {
          writeJson(res, 502, { error: String(error) });
          return;
        }
        res.end();
      });
  });
});

function startServer() {
  server.listen(PORT, "127.0.0.1", () => {
    fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
    log("listening", { host: "127.0.0.1", port: PORT });
  });

  server.on("error", (error) => {
    log("server-error", { error });
  });

  process.on("SIGINT", () => cleanupAndExit("SIGINT"));
  process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));
  process.on("exit", () => {
    try {
      if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(PID_PATH);
      }
    } catch (error) {
      log("pid-exit-cleanup-error", { error });
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  CLIENT_MODELS,
  chatCompletionsToResponses,
  emitResponsesStreamFromChatStream,
  normalizeMaxTokens,
  normalizeModel,
  resolveModel,
  responsesToChatCompletions,
  sanitizeBody,
  startServer,
};
