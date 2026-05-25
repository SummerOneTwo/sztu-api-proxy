const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getApiKey, envNumber, loadDotEnv } = require("../shared/env");
const { createLogger, durationMs, makeRequestId, preview, summarizeAnthropicBody, summarizeBody } = require("../shared/logger");
const { parseToolCallsDetailed } = require("./tool-parser");

loadDotEnv();

const HOST = "127.0.0.1";
const PORT = envNumber("CLAUDE_SZTU_PROXY_PORT", 8790);
const UPSTREAM_URL = process.env.SZTU_UPSTREAM_URL || "https://apiai.sztu.edu.cn/v1/chat/completions";
const CLAUDE_DIR = __dirname;
const RUNTIME_DIR = path.join(CLAUDE_DIR, ".runtime");
const LOG_PATH = path.join(RUNTIME_DIR, "claudecode-proxy.log");
const PID_PATH = path.join(RUNTIME_DIR, PORT === 8790 ? "claudecode-proxy.pid" : `claudecode-proxy-${PORT}.pid`);
const DEFAULT_MODEL = process.env.SZTU_DEFAULT_MODEL || "glm-5.1";
const FALLBACK_MODEL = process.env.CLAUDE_SZTU_FALLBACK_MODEL || "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = envNumber("SZTU_DEFAULT_MAX_TOKENS", 32768);
const MAX_TOKENS = envNumber("SZTU_MAX_TOKENS", 32768);
const THINKING_MIN_MAX_TOKENS = envNumber("SZTU_THINKING_MIN_MAX_TOKENS", 10000);
const UPSTREAM_TIMEOUT_MS = Math.max(1000, envNumber("CLAUDE_SZTU_UPSTREAM_TIMEOUT_MS", 180000));
const STREAM_READ_TIMEOUT_MS = Math.max(1000, envNumber("CLAUDE_SZTU_STREAM_READ_TIMEOUT_MS", 180000));
const STREAM_TOTAL_TIMEOUT_MS = Math.max(STREAM_READ_TIMEOUT_MS, envNumber("CLAUDE_SZTU_STREAM_TOTAL_TIMEOUT_MS", 300000));
const STREAM_PARSE_CHARS = Math.max(4000, envNumber("CLAUDE_SZTU_STREAM_PARSE_CHARS", 60000));
const UPSTREAM_RETRY_ATTEMPTS = Math.max(1, Math.trunc(envNumber("CLAUDE_SZTU_UPSTREAM_RETRY_ATTEMPTS", 1)));
const FAILURE_STATUS = Math.max(400, Math.trunc(envNumber("CLAUDE_SZTU_FAILURE_STATUS", 424)));
const TOOL_MODES = new Set(["native", "prompt", "strict"]);
const TOOL_HISTORY_MODES = new Set(["text", "structured"]);

function resolveClaudeThinking(body) {
  const config = body?.thinking;
  if (config && typeof config === "object") {
    if (config.type === "enabled" || config.type === "adaptive") {
      return true;
    }
    if (config.type === "disabled") {
      return false;
    }
  }
  return true;
}

const resolveDeepseekThinking = resolveClaudeThinking;

function chatTemplateKwargs(model, thinking) {
  if (model === "deepseek-v4-pro") {
    return { thinking };
  }
  return { enable_thinking: thinking };
}

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

const log = createLogger("claudecode", LOG_PATH);

function readApiKey() {
  return getApiKey();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const resolveUpstreamThinking = resolveClaudeThinking;

function failureStatus() {
  return FAILURE_STATUS;
}

function resolveToolMode(explicit) {
  const raw =
    explicit ||
    process.env.CLAUDE_SZTU_TOOL_MODE ||
    (process.env.CLAUDE_SZTU_FORWARD_TOOLS === "0" ? "prompt" : "native");
  const mode = String(raw || "").trim().toLowerCase();
  return TOOL_MODES.has(mode) ? mode : "native";
}

function isNativeToolMode(mode) {
  return mode === "native" || mode === "strict";
}

function resolveToolHistoryMode(explicit) {
  const mode = String(explicit || process.env.CLAUDE_SZTU_TOOL_HISTORY_MODE || "text").trim().toLowerCase();
  return TOOL_HISTORY_MODES.has(mode) ? mode : "text";
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= UPSTREAM_RETRY_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.status < 500 || attempt === UPSTREAM_RETRY_ATTEMPTS) {
        return response;
      }
      const text = await response.text().catch(() => "");
      log("upstream-retryable-status", { attempt, status: response.status, bodyPreview: preview(text, 1000) });
    } catch (error) {
      lastError = error;
      if (attempt === UPSTREAM_RETRY_ATTEMPTS) {
        break;
      }
      log("upstream-retryable-error", { attempt, error });
    } finally {
      clearTimeout(timer);
    }
    await delay(500 * attempt);
  }
  throw lastError;
}

function readJson(req) {
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

function normalizeMaxTokens(value, thinking = false) {
  const n = Number(value);
  const configuredMax = Math.min(DEFAULT_MAX_TOKENS, MAX_TOKENS);
  if (!Number.isFinite(n) || n <= 0) {
    return configuredMax;
  }
  const requested = Math.min(Math.trunc(n), configuredMax);
  if (thinking) {
    return Math.min(Math.max(requested, THINKING_MIN_MAX_TOKENS), configuredMax);
  }
  return requested;
}

function upstreamModel(requestedModel, options = {}) {
  return options.model || DEFAULT_MODEL;
}

function fallbackModelFor(upstreamBody) {
  const fallback = String(FALLBACK_MODEL || "").trim();
  if (!fallback || fallback === upstreamBody?.model) {
    return "";
  }
  return fallback;
}

function isRetryableFallbackStatus(status) {
  return Number(status) >= 500;
}

function isReadOnlyToolName(name) {
  const lower = String(name || "").toLowerCase();
  return new Set([
    "read",
    "ls",
    "glob",
    "grep",
    "listmcpresourcestool",
    "readmcpresourcetool",
    "webfetch",
    "websearch",
  ]).has(lower) || lower.endsWith("__file_read");
}

function toolExecutionSafety(body) {
  const toolNamesById = new Map();
  let hasExecution = false;
  let unsafe = false;

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!message || typeof message !== "object") {
      continue;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        hasExecution = true;
        const name = toolCall?.function?.name || toolCall?.name;
        if (toolCall?.id && name) {
          toolNamesById.set(toolCall.id, name);
        }
        if (!isReadOnlyToolName(name)) {
          unsafe = true;
        }
      }
    }
    if (message.role === "tool") {
      hasExecution = true;
      const name = toolNamesById.get(message.tool_call_id);
      if (!isReadOnlyToolName(name)) {
        unsafe = true;
      }
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_use") {
          hasExecution = true;
          if (part.id && part.name) {
            toolNamesById.set(part.id, part.name);
          }
          if (!isReadOnlyToolName(part.name)) {
            unsafe = true;
          }
        } else if (part?.type === "tool_result") {
          hasExecution = true;
          const name = toolNamesById.get(part.tool_use_id);
          if (!isReadOnlyToolName(name)) {
            unsafe = true;
          }
        }
      }
    }
  }
  return { hasExecution, unsafe };
}

function hasToolExecutionHistory(body) {
  return toolExecutionSafety(body).hasExecution;
}

function hasUnsafeToolExecutionHistory(body) {
  return toolExecutionSafety(body).unsafe;
}

function shouldFallbackToModel(body, upstreamBody) {
  return Boolean(fallbackModelFor(upstreamBody)) && !hasUnsafeToolExecutionHistory(body);
}

function contentToText(content) {
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
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "tool_result") {
        const result = contentToText(part.content);
        return `Tool result for ${part.tool_use_id || "tool"}:\n${result}`;
      }
      if (part.type === "image" || part.type === "document") {
        return `[${part.type} omitted]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicMessagesToOpenAI(body, options = {}) {
  const toolMode = resolveToolMode(options.toolMode);
  const nativeTools = isNativeToolMode(toolMode);
  const structuredToolHistory = nativeTools && resolveToolHistoryMode(options.toolHistoryMode) === "structured";
  const toolNameMaps = options.toolNameMaps || createToolNameMaps();
  const messages = [];

  const systemParts = [];
  if (typeof body.system === "string" && body.system.trim()) {
    systemParts.push(body.system);
  } else if (Array.isArray(body.system)) {
    const systemText = contentToText(body.system);
    if (systemText) {
      systemParts.push(systemText);
    }
  }

  const toolPrompt = nativeTools ? "" : anthropicToolsToPrompt(body.tools, body.messages);
  if (toolPrompt) {
    systemParts.push(toolPrompt);
  }

  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const textParts = [];
      const toolCalls = [];
      for (const part of message.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        } else if (part?.type === "tool_use" && structuredToolHistory) {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: {
              name: upstreamToolName(part.name, toolNameMaps),
              arguments: JSON.stringify(part.input || {}),
            },
          });
        }
      }
      if (textParts.length === 0 && toolCalls.length === 0) {
        continue;
      }
      const next = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length > 0) {
        next.tool_calls = toolCalls;
      }
      messages.push(next);
      continue;
    }

    if (Array.isArray(message.content)) {
      const toolResults = message.content.filter((part) => part?.type === "tool_result");
      if (toolResults.length > 0) {
        if (structuredToolHistory) {
          for (const part of toolResults) {
            if (part.tool_use_id) {
              messages.push({
                role: "tool",
                tool_call_id: part.tool_use_id,
                content: contentToText(part.content),
              });
            } else {
              messages.push({
                role: "user",
                content: `Tool result:\n${contentToText(part.content)}`,
              });
            }
          }
          const rest = message.content.filter((part) => part?.type !== "tool_result");
          const restText = contentToText(rest);
          if (restText) {
            messages.push({ role: "user", content: restText });
          }
          continue;
        }
        for (const part of toolResults) {
          messages.push({
            role: "user",
            content: `Tool result:\n${contentToText(part.content)}\n\nThe tool call above has already completed. Do not repeat the same tool call just to read the same result again. Continue the user's task. If more inspection, edits, or commands are needed, request exactly one new tool call. Otherwise answer concisely.`,
          });
        }
        const rest = message.content.filter((part) => part?.type !== "tool_result");
        const restText = contentToText(rest);
        if (restText) {
          messages.push({ role: "user", content: restText });
        }
        continue;
      }
    }

    const text = contentToText(message.content);
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }

  return messages;
}

function anthropicToolsToPrompt(tools, messages) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return "";
  }
  const relevantTools = selectRelevantTools(tools, messages);
  if (relevantTools.length === 0) {
    return "";
  }

  const summarized = relevantTools
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => {
      const schema = tool.input_schema ? JSON.stringify(tool.input_schema) : "{}";
      return `- ${tool.name}: ${tool.description || ""}\n  input_schema: ${schema}`;
    })
    .join("\n");

  return [
    "You may use one tool by responding with exactly one tool call and no other text.",
    'Preferred format: <tool_call>{"name":"ToolName","input":{...}}</tool_call>',
    'Alternative format: <tool-use name="ToolName"><parameter name="field">value</parameter></tool-use>',
    "For exploring a codebase, prefer Read or Glob before Bash.",
    "For creating a new file, use Write. Do not use Edit with an empty old_string.",
    "Only use parameter names from input_schema. Do not invent fields such as limit.",
    "After a tool result is provided, continue normally or request another tool call.",
    "Available tools:",
    summarized,
  ].join("\n");
}

function selectRelevantTools(tools, messages) {
  const text = userIntentText(messages).toLowerCase();
  if (!text) {
    return [];
  }

  const wanted = new Set();
  const add = (...names) => names.forEach((name) => wanted.add(name.toLowerCase()));
  const addMatching = (predicate) => {
    for (const tool of Array.isArray(tools) ? tools : []) {
      const name = String(tool?.name || "");
      if (name && predicate(name.toLowerCase())) {
        wanted.add(name.toLowerCase());
      }
    }
  };
  const explicitAutocodeNames = [...text.matchAll(/mcp__autocode__([a-z0-9_-]+)/g)].map((match) => match[1]);
  if (explicitAutocodeNames.length > 0) {
    const explicit = new Set(explicitAutocodeNames);
    for (const tool of Array.isArray(tools) ? tools : []) {
      const name = String(tool?.name || "");
      const lower = name.toLowerCase();
      const suffix = autocodeToolSuffix(lower);
      if (!suffix) {
        continue;
      }
      if (explicit.has(suffix)) {
        wanted.add(lower);
      }
    }
    return tools.filter((tool) => wanted.has(String(tool?.name || "").toLowerCase()));
  }

  if (/(read|open|cat|查看|读取|阅读|打开|文件|file|agents\.md|readme|package\.json)/i.test(text)) {
    add("Read", "LS");
  }
  if (/(grep|search|find|rg|搜索|查找|寻找|匹配)/i.test(text)) {
    add("Grep", "Glob", "Read");
  }
  if (/(edit|write|create|build|scaffold|modify|patch|change|fix|implement|update|add|website|blog|html|css|javascript|修改|编辑|写入|创建|生成|新增|制作|修复|实现|更新|改成|补丁)/i.test(text)) {
    add("Read", "Edit", "MultiEdit", "Write", "Grep", "Glob");
  }
  if (/(bash|shell|run|execute|command|test|npm|uv|python|node|server|preview|deploy|serve|执行|运行|命令|测试|部署|预览|服务)/i.test(text)) {
    add("Bash", "Read");
  }
  if (/(总结|概览|项目|结构|目录|overview|summarize|structure|repo|codebase)/i.test(text)) {
    add("Read", "Glob", "Grep");
  }
  if (/(autocode|mcp__autocode__|竞赛|出题|题目|polygon|validator|generator|checker|interactor|stress|对拍)/i.test(text)) {
    let matchedAutocodeTool = false;
    for (const tool of Array.isArray(tools) ? tools : []) {
      const name = String(tool?.name || "");
      const lower = name.toLowerCase();
      const suffix = autocodeToolSuffix(lower);
      if (!suffix) {
        continue;
      }
      if (text.includes(lower) || text.includes(suffix)) {
        wanted.add(lower);
        matchedAutocodeTool = true;
      }
    }
    if (!matchedAutocodeTool) {
      addMatching((name) => Boolean(autocodeToolSuffix(name)));
    }
    add("Skill");
  }
  addMatching((name) => text.includes(name));

  if (wanted.size === 0) {
    return [];
  }
  return tools.filter((tool) => wanted.has(String(tool?.name || "").toLowerCase()));
}

function countAnthropicInputTokens(body) {
  const parts = [];
  if (typeof body?.system === "string") {
    parts.push(body.system);
  } else if (Array.isArray(body?.system)) {
    parts.push(contentToText(body.system));
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    parts.push(String(message?.role || ""));
    parts.push(contentToText(message?.content));
  }
  if (Array.isArray(body?.tools)) {
    parts.push(JSON.stringify(body.tools));
  }
  return estimateTokens(parts.filter(Boolean).join("\n"));
}

function estimateTokens(text) {
  const source = String(text || "");
  let ascii = 0;
  let nonAscii = 0;
  for (const char of source) {
    if (char.charCodeAt(0) <= 0x7f) {
      ascii++;
    } else {
      nonAscii++;
    }
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 2));
}

function autocodeToolSuffix(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("mcp__autocode__")) {
    return lower.slice("mcp__autocode__".length);
  }
  if (lower.startsWith("mcp__plugin_autocode_autocode__")) {
    return lower.slice("mcp__plugin_autocode_autocode__".length);
  }
  return "";
}

function userIntentText(messages) {
  const userTexts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "user") {
      continue;
    }
    if (Array.isArray(message.content) && message.content.some((part) => part?.type === "tool_result")) {
      continue;
    }
    const text = contentToText(message.content);
    if (text) {
      userTexts.push(text);
    }
  }
  return userTexts.join("\n");
}

function createToolNameMaps() {
  return {
    toOriginal: new Map(),
    toUpstream: new Map(),
  };
}

function upstreamToolName(originalName, toolNameMaps = createToolNameMaps()) {
  const original = String(originalName || "tool");
  if (toolNameMaps.toUpstream.has(original)) {
    return toolNameMaps.toUpstream.get(original);
  }

  let upstream = isValidOpenAiToolName(original) ? original : shortToolName(original, toolNameMaps.toOriginal.size);
  while (toolNameMaps.toOriginal.has(upstream) && toolNameMaps.toOriginal.get(upstream) !== original) {
    upstream = shortToolName(`${original}:${toolNameMaps.toOriginal.size}`, toolNameMaps.toOriginal.size);
  }

  toolNameMaps.toUpstream.set(original, upstream);
  toolNameMaps.toOriginal.set(upstream, original);
  return upstream;
}

function originalToolName(upstreamName, toolNameMaps) {
  return toolNameMaps?.toOriginal?.get(upstreamName) || upstreamName;
}

function isValidOpenAiToolName(name) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(name || ""));
}

function shortToolName(name, index) {
  const digest = crypto.createHash("sha1").update(String(name || "")).digest("hex").slice(0, 12);
  return `tool_${index}_${digest}`;
}

function anthropicToolsToOpenAI(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  const toolNameMaps = options.toolNameMaps || createToolNameMaps();
  const strict = options.strict === true;
  return tools
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: upstreamToolName(tool.name, toolNameMaps),
        description: tool.description || "",
        parameters: strict ? sanitizeJsonSchema(tool.input_schema || { type: "object", properties: {} }) : tool.input_schema || { type: "object", properties: {} },
        ...(strict ? { strict: true } : {}),
      },
    }));
}

function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const allowed = new Set(["type", "properties", "required", "description", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!allowed.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out.properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        out.properties[propName] = sanitizeJsonSchema(propSchema);
      }
    } else if (key === "items") {
      out.items = sanitizeJsonSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === "object" || out.properties) {
    out.type = out.type || "object";
    out.properties = out.properties || {};
    out.additionalProperties = false;
  }
  return out;
}

function openAiToolChoice(toolChoice, toolNameMaps) {
  if (!toolChoice) {
    return "auto";
  }
  if (typeof toolChoice === "string") {
    return toolChoice === "any" ? "required" : toolChoice;
  }
  if (typeof toolChoice !== "object") {
    return "auto";
  }
  if (toolChoice.type === "auto") {
    return "auto";
  }
  if (toolChoice.type === "none") {
    return "none";
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return {
      type: "function",
      function: { name: upstreamToolName(toolChoice.name, toolNameMaps) },
    };
  }
  return "auto";
}

function buildUpstreamRequest(body, options = {}) {
  const model = upstreamModel(body.model, { model: options.upstreamModel || options.model });
  const thinking = resolveUpstreamThinking(body);
  const maxTokens = normalizeMaxTokens(body.max_tokens, thinking);
  const toolMode = resolveToolMode(options.toolMode);
  const toolHistoryMode = resolveToolHistoryMode(options.toolHistoryMode);
  const toolNameMaps = options.toolNameMaps || createToolNameMaps();
  const upstream = {
    model,
    messages: anthropicMessagesToOpenAI(body, { toolMode, toolHistoryMode, toolNameMaps }),
    stream: body.stream === true,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    max_tokens: maxTokens,
  };

  const tools = isNativeToolMode(toolMode)
    ? anthropicToolsToOpenAI(body.tools, { toolNameMaps, strict: toolMode === "strict" })
    : undefined;
  if (tools) {
    upstream.tools = tools;
    upstream.tool_choice = openAiToolChoice(body.tool_choice, toolNameMaps);
  }

  upstream.chat_template_kwargs = chatTemplateKwargs(model, thinking);

  if (upstream.stream) {
    upstream.stream_options = { include_usage: true };
  }

  Object.keys(upstream).forEach((key) => upstream[key] === undefined && delete upstream[key]);
  return { upstreamBody: upstream, toolMode, toolHistoryMode, toolNameMaps, forwardedToolCount: tools?.length || 0 };
}

function buildUpstreamBody(body, options = {}) {
  return buildUpstreamRequest(body, options).upstreamBody;
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function stopReason(reason) {
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "tool_calls") {
    return "tool_use";
  }
  return "end_turn";
}

function openAiToolCallsToAnthropic(toolCalls, toolNameMaps) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map((toolCall) => {
      const upstreamName = toolCall?.function?.name || toolCall?.name;
      if (!upstreamName) {
        return null;
      }
      return {
        type: "tool_use",
        id: toolCall.id || `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: originalToolName(upstreamName, toolNameMaps),
        input: safeToolInput(toolCall.function?.arguments ?? toolCall.arguments),
      };
    })
    .filter(Boolean);
}

function toAnthropicMessage(payload, requestedModel, tools, requestId, options = {}) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const nativeTools = openAiToolCallsToAnthropic(message.tool_calls, options.toolNameMaps);
  const parsedTools = nativeTools.length > 0 ? [] : parseToolsWithLog(message.content, tools, requestId, false);

  if (nativeTools.length > 0) {
    if (typeof message.content === "string" && message.content) {
      content.push({ type: "text", text: message.content });
    }
    content.push(...nativeTools);
  } else if (parsedTools.length > 0) {
    content.push(...parsedTools);
  } else if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }

  return {
    id: payload?.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel || payload?.model || DEFAULT_MODEL,
    content,
    stop_reason: parsedTools.length > 0 || nativeTools.length > 0 ? "tool_use" : stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usage?.prompt_tokens || 0,
      output_tokens: payload?.usage?.completion_tokens || 0,
    },
  };
}

function parseToolWithLog(text, tools, requestId, stream) {
  return parseToolsWithLog(text, tools, requestId, stream)[0] || null;
}

function parseToolsWithLog(text, tools, requestId, stream) {
  const parseSource = boundedToolParseText(text);
  const result = parseToolCallsDetailed(parseSource.text, tools);
  if (result.tools.length === 1) {
    const tool = result.tools[0];
    log("tool-parse-hit", {
      requestId,
      stream,
      tool: tool.name,
      inputKeys: Object.keys(tool.input || {}),
      rawInputKeys: result.rawInputKeys,
      strippedKeys: result.strippedKeys,
      inputPreview: preview(JSON.stringify(tool.input || {}), 500),
      matchedFormat: result.matchedFormat,
      candidates: result.candidates,
      rejected: result.rejected,
      textChars: typeof text === "string" ? text.length : 0,
      parseChars: parseSource.text.length,
      parseTruncated: parseSource.truncated,
      modelTextPreview: preview(parseSource.text, 1000),
    });
    return result.tools;
  }
  if (result.tools.length > 1) {
    log("tool-parse-hit", {
      requestId,
      stream,
      tool: result.tools[0].name,
      tools: result.tools.map((tool) => tool.name),
      toolCount: result.tools.length,
      inputKeys: result.tools.map((tool) => Object.keys(tool.input || {})),
      matchedFormat: result.matchedFormat,
      candidates: result.candidates,
      rejected: result.rejected,
      textChars: typeof text === "string" ? text.length : 0,
      parseChars: parseSource.text.length,
      parseTruncated: parseSource.truncated,
      modelTextPreview: preview(parseSource.text, 1000),
    });
    return result.tools;
  }
  if (result.candidates > 0 || looksLikeToolText(text)) {
    log("tool-parse-miss", {
      requestId,
      stream,
      reason: result.reason,
      candidates: result.candidates,
      rejected: result.rejected,
      textChars: typeof text === "string" ? text.length : 0,
      parseChars: parseSource.text.length,
      parseTruncated: parseSource.truncated,
      modelTextPreview: preview(parseSource.text, 1000),
    });
  }
  return [];
}

function boundedToolParseText(text) {
  const source = typeof text === "string" ? text : "";
  if (source.length <= STREAM_PARSE_CHARS) {
    return { text: source, truncated: false };
  }

  const structuralMarkers = [
    "<tool_call",
    "<tool-call",
    "<tool-use",
    "<tool_use",
    "<invoke",
    "<|tool",
    "Tool:",
    "Arguments:",
    "mcp__autocode__",
  ];
  const fallbackMarkers = [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
  ];
  let markerIndex = -1;
  for (const marker of structuralMarkers) {
    markerIndex = Math.max(markerIndex, source.lastIndexOf(marker));
  }
  if (markerIndex < 0) {
    for (const marker of fallbackMarkers) {
      markerIndex = Math.max(markerIndex, source.lastIndexOf(marker));
    }
  }
  const tailStart = Math.max(0, source.length - STREAM_PARSE_CHARS);
  const start = markerIndex >= tailStart ? markerIndex : tailStart;
  return { text: source.slice(start, start + STREAM_PARSE_CHARS), truncated: true };
}

function looksLikeToolText(text) {
  return typeof text === "string" && /<tool|tool_call|tool-use|tool-calls|<tool_use\b|Tool:\s|Arguments:|<\/think>|<\|tool/i.test(text);
}

function safeJson(text) {
  if (typeof text !== "string" || !text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function safeToolInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return safeJson(value);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readStreamChunk(reader) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timeout: true }), STREAM_READ_TIMEOUT_MS);
    reader.read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function streamAnthropicFromUpstream(res, upstreamRes, requestedModel, tools, requestId, startedAt, options = {}) {
  const id = `msg_${Date.now()}`;
  const createdMessage = {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requestedModel || DEFAULT_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };

  let responseStarted = false;
  function startResponse(status = upstreamRes.status) {
    if (responseStarted) {
      return;
    }
    responseStarted = true;
    res.writeHead(status, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeSse(res, "message_start", createdMessage);
  }

  let buffer = "";
  let text = "";
  let stop = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const nativeToolCalls = new Map();
  let streamTimedOut = false;

  function handleData(dataText) {
    if (dataText === "[DONE]") {
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(dataText);
    } catch (error) {
      log("bad-upstream-sse", { requestId, dataPreview: preview(dataText, 1000), error });
      return;
    }

    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens || usage.input_tokens || 0,
        output_tokens: chunk.usage.completion_tokens || usage.output_tokens || 0,
      };
      return;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      return;
    }
    if (choice.finish_reason) {
      stop = stopReason(choice.finish_reason);
    }
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      startResponse();
      text += delta.content;
    }
    for (const toolCall of delta.tool_calls || []) {
      startResponse();
      const key = Number.isInteger(toolCall.index) ? toolCall.index : nativeToolCalls.size;
      const current = nativeToolCalls.get(key) || {
        id: toolCall.id || `toolu_${Date.now().toString(36)}_${key}`,
        name: "",
        arguments: "",
      };
      if (toolCall.id) {
        current.id = toolCall.id;
      }
      if (toolCall.function?.name) {
        current.name = toolCall.function.name;
      }
      if (typeof toolCall.function?.arguments === "string") {
        current.arguments += toolCall.function.arguments;
      }
      nativeToolCalls.set(key, current);
      stop = "tool_use";
    }
  }

  (async () => {
    const reader = upstreamRes.body.getReader();
    const streamStartedAt = Date.now();
    while (true) {
      if (Date.now() - streamStartedAt > STREAM_TOTAL_TIMEOUT_MS) {
        streamTimedOut = true;
        log("stream-total-timeout", {
          requestId,
          timeoutMs: STREAM_TOTAL_TIMEOUT_MS,
          textPreview: preview(text, 1000),
          bufferPreview: preview(buffer, 1000),
        });
        await reader.cancel().catch(() => {});
        break;
      }
      const { done, value, timeout } = await readStreamChunk(reader);
      if (timeout) {
        streamTimedOut = true;
        log("stream-read-timeout", {
          requestId,
          timeoutMs: STREAM_READ_TIMEOUT_MS,
          textPreview: preview(text, 1000),
          bufferPreview: preview(buffer, 1000),
        });
        await reader.cancel().catch(() => {});
        break;
      }
      if (done) {
        break;
      }
      buffer += Buffer.from(value).toString("utf8");
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        const dataLines = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        for (const dataLine of dataLines) {
          handleData(dataLine);
        }
      }
    }

    if (buffer.trim() && !streamTimedOut) {
      const dataLines = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      for (const dataLine of dataLines) {
        handleData(dataLine);
      }
    } else if (buffer.trim() && streamTimedOut) {
      log("stream-leftover-discarded", {
        requestId,
        reason: "timeout",
        bufferPreview: preview(buffer, 1000),
      });
    }
    const nativeTools = openAiToolCallsToAnthropic(
      [...nativeToolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, toolCall]) => ({
        id: toolCall.id,
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }))
      .filter((toolCall) => toolCall.function.name),
      options.toolNameMaps,
    );
    const parsedTools = nativeTools.length > 0 ? nativeTools : parseToolsWithLog(text, tools, requestId, true);
    const emptyStream = nativeTools.length === 0 && parsedTools.length === 0 && !text;
    if (emptyStream && typeof options.onEmptyStream === "function") {
      log("stream-empty-fallback", {
        requestId,
        model: options.model,
        durationMs: durationMs(startedAt),
      });
      const fallback = await options.onEmptyStream();
      if (fallback?.handled) {
        return;
      }
      if (fallback?.upstreamRes) {
        streamAnthropicFromUpstream(res, fallback.upstreamRes, requestedModel, tools, requestId, startedAt, {
          ...options,
          toolNameMaps: fallback.toolNameMaps || options.toolNameMaps,
          toolMode: fallback.toolMode || options.toolMode,
          model: fallback.model || options.model,
          fallbackUsed: true,
          onEmptyStream: undefined,
        });
        return;
      }
    }
    startResponse();
    if (parsedTools.length > 0) {
      parsedTools.forEach((parsedTool, index) => {
        const inputJson = JSON.stringify(parsedTool.input || {});
        writeSse(res, "content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: parsedTool.id,
            name: parsedTool.name,
            input: {},
          },
        });
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: inputJson,
          },
        });
        writeSse(res, "content_block_stop", { type: "content_block_stop", index });
      });
      stop = "tool_use";
    } else if (text) {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
      writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    }
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    log("stream-response", {
      requestId,
      status: upstreamRes.status,
      stop_reason: stop,
      usage,
      model: options.model,
      fallbackUsed: options.fallbackUsed,
      nativeToolCalls: nativeTools.length,
      fallbackParserUsed: nativeTools.length === 0 && parsedTools.length > 0,
      textChars: text.length,
      durationMs: durationMs(startedAt),
    });
    res.end();
  })().catch((error) => {
    log("stream-error", { requestId, durationMs: durationMs(startedAt), error });
    if (res.destroyed || res.writableEnded) {
      return;
    }
    if (!responseStarted && !res.headersSent) {
      writeJson(res, failureStatus(), { error: { type: "api_error", message: error.message } });
      return;
    }
    if (!res.destroyed) {
      res.end();
    }
  });
}

function sendUpstreamRequest(apiKey, upstreamBody) {
  return fetchWithRetry(UPSTREAM_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: upstreamBody.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(upstreamBody),
  });
}

function fallbackRequestFor(body, upstreamRequest, fallbackModel) {
  return buildUpstreamRequest(body, {
    upstreamModel: fallbackModel,
    toolMode: upstreamRequest.toolMode,
    toolHistoryMode: upstreamRequest.toolHistoryMode,
    toolNameMaps: upstreamRequest.toolNameMaps,
  });
}

function proxyMessages(req, res, body) {
  const requestId = makeRequestId("cc");
  const startedAt = Date.now();
  const apiKey = readApiKey();
  if (!apiKey) {
    log("missing-api-key", { requestId });
    writeJson(res, 500, { error: { type: "api_error", message: "missing SZTU API key" } });
    return;
  }

  let upstreamRequest = buildUpstreamRequest(body);
  let { upstreamBody, toolMode, toolHistoryMode, toolNameMaps, forwardedToolCount } = upstreamRequest;
  const upstreamThinking = resolveUpstreamThinking(body);
  const fallbackModel = fallbackModelFor(upstreamBody);
  const fallbackEligible = shouldFallbackToModel(body, upstreamBody);
  log("request", {
    requestId,
    method: req.method,
    url: req.url,
    client: summarizeAnthropicBody(body),
    upstream: summarizeBody(upstreamBody),
    upstreamBytes: Buffer.byteLength(JSON.stringify(upstreamBody)),
    client_thinking: body?.thinking?.type,
    upstream_thinking: upstreamThinking,
    toolMode,
    toolHistoryMode,
    forwardedToolCount,
    fallbackModel: fallbackEligible ? fallbackModel : undefined,
  });

  (async () => {
    let usedFallback = false;
    let upstreamRes;
    try {
      upstreamRes = await sendUpstreamRequest(apiKey, upstreamBody);
    } catch (error) {
      if (!fallbackEligible) {
        throw error;
      }
      const fallbackRequest = fallbackRequestFor(body, upstreamRequest, fallbackModel);
      log("upstream-fallback", {
        requestId,
        reason: "network-error",
        fromModel: upstreamBody.model,
        toModel: fallbackModel,
        error: error.message,
        durationMs: durationMs(startedAt),
      });
      upstreamRequest = fallbackRequest;
      ({ upstreamBody, toolMode, toolHistoryMode, toolNameMaps, forwardedToolCount } = upstreamRequest);
      usedFallback = true;
      upstreamRes = await sendUpstreamRequest(apiKey, upstreamBody);
    }

    async function fallbackFromStatusIfNeeded(currentRes) {
      log("upstream-response-start", {
        requestId,
        status: currentRes.status,
        contentType: currentRes.headers.get("content-type"),
        model: upstreamBody.model,
        durationMs: durationMs(startedAt),
      });

      if (!currentRes.ok && fallbackEligible && !usedFallback && isRetryableFallbackStatus(currentRes.status)) {
        const text = await currentRes.text();
        log("upstream-error-response", {
          requestId,
          status: currentRes.status,
          model: upstreamBody.model,
          fallbackEligible: true,
          bodyPreview: preview(text, 2000),
          durationMs: durationMs(startedAt),
        });
        const fallbackRequest = fallbackRequestFor(body, upstreamRequest, fallbackModel);
        log("upstream-fallback", {
          requestId,
          reason: "status",
          status: currentRes.status,
          fromModel: upstreamBody.model,
          toModel: fallbackModel,
          durationMs: durationMs(startedAt),
        });
        upstreamRequest = fallbackRequest;
        ({ upstreamBody, toolMode, toolHistoryMode, toolNameMaps, forwardedToolCount } = upstreamRequest);
        usedFallback = true;
        const fallbackRes = await sendUpstreamRequest(apiKey, upstreamBody);
        log("upstream-response-start", {
          requestId,
          status: fallbackRes.status,
          contentType: fallbackRes.headers.get("content-type"),
          model: upstreamBody.model,
          fallback: true,
          durationMs: durationMs(startedAt),
        });
        return fallbackRes;
      }
      return currentRes;
    }

    upstreamRes = await fallbackFromStatusIfNeeded(upstreamRes);

      if (upstreamBody.stream) {
        if (!upstreamRes.ok) {
          const text = await upstreamRes.text();
          log("upstream-error-response", {
            requestId,
            status: upstreamRes.status,
            model: upstreamBody.model,
            fallbackUsed: usedFallback,
            bodyPreview: preview(text, 2000),
            durationMs: durationMs(startedAt),
          });
          writeJson(res, failureStatus(), {
            error: {
              type: "api_error",
              message: text.slice(0, 1000) || `upstream returned ${upstreamRes.status}`,
            },
          });
          return;
        }
        if (!upstreamRes.body) {
          writeJson(res, 502, { error: { type: "api_error", message: "missing upstream stream body" } });
          return;
        }
        const streamOptions = { toolNameMaps, toolMode, model: upstreamBody.model, fallbackUsed: usedFallback };
        if (fallbackEligible && !usedFallback) {
          streamOptions.onEmptyStream = async () => {
            const fallbackRequest = fallbackRequestFor(body, upstreamRequest, fallbackModel);
            log("upstream-fallback", {
              requestId,
              reason: "empty-stream",
              fromModel: upstreamBody.model,
              toModel: fallbackModel,
              durationMs: durationMs(startedAt),
            });
            upstreamRequest = fallbackRequest;
            ({ upstreamBody, toolMode, toolHistoryMode, toolNameMaps, forwardedToolCount } = upstreamRequest);
            usedFallback = true;
            const fallbackRes = await sendUpstreamRequest(apiKey, upstreamBody);
            log("upstream-response-start", {
              requestId,
              status: fallbackRes.status,
              contentType: fallbackRes.headers.get("content-type"),
              model: upstreamBody.model,
              fallback: true,
              durationMs: durationMs(startedAt),
            });
            if (!fallbackRes.ok) {
              const text = await fallbackRes.text();
              log("upstream-error-response", {
                requestId,
                status: fallbackRes.status,
                model: upstreamBody.model,
                fallbackUsed: true,
                bodyPreview: preview(text, 2000),
                durationMs: durationMs(startedAt),
              });
              writeJson(res, failureStatus(), {
                error: {
                  type: "api_error",
                  message: text.slice(0, 1000) || `upstream returned ${fallbackRes.status}`,
                },
              });
              return { handled: true };
            }
            if (!fallbackRes.body) {
              writeJson(res, 502, { error: { type: "api_error", message: "missing fallback stream body" } });
              return { handled: true };
            }
            return {
              upstreamRes: fallbackRes,
              toolNameMaps,
              toolMode,
              model: upstreamBody.model,
            };
          };
        }
        streamAnthropicFromUpstream(res, upstreamRes, body.model, body.tools, requestId, startedAt, streamOptions);
        return;
      }

      const text = await upstreamRes.text();
      if (!upstreamRes.ok) {
        log("upstream-error-response", {
          requestId,
          status: upstreamRes.status,
          model: upstreamBody.model,
          fallbackUsed: usedFallback,
          bodyPreview: preview(text, 2000),
          durationMs: durationMs(startedAt),
        });
        writeJson(res, failureStatus(), {
          error: {
            type: "api_error",
            message: text.slice(0, 1000) || `upstream returned ${upstreamRes.status}`,
          },
        });
        return;
      }
      const data = JSON.parse(text);
      const anthropic = toAnthropicMessage(data, body.model, body.tools, requestId, { toolNameMaps, toolMode });
      log("response", {
        requestId,
        status: upstreamRes.status,
        stop_reason: anthropic.stop_reason,
        usage: anthropic.usage,
        contentTypes: anthropic.content.map((part) => part.type),
        toolMode,
        model: upstreamBody.model,
        fallbackUsed: usedFallback,
        nativeToolCalls: anthropic.content.filter((part) => part.type === "tool_use").length,
        durationMs: durationMs(startedAt),
      });
      writeJson(res, 200, anthropic);
  })().catch((error) => {
      log("proxy-error", { requestId, model: upstreamBody?.model, durationMs: durationMs(startedAt), error });
      writeJson(res, failureStatus(), { error: { type: "api_error", message: error.message } });
    });
}

function proxyCountTokens(req, res, body) {
  const requestId = makeRequestId("cc");
  const inputTokens = countAnthropicInputTokens(body);
  log("count-tokens", {
    requestId,
    method: req.method,
    url: req.url,
    input_tokens: inputTokens,
    client: summarizeAnthropicBody(body),
  });
  writeJson(res, 200, { input_tokens: inputTokens });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathName = new URL(req.url || "/", `http://${HOST}:${PORT}`).pathname;
    if (req.method === "GET" && pathName === "/health") {
      writeJson(res, 200, {
        ok: true,
        primary: DEFAULT_MODEL,
        fallback: fallbackModelFor({ model: DEFAULT_MODEL }) || null,
        models: [DEFAULT_MODEL, fallbackModelFor({ model: DEFAULT_MODEL })].filter(Boolean),
      });
      return;
    }
    if (req.method === "POST" && pathName === "/v1/messages/count_tokens") {
      const body = await readJson(req);
      proxyCountTokens(req, res, body);
      return;
    }
    if (req.method !== "POST" || pathName !== "/v1/messages") {
      log("not-found", { requestId: makeRequestId("cc"), method: req.method, url: req.url, pathName });
      writeJson(res, 404, { error: { type: "not_found_error", message: "not found" } });
      return;
    }
    const body = await readJson(req);
    proxyMessages(req, res, body);
  } catch (error) {
    log("server-error", { error });
    writeJson(res, 500, { error: { type: "api_error", message: error.message } });
  }
});

function startServer() {
  server.listen(PORT, HOST, () => {
    fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
    log("listening", {
      host: HOST,
      port: PORT,
      model: DEFAULT_MODEL,
      fallbackModel: fallbackModelFor({ model: DEFAULT_MODEL }) || undefined,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      streamReadTimeoutMs: STREAM_READ_TIMEOUT_MS,
      streamTotalTimeoutMs: STREAM_TOTAL_TIMEOUT_MS,
      streamParseChars: STREAM_PARSE_CHARS,
      upstreamRetryAttempts: UPSTREAM_RETRY_ATTEMPTS,
      failureStatus: FAILURE_STATUS,
      defaultToolMode: resolveToolMode(),
      defaultToolHistoryMode: resolveToolHistoryMode(),
    });
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
}

if (require.main === module) {
  startServer();
}

module.exports = {
  anthropicMessagesToOpenAI,
  anthropicToolsToPrompt,
  anthropicToolsToOpenAI,
  buildUpstreamBody,
  buildUpstreamRequest,
  countAnthropicInputTokens,
  contentToText,
  boundedToolParseText,
  createToolNameMaps,
  fallbackModelFor,
  hasToolExecutionHistory,
  hasUnsafeToolExecutionHistory,
  isRetryableFallbackStatus,
  isReadOnlyToolName,
  resolveToolHistoryMode,
  resolveToolMode,
  resolveClaudeThinking,
  resolveDeepseekThinking,
  selectRelevantTools,
  shouldFallbackToModel,
  startServer,
  toAnthropicMessage,
  upstreamToolName,
  userIntentText,
};
