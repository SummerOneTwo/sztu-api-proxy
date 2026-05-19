const http = require("http");
const fs = require("fs");
const path = require("path");
const { getApiKey, envNumber, loadDotEnv } = require("../shared/env");

loadDotEnv();

const HOST = "127.0.0.1";
const PORT = envNumber("CLAUDE_SZTU_PROXY_PORT", 8790);
const UPSTREAM_URL = process.env.SZTU_UPSTREAM_URL || "https://apiai.sztu.edu.cn/v1/chat/completions";
const CLAUDE_DIR = __dirname;
const RUNTIME_DIR = path.join(CLAUDE_DIR, ".runtime");
const LOG_PATH = path.join(RUNTIME_DIR, "claudecode-proxy.log");
const PID_PATH = path.join(RUNTIME_DIR, "claudecode-proxy.pid");
const DEFAULT_MODEL = process.env.SZTU_DEFAULT_MODEL || "glm-5.1";
const DEFAULT_MAX_TOKENS = envNumber("SZTU_DEFAULT_MAX_TOKENS", 16384);
const MAX_TOKENS = envNumber("SZTU_MAX_TOKENS", 32768);

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

function log(message, extra) {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}${suffix}\n`, "utf8");
}

function readApiKey() {
  return getApiKey();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === 3) {
        return response;
      }
      const text = await response.text().catch(() => "");
      log("upstream-retryable-status", { attempt, status: response.status, text: text.slice(0, 500) });
    } catch (error) {
      lastError = error;
      if (attempt === 3) {
        break;
      }
      log("upstream-retryable-error", { attempt, message: error.message, cause: error.cause?.message });
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

function normalizeMaxTokens(value) {
  const n = Number(value);
  const configuredMax = Math.min(DEFAULT_MAX_TOKENS, MAX_TOKENS);
  if (!Number.isFinite(n) || n <= 0) {
    return configuredMax;
  }
  return Math.min(Math.trunc(n), configuredMax);
}

function upstreamModel(model) {
  const raw = typeof model === "string" ? model : "";
  if (raw.includes("deepseek") || raw.includes("ds") || raw.includes("haiku")) {
    return "deepseek-v4-pro";
  }
  return DEFAULT_MODEL;
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

function anthropicMessagesToOpenAI(body) {
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

  const toolPrompt = anthropicToolsToPrompt(body.tools, body.messages);
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
        } else if (part?.type === "tool_use") {
          if (process.env.CLAUDE_SZTU_FORWARD_TOOLS === "1") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input || {}),
              },
            });
          }
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
        for (const part of toolResults) {
          messages.push({
            role: "user",
            content: `Tool result:\n${contentToText(part.content)}\n\nAnswer the user's original request directly. Do not mention the tool call.`,
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
    "You may use one tool by responding with exactly one XML-like tool call and no other text.",
    'Format: <tool_call>{"name":"ToolName","input":{...}}</tool_call>',
    "After a tool result is provided, continue normally or request another tool call.",
    "Available tools:",
    summarized,
  ].join("\n");
}

function selectRelevantTools(tools, messages) {
  const lastUserText = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "user");
  const text = contentToText(lastUserText?.content).toLowerCase();
  if (!text) {
    return [];
  }

  const wanted = new Set();
  const add = (...names) => names.forEach((name) => wanted.add(name.toLowerCase()));

  if (/(read|open|cat|查看|读取|阅读|打开|文件|file|agents\.md|readme|package\.json)/i.test(text)) {
    add("Read", "LS");
  }
  if (/(grep|search|find|rg|搜索|查找|寻找|匹配)/i.test(text)) {
    add("Grep", "Glob", "Read");
  }
  if (/(edit|write|modify|patch|change|fix|implement|update|修改|编辑|写入|修复|实现|更新|改成|补丁)/i.test(text)) {
    add("Read", "Edit", "MultiEdit", "Write", "Grep", "Glob");
  }
  if (/(bash|shell|run|execute|command|test|npm|uv|python|node|执行|运行|命令|测试)/i.test(text)) {
    add("Bash", "Read");
  }

  if (wanted.size === 0) {
    return [];
  }
  return tools.filter((tool) => wanted.has(String(tool?.name || "").toLowerCase()));
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  return tools
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

function buildUpstreamBody(body) {
  const model = upstreamModel(body.model);
  const maxTokens = normalizeMaxTokens(body.max_tokens);
  const upstream = {
    model,
    messages: anthropicMessagesToOpenAI(body),
    stream: body.stream === true,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    max_tokens: maxTokens,
  };

  const shouldForwardTools = process.env.CLAUDE_SZTU_FORWARD_TOOLS === "1";
  const tools = shouldForwardTools ? anthropicToolsToOpenAI(body.tools) : undefined;
  if (tools) {
    upstream.tools = tools;
    upstream.tool_choice = body.tool_choice ? "auto" : "auto";
  }

  if (model === "deepseek-v4-pro") {
    upstream.chat_template_kwargs = { thinking: false };
  } else {
    upstream.chat_template_kwargs = { enable_thinking: false };
  }

  if (upstream.stream) {
    upstream.stream_options = { include_usage: true };
  }

  Object.keys(upstream).forEach((key) => upstream[key] === undefined && delete upstream[key]);
  return upstream;
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

function toAnthropicMessage(payload, requestedModel) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const parsedTool = parseToolCallText(message.content);

  if (parsedTool) {
    content.push(parsedTool);
  } else if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }

  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function?.name,
      input: safeJson(toolCall.function?.arguments),
    });
  }

  return {
    id: payload?.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel || payload?.model || DEFAULT_MODEL,
    content,
    stop_reason: parsedTool ? "tool_use" : stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usage?.prompt_tokens || 0,
      output_tokens: payload?.usage?.completion_tokens || 0,
    },
  };
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

function parseToolCallText(text) {
  if (typeof text !== "string") {
    return null;
  }
  const looseTool = text.match(/Tool:\s*([A-Za-z0-9_-]+)\s*(?:\r?\n)+Arguments:\s*([\s\S]+)/i);
  if (looseTool) {
    const argsText = extractFirstJsonObject(looseTool[2]) || "{}";
    return {
      type: "tool_use",
      id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: looseTool[1],
      input: safeJson(argsText),
    };
  }
  const namedXmlTool = text.match(/<tool_call\s+name=["']?([A-Za-z0-9_-]+)["']?>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (namedXmlTool) {
    const argsText = extractFirstJsonObject(namedXmlTool[2]) || "{}";
    return {
      type: "tool_use",
      id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: namedXmlTool[1],
      input: safeJson(argsText),
    };
  }
  const parameterXmlTool = text.match(/<tool\s+name=["']?([A-Za-z0-9_-]+)["']?>\s*([\s\S]*?)<\/tool>/i) ||
    text.match(/<tool\s+name=["']?([A-Za-z0-9_-]+)["']?>\s*([\s\S]*)/i);
  if (parameterXmlTool) {
    const input = {};
    const params = parameterXmlTool[2].matchAll(/<parameter\s+name=["']?([^"'>\s]+)["']?>\s*([\s\S]*?)\s*<\/parameter>/gi);
    for (const param of params) {
      input[param[1]] = param[2].trim();
    }
    return {
      type: "tool_use",
      id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: parameterXmlTool[1],
      input,
    };
  }
  const argKeyTool = text.match(/<tool_call>\s*([A-Za-z0-9_-]+)\s*([\s\S]*?)<\/tool_call>/i);
  if (argKeyTool) {
    const input = {};
    const pairs = argKeyTool[2].matchAll(/<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi);
    for (const pair of pairs) {
      input[pair[1].trim()] = pair[2].trim();
    }
    return {
      type: "tool_use",
      id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: argKeyTool[1],
      input,
    };
  }
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  const jsonText = match ? match[1] : extractFirstJsonObject(text);
  if (!jsonText) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.name !== "string") {
    return null;
  }
  return {
    type: "tool_use",
    id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: parsed.name,
    input: parsed.input && typeof parsed.input === "object" ? parsed.input : {},
  };
}

function extractFirstJsonObject(text) {
  if (typeof text !== "string") {
    return null;
  }
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamAnthropicFromUpstream(res, upstreamRes, requestedModel) {
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

  res.writeHead(upstreamRes.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, "message_start", createdMessage);

  let buffer = "";
  let text = "";
  let stop = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };

  function handleData(dataText) {
    if (dataText === "[DONE]") {
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(dataText);
    } catch (error) {
      log("bad-upstream-sse", { data: dataText.slice(0, 500), error: error.message });
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
      text += delta.content;
    }
    for (const toolCall of delta.tool_calls || []) {
      text += `<tool_call>${JSON.stringify({
        name: toolCall.function?.name,
        input: safeJson(toolCall.function?.arguments),
      })}</tool_call>`;
      stop = "tool_use";
    }
  }

  (async () => {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
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

    if (buffer.trim()) {
      const dataLines = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      for (const dataLine of dataLines) {
        handleData(dataLine);
      }
    }
    const parsedTool = parseToolCallText(text);
    if (parsedTool) {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: parsedTool,
      });
      writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
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
    log("stream-response", { stop_reason: stop, usage });
    res.end();
  })().catch((error) => {
    log("stream-error", { message: error.message });
    if (!res.destroyed) {
      res.end();
    }
  });
}

function proxyMessages(req, res, body) {
  const apiKey = readApiKey();
  if (!apiKey) {
    writeJson(res, 500, { error: { type: "api_error", message: "missing SZTU API key" } });
    return;
  }

  const upstreamBody = buildUpstreamBody(body);
  log("request", {
    requestedModel: body.model,
    upstreamModel: upstreamBody.model,
    stream: upstreamBody.stream,
    max_tokens: upstreamBody.max_tokens,
    messages: upstreamBody.messages.length,
    tools: Array.isArray(upstreamBody.tools) ? upstreamBody.tools.length : 0,
  });

  const payload = JSON.stringify(upstreamBody);
  const upstream = fetchWithRetry(UPSTREAM_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: upstreamBody.stream ? "text/event-stream" : "application/json",
    },
    body: payload,
  });

  upstream
    .then(async (upstreamRes) => {
      if (upstreamBody.stream) {
        if (!upstreamRes.ok) {
          const text = await upstreamRes.text();
          log("upstream-error-response", { status: upstreamRes.status, text: text.slice(0, 1000) });
          writeJson(res, upstreamRes.status, {
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
        streamAnthropicFromUpstream(res, upstreamRes, body.model);
        return;
      }

      const text = await upstreamRes.text();
      if (!upstreamRes.ok) {
        log("upstream-error-response", { status: upstreamRes.status, text: text.slice(0, 1000) });
        res.writeHead(upstreamRes.status, { "content-type": "application/json; charset=utf-8" });
        res.end(text);
        return;
      }
      const data = JSON.parse(text);
      const anthropic = toAnthropicMessage(data, body.model);
      log("response", {
        status: upstreamRes.status,
        stop_reason: anthropic.stop_reason,
        usage: anthropic.usage,
        contentTypes: anthropic.content.map((part) => part.type),
      });
      writeJson(res, 200, anthropic);
    })
    .catch((error) => {
      log("proxy-error", { message: error.message, cause: error.cause?.message });
      writeJson(res, 502, { error: { type: "api_error", message: error.message } });
    });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathName = new URL(req.url || "/", `http://${HOST}:${PORT}`).pathname;
    if (req.method === "GET" && pathName === "/health") {
      writeJson(res, 200, { ok: true, models: ["glm-5.1", "deepseek-v4-pro"] });
      return;
    }
    if (req.method !== "POST" || pathName !== "/v1/messages") {
      log("not-found", { method: req.method, url: req.url, pathName });
      writeJson(res, 404, { error: { type: "not_found_error", message: "not found" } });
      return;
    }
    const body = await readJson(req);
    proxyMessages(req, res, body);
  } catch (error) {
    log("server-error", { message: error.message, stack: error.stack });
    writeJson(res, 500, { error: { type: "api_error", message: error.message } });
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
