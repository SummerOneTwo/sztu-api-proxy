const fs = require("fs");

const SECRET_KEY_RE = /(api[-_]?key|authorization|password|secret|credential)/i;

function createLogger(service, logPath) {
  return function log(event, fields) {
    const entry = sanitizeForLog({
      ts: new Date().toISOString(),
      service,
      event,
      ...(fields && typeof fields === "object" ? fields : { message: fields }),
    });
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  };
}

function makeRequestId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function durationMs(startedAt) {
  return Date.now() - startedAt;
}

function summarizeBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const inputItems = Array.isArray(body?.input) ? body.input : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const contentChars = messages.reduce((sum, message) => sum + contentToText(message?.content).length, 0);
  const tools = Array.isArray(body?.tools) ? body.tools : [];

  return {
    model: body?.model,
    stream: body?.stream === true,
    max_tokens: body?.max_tokens,
    max_completion_tokens: body?.max_completion_tokens,
    max_output_tokens: body?.max_output_tokens,
    temperature: body?.temperature,
    messages: messages.length || undefined,
    input_items: inputItems.length || undefined,
    roles: messages.length ? messages.map((message) => message?.role || "?") : undefined,
    content_chars: contentChars || undefined,
    last_user: preview(contentToText(lastUser?.content), 300) || undefined,
    tools: tools.length || undefined,
    tool_names: tools.length ? tools.map((tool) => tool?.name || tool?.function?.name).filter(Boolean).slice(0, 20) : undefined,
    tool_choice: body?.tool_choice,
    stream_options: body?.stream_options,
    chat_template_kwargs: body?.chat_template_kwargs,
  };
}

function summarizeAnthropicBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const contentChars = messages.reduce((sum, message) => sum + contentToText(message?.content).length, 0);

  return {
    model: body?.model,
    stream: body?.stream === true,
    max_tokens: body?.max_tokens,
    temperature: body?.temperature,
    system_chars: contentToText(body?.system).length || undefined,
    messages: messages.length || undefined,
    roles: messages.length ? messages.map((message) => message?.role || "?") : undefined,
    content_chars: contentChars || undefined,
    last_user: preview(contentToText(lastUser?.content), 300) || undefined,
    tools: tools.length || undefined,
    tool_names: tools.length ? tools.map((tool) => tool?.name).filter(Boolean).slice(0, 30) : undefined,
    tool_choice: body?.tool_choice,
    thinking: body?.thinking?.type,
  };
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
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      if (Array.isArray(part.content)) {
        return contentToText(part.content);
      }
      return part.type ? `[${part.type}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function preview(value, max = 1000) {
  if (value == null) {
    return "";
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sanitizeForLog(value, key) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return isSecretKey(key) ? "[redacted]" : preview(value, 4000);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: value.cause?.message,
      stack: preview(value.stack, 4000),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeForLog(item));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = isSecretKey(childKey) ? "[redacted]" : sanitizeForLog(childValue, childKey);
    }
    return out;
  }
  return String(value);
}

function isSecretKey(key) {
  const text = String(key || "");
  if (SECRET_KEY_RE.test(text)) {
    return true;
  }
  return /(^|[_-])token$/i.test(text) || /(^|[_-])access[_-]?token$/i.test(text);
}

module.exports = {
  createLogger,
  durationMs,
  makeRequestId,
  preview,
  summarizeAnthropicBody,
  summarizeBody,
};
