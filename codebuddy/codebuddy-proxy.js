const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { getApiKey, envNumber } = require("../shared/env");
const { createLogger, durationMs, makeRequestId, summarizeBody } = require("../shared/logger");

const PORT = envNumber("CODEBUDDY_PROXY_PORT", envNumber("PORT", 8787));
const TARGET_HOST = "apiai.sztu.edu.cn";
const TARGET_PATH = "/v1/chat/completions";
const LOG_DIR = path.join(__dirname, ".runtime");
const LOG_PATH = path.join(LOG_DIR, "codebuddy-proxy.log");
const PID_PATH = path.join(LOG_DIR, "codebuddy-proxy.pid");
const SZTU_DEFAULT_MAX_TOKENS = 8192;
const SZTU_MAX_TOKENS = 32768;
const DSV4_API_MODEL = "deepseek-v4-pro";
const DSV4_MAX_TIER_FLOOR = 4000;
const CLIENT_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-pro-instruct",
  "deepseek-v4-pro-max",
];

const CODEBUDDY_ENVELOPE_STUB = String(process.env.CODEBUDDY_ENVELOPE_STUB || "0").trim() === "1";

fs.mkdirSync(LOG_DIR, { recursive: true });

const log = createLogger("codebuddy", LOG_PATH);

function preview(value, maxLen = 1000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}…`;
}

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

  next.max_tokens = normalizeMaxTokens(next.max_tokens, resolved.tier);

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

function forwardChatCompletionStream(res, upstreamRes, requestId, startedAt) {
  res.writeHead(upstreamRes.statusCode || 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": upstreamRes.headers["cache-control"] || "no-cache",
    Connection: "keep-alive",
  });
  let bytes = 0;
  let body = "";
  upstreamRes.on("data", (chunk) => {
    bytes += chunk.length;
    body += chunk.toString("utf8");
  });
  upstreamRes.on("end", () => {
    log("stream-response", {
      requestId,
      status: upstreamRes.statusCode,
      bytes,
      body,
      durationMs: durationMs(startedAt),
    });
  });
  upstreamRes.pipe(res);
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
          body: result.text,
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

function extractBalancedJson(text, startIdx) {
  if (startIdx < 0 || startIdx >= text.length) {
    return "";
  }
  const open = text[startIdx];
  if (open !== "{" && open !== "[") {
    return "";
  }
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }
  return "";
}

function findJsonStart(text) {
  const markers = ['{"model"', '{"messages"', '{"input"', '{"stream"'];
  let best = -1;
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
    }
  }
  if (best >= 0) {
    return best;
  }
  return text.indexOf("{");
}

function extractJsonPayload(raw) {
  const text = typeof raw === "string" ? raw : "";
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  if (!/^(POST|GET|PUT|PATCH|DELETE) /i.test(trimmed)) {
    return trimmed;
  }

  for (const sep of ["\r\n\r\n", "\n\n"]) {
    const idx = text.indexOf(sep);
    if (idx < 0) {
      continue;
    }
    const jsonPart = text.slice(idx + sep.length).trim();
    const start = findJsonStart(jsonPart);
    if (start >= 0) {
      const balanced = extractBalancedJson(jsonPart, start);
      if (balanced) {
        return balanced;
      }
    }
  }

  const start = findJsonStart(text);
  if (start >= 0) {
    const balanced = extractBalancedJson(text, start);
    if (balanced) {
      return balanced;
    }
  }

  return "";
}

function findEnvelopeBodyStart(raw) {
  for (const sep of ["\r\n\r\n", "\n\n"]) {
    const idx = raw.indexOf(sep);
    if (idx >= 0) {
      return idx + sep.length;
    }
  }
  return -1;
}

const CONVERSATION_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const CONVERSATION_STATE_MAX_ENTRIES = 500;
const conversationStateCache = new Map();

function parseConversationId(raw, headers = {}) {
  const headerId = headers["x-conversation-id"] || headers["X-Conversation-ID"];
  if (headerId && String(headerId).trim()) {
    return String(headerId).trim();
  }
  const text = typeof raw === "string" ? raw : "";
  const match = text.match(/X-Conversation-ID:\s*([^\s\r\n]+)/i);
  return match ? match[1].trim() : "";
}

function pruneConversationStateCache(now = Date.now()) {
  for (const [key, entry] of conversationStateCache) {
    if (now - entry.ts > CONVERSATION_STATE_TTL_MS) {
      conversationStateCache.delete(key);
    }
  }
  if (conversationStateCache.size <= CONVERSATION_STATE_MAX_ENTRIES) {
    return;
  }
  const overflow = conversationStateCache.size - CONVERSATION_STATE_MAX_ENTRIES;
  const keys = [...conversationStateCache.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .slice(0, overflow)
    .map(([key]) => key);
  for (const key of keys) {
    conversationStateCache.delete(key);
  }
}

function cacheConversationState(conversationId, body) {
  if (!conversationId || !body || typeof body !== "object") {
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null;
  const previous = getCachedConversationState(conversationId);
  if (!tools && messages.length === 0 && !previous) {
    return;
  }
  const now = Date.now();
  conversationStateCache.set(conversationId, {
    tools: tools || previous?.tools || null,
    model: body.model ?? previous?.model,
    stream: body.stream === true ? true : (body.stream === false ? false : previous?.stream),
    max_tokens: body.max_tokens ?? previous?.max_tokens,
    messageCount: messages.length || previous?.messageCount || 0,
    contentChars: messages.length ? estimateMessagesChars(messages) : (previous?.contentChars || 0),
    ts: now,
  });
  pruneConversationStateCache(now);
}

function getCachedConversationState(conversationId) {
  if (!conversationId) {
    return null;
  }
  const entry = conversationStateCache.get(conversationId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > CONVERSATION_STATE_TTL_MS) {
    conversationStateCache.delete(conversationId);
    return null;
  }
  return entry;
}

function cacheConversationTools(conversationId, tools) {
  cacheConversationState(conversationId, { tools, messages: [] });
}

function getCachedConversationTools(conversationId) {
  const state = getCachedConversationState(conversationId);
  return state?.tools || null;
}

function parseEnvelopeHeaders(raw) {
  const bodyStart = findEnvelopeBodyStart(raw);
  const headerPart = bodyStart >= 0 ? raw.slice(0, bodyStart) : raw;
  const match = headerPart.match(/Content-Length:\s*(\d+)/i);
  const declaredContentLength = match ? Number(match[1]) : 0;
  const actualBodyBytes = bodyStart >= 0 ? Buffer.byteLength(raw.slice(bodyStart), "utf8") : 0;
  const totalBytes = Buffer.byteLength(raw || "", "utf8");
  const incomplete = declaredContentLength > 0 && actualBodyBytes < declaredContentLength;
  return {
    declaredContentLength,
    actualBodyBytes,
    totalBytes,
    incomplete,
  };
}

function extractModelFromJsonPart(jsonPart) {
  const match = jsonPart.match(/"model"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function findLastCompleteMessageEnd(jsonPart, bracket) {
  if (bracket < 0 || bracket >= jsonPart.length || jsonPart[bracket] !== "[") {
    return -1;
  }

  let depth = 1;
  let inString = false;
  let escape = false;
  let lastMessageEnd = -1;

  for (let i = bracket + 1; i < jsonPart.length; i += 1) {
    const ch = jsonPart[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (ch === "}" && depth === 1) {
        lastMessageEnd = i;
      }
    }
  }

  return lastMessageEnd;
}

function extractToolsFromJsonPart(jsonPart) {
  const messagesKey = jsonPart.indexOf('"messages":');
  if (messagesKey < 0) {
    return null;
  }
  const bracket = jsonPart.indexOf("[", messagesKey);
  if (bracket < 0) {
    return null;
  }

  const toolsMarkers = ['],"tools":', '],\n"tools":', '],\r\n"tools":'];
  let toolsKey = -1;
  for (const marker of toolsMarkers) {
    const idx = jsonPart.indexOf(marker, bracket);
    if (idx >= 0 && (toolsKey < 0 || idx < toolsKey)) {
      toolsKey = idx + marker.indexOf('"tools":');
    }
  }
  if (toolsKey < 0) {
    toolsKey = jsonPart.indexOf('"tools":', bracket);
  }
  if (toolsKey < 0) {
    return null;
  }

  const arrayStart = jsonPart.indexOf("[", toolsKey);
  if (arrayStart < 0) {
    return null;
  }
  const balanced = extractBalancedJson(jsonPart, arrayStart);
  if (!balanced) {
    return null;
  }
  try {
    const tools = JSON.parse(balanced);
    return Array.isArray(tools) && tools.length > 0 ? tools : null;
  } catch (error) {
    return null;
  }
}

function resolveSalvagedTools(jsonPart, conversationId) {
  const fromBody = extractToolsFromJsonPart(jsonPart);
  if (fromBody) {
    return { tools: fromBody, toolsSource: "body", stateFromCache: false };
  }
  const fromCache = getCachedConversationTools(conversationId);
  if (fromCache) {
    return { tools: fromCache, toolsSource: "cache", stateFromCache: true };
  }
  return { tools: null, toolsSource: "none", stateFromCache: false };
}

function estimateMessagesChars(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  return messages.reduce((sum, message) => {
    if (typeof message?.content === "string") {
      return sum + message.content.length;
    }
    if (Array.isArray(message?.content)) {
      return sum + JSON.stringify(message.content).length;
    }
    return sum + JSON.stringify(message || "").length;
  }, 0);
}

function trimSalvagedMessages(body, { keepRecent = 6, maxContentChars = 80000 } = {}) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return body;
  }

  const messages = body.messages;
  const systemMessages = messages.filter((message) => message?.role === "system");
  const firstUserIdx = messages.findIndex((message) => message?.role === "user");
  const firstUser = firstUserIdx >= 0 ? messages[firstUserIdx] : null;
  const pinned = new Set(systemMessages);
  if (firstUser) {
    pinned.add(firstUser);
  }

  const nonPinned = messages.filter((message, index) => !pinned.has(message) && index !== firstUserIdx);
  const recent = nonPinned.slice(-keepRecent);
  const trimmed = [...systemMessages];
  if (firstUser) {
    trimmed.push(firstUser);
  }
  for (const message of recent) {
    if (message !== firstUser) {
      trimmed.push(message);
    }
  }

  while (estimateMessagesChars(trimmed) > maxContentChars && trimmed.length > 2) {
    const removeIdx = trimmed.findIndex(
      (message, index) => index > 0 && message !== firstUser && message?.role !== "system"
    );
    if (removeIdx < 0) {
      break;
    }
    trimmed.splice(removeIdx, 1);
  }

  return {
    ...body,
    messages: trimmed,
  };
}

function salvageTruncatedEnvelope(raw, conversationId) {
  const bodyStart = findEnvelopeBodyStart(raw);
  if (bodyStart < 0) {
    return null;
  }
  const jsonPart = raw.slice(bodyStart);
  const arrayKey = jsonPart.indexOf('"messages":');
  if (arrayKey < 0) {
    return null;
  }
  const bracket = jsonPart.indexOf("[", arrayKey);
  if (bracket < 0) {
    return null;
  }

  const lastMessageEnd = findLastCompleteMessageEnd(jsonPart, bracket);
  if (lastMessageEnd <= bracket) {
    return null;
  }

  // Truncation usually cuts before top-level "stream":true (after messages/tools).
  // CodeBuddy chat completions expect SSE; default true unless body explicitly says false.
  const stream = /"stream"\s*:\s*false/.test(jsonPart)
    ? false
    : true;
  const cachedState = getCachedConversationState(conversationId);
  const salvagedMaxTokens = cachedState?.max_tokens || 8192;
  const { tools, toolsSource, stateFromCache } = resolveSalvagedTools(jsonPart, conversationId);
  let suffix = `],"stream":${stream},"max_tokens":${salvagedMaxTokens},"temperature":1`;
  if (stream) {
    suffix += ',"stream_options":{"include_usage":true}';
  }
  if (tools) {
    suffix += `,"tools":${JSON.stringify(tools)}`;
  }
  suffix += "}";

  const candidate = `${jsonPart.slice(0, lastMessageEnd + 1)}${suffix}`;
  try {
    const body = JSON.parse(candidate);
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return null;
    }
    const trimmed = trimSalvagedMessages(body);
    if (tools) {
      cacheConversationTools(conversationId, tools);
    }
    cacheConversationState(conversationId, trimmed);
    return {
      body: trimmed,
      meta: {
        toolsSource,
        stateFromCache,
        salvagedModel: extractModelFromJsonPart(jsonPart) || cachedState?.model || null,
        toolsCount: Array.isArray(trimmed.tools) ? trimmed.tools.length : 0,
        messagesBefore: body.messages.length,
        messagesAfter: trimmed.messages.length,
        contentChars: estimateMessagesChars(trimmed.messages),
      },
    };
  } catch (error) {
    return null;
  }
}

function logSalvagedEnvelope(requestId, raw, salvagedResult, reason) {
  const { body, meta } = salvagedResult;
  log("client-body-envelope-salvaged", {
    requestId,
    rawBytes: Buffer.byteLength(raw || "", "utf8"),
    messages: body.messages?.length ?? 0,
    reason,
    ...meta,
  });
}

function parseClientBody(raw, requestId, headers = {}) {
  const conversationId = parseConversationId(raw, headers);
  const envelopeMetrics = parseEnvelopeHeaders(raw);

  const applySalvage = (reason) => {
    const salvagedResult = salvageTruncatedEnvelope(raw, conversationId);
    if (!salvagedResult) {
      return null;
    }
    logSalvagedEnvelope(requestId, raw, salvagedResult, reason);
    return salvagedResult.body;
  };

  let jsonText = extractJsonPayload(raw);
  if (!jsonText) {
    const salvageReason = envelopeMetrics.incomplete ? "incomplete_content_length" : "missing_json";
    const salvaged = applySalvage(salvageReason);
    if (salvaged) {
      return salvaged;
    }
    const error = new Error("http_envelope_without_json_body");
    error.envelopeReason = salvageReason;
    error.envelopeMetrics = envelopeMetrics;
    log("invalid-json", {
      requestId,
      error,
      bodyPreview: preview(raw, 1000),
      bodyBytes: envelopeMetrics.totalBytes,
      declaredContentLength: envelopeMetrics.declaredContentLength,
      actualBodyBytes: envelopeMetrics.actualBodyBytes,
      conversationId,
    });
    throw error;
  }

  if (jsonText !== raw.trim()) {
    log("client-body-envelope-recovered", {
      requestId,
      rawBytes: envelopeMetrics.totalBytes,
      jsonBytes: Buffer.byteLength(jsonText, "utf8"),
      declaredContentLength: envelopeMetrics.declaredContentLength,
      actualBodyBytes: envelopeMetrics.actualBodyBytes,
    });
  }

  if (envelopeMetrics.incomplete) {
    const salvaged = applySalvage("incomplete_content_length");
    if (salvaged) {
      return salvaged;
    }
  }

  try {
    const body = JSON.parse(jsonText);
    cacheConversationState(conversationId, body);
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const salvaged = applySalvage(envelopeMetrics.incomplete ? "incomplete_content_length" : "syntax_error");
      if (salvaged) {
        return salvaged;
      }
    }
    throw error;
  }
}

function isCodebuddyHttpEnvelope(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  return /^POST\s+\S+/i.test(text) && /x-codebuddy-request:\s*1/i.test(text);
}

function sendEnvelopeRetryResponse(res, requestId, startedAt, meta = {}) {
  const payload = {
    error: {
      type: "incomplete_envelope",
      message: "CodeBuddy HTTP envelope missing or truncated JSON body",
      retryable: true,
      reason: meta.reason || "missing_json_body",
    },
  };
  const data = JSON.stringify(payload);
  res.writeHead(503, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Retry-After": "1",
  });
  res.end(data);
  log("envelope-retry-response", {
    requestId,
    ...meta,
    durationMs: durationMs(startedAt),
  });
}

function sendCodebuddyEnvelopeStub(res, requestId, startedAt) {
  const completionId = `cb_stub_${requestId}`;
  const created = Math.floor(Date.now() / 1000);
  const streamChunks = [
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    },
  ];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let bytes = 0;
  for (const chunk of streamChunks) {
    const line = `data: ${JSON.stringify(chunk)}\n\n`;
    bytes += Buffer.byteLength(line);
    res.write(line);
  }
  const done = "data: [DONE]\n\n";
  bytes += Buffer.byteLength(done);
  res.end(done);
  log("envelope-stub-response", {
    requestId,
    bytes,
    durationMs: durationMs(startedAt),
  });
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
  if (req.method !== "POST" || pathName !== "/v1/chat/completions") {
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
      body = parseClientBody(raw, requestId, req.headers);
    } catch (error) {
      const envelope = isCodebuddyHttpEnvelope(raw);
      const envelopeMetrics = error?.envelopeMetrics || parseEnvelopeHeaders(raw);
      const conversationId = parseConversationId(raw, req.headers);
      if (
        envelope
        && (error instanceof SyntaxError || error?.message === "http_envelope_without_json_body")
      ) {
        if (CODEBUDDY_ENVELOPE_STUB) {
          sendCodebuddyEnvelopeStub(res, requestId, startedAt);
        } else {
          sendEnvelopeRetryResponse(res, requestId, startedAt, {
            conversationId,
            reason: error?.envelopeReason || "missing_json_body",
            bodyBytes: envelopeMetrics.totalBytes,
            declaredContentLength: envelopeMetrics.declaredContentLength,
            actualBodyBytes: envelopeMetrics.actualBodyBytes,
          });
        }
        return;
      }
      if (error instanceof SyntaxError) {
        log("invalid-json", { requestId, error, bodyPreview: preview(raw, 1000) });
        writeJson(res, 400, { error: "invalid json" });
        return;
      }
      if (error && error.message === "http_envelope_without_json_body") {
        writeJson(res, 400, { error: "malformed http envelope" });
        return;
      }
      log("invalid-json", { requestId, error, bodyPreview: preview(raw, 1000) });
      writeJson(res, 400, { error: "invalid json" });
      return;
    }

    let nextBody;
    try {
      nextBody = sanitizeBody(body);
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
      client: summarizeBody(body),
      sanitized: summarizeBody(nextBody),
      upstream: summarizeBody(upstreamBody),
      upstreamBytes: Buffer.byteLength(payload),
    });

    requestUpstreamWithRetry(payload, apiKey, wantsStream, requestId, startedAt)
      .then((result) => {
        if (result.type === "stream") {
          forwardChatCompletionStream(res, result.upstreamRes, requestId, startedAt);
          return;
        }

        if (result.type === "error") {
          const status = result.upstreamRes.statusCode || 502;
          log("upstream-error-response", {
            requestId,
            status,
            body: result.text,
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
            body: parsed,
            durationMs: durationMs(startedAt),
          });
          const headers = {
            "Content-Type": result.upstreamRes.headers["content-type"] || "application/json; charset=utf-8",
            "Cache-Control": result.upstreamRes.headers["cache-control"] || "no-cache",
            Connection: "keep-alive",
          };

          res.writeHead(result.upstreamRes.statusCode || 200, headers);
          res.end(result.rawResponse);
        } catch (error) {
          log("invalid-upstream-json", { requestId, error, body: result.text });
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
  parseClientBody,
  parseEnvelopeHeaders,
  salvageTruncatedEnvelope,
  isCodebuddyHttpEnvelope,
  sendEnvelopeRetryResponse,
  normalizeMaxTokens,
  normalizeModel,
  resolveModel,
  sanitizeBody,
  startServer,
};
