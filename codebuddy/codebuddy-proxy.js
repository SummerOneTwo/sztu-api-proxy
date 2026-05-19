const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { getApiKey, envNumber } = require("../shared/env");

const PORT = envNumber("CODEBUDDY_PROXY_PORT", envNumber("PORT", 8787));
const TARGET_HOST = "apiai.sztu.edu.cn";
const TARGET_PATH = "/v1/chat/completions";
const LOG_DIR = path.join(__dirname, ".runtime");
const LOG_PATH = path.join(LOG_DIR, "codebuddy-proxy.log");
const PID_PATH = path.join(LOG_DIR, "codebuddy-proxy.pid");
const SZTU_DEFAULT_MAX_TOKENS = envNumber("SZTU_DEFAULT_MAX_TOKENS", 16384);
const SZTU_MAX_TOKENS = envNumber("SZTU_MAX_TOKENS", 32768);

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(LOG_PATH, line, "utf8");
}

function cleanupAndExit(signal) {
  log(`shutdown signal=${signal}`);
  try {
    if (fs.existsSync(PID_PATH)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch (error) {
    log(`pid-cleanup-error ${String(error)}`);
  }
  process.exit(0);
}

function normalizeMaxTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return Math.min(SZTU_DEFAULT_MAX_TOKENS, SZTU_MAX_TOKENS);
  }
  return Math.min(Math.trunc(n), SZTU_DEFAULT_MAX_TOKENS, SZTU_MAX_TOKENS);
}

function sanitizeBody(body) {
  const next = { ...body };

  const requestedMaxTokens = normalizeMaxTokens(
    next.max_tokens ?? next.max_completion_tokens ?? next.max_output_tokens
  );
  if (requestedMaxTokens !== undefined) {
    next.max_tokens = requestedMaxTokens;
    if (next.max_completion_tokens !== undefined) {
      next.max_completion_tokens = requestedMaxTokens;
    }
  }

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

  if (next.model === "deepseek-v4-pro") {
    next.chat_template_kwargs = {
      ...(next.chat_template_kwargs && typeof next.chat_template_kwargs === "object"
        ? next.chat_template_kwargs
        : {}),
      thinking: true,
      reasoning_effort: "max",
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
        } else if (Array.isArray(message?.tool_calls)) {
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
    chat_template_kwargs:
      body.model === "glm-5.1"
        ? {
          enable_thinking: true,
        }
        : undefined,
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

function summarizeBody(body) {
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

function forwardChatCompletionStream(res, upstreamRes) {
  res.writeHead(upstreamRes.statusCode || 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": upstreamRes.headers["cache-control"] || "no-cache",
    Connection: "keep-alive",
  });
  upstreamRes.pipe(res);
}

function emitResponsesStreamFromChatStream(res, upstreamRes) {
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
      log(`invalid-upstream-sse-json ${String(error)} raw=${dataText.slice(0, 1000)}`);
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
  if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/v1/responses")) {
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
      log(`invalid-json ${String(error)}`);
      writeJson(res, 400, { error: "invalid json" });
      return;
    }

    const isResponsesApi = req.url === "/v1/responses";
    const nextBody = isResponsesApi ? responsesToChatCompletions(body) : sanitizeBody(body);
    const wantsStream = nextBody.stream === true;
    const upstreamBody = nextBody;
    const apiKey = getApiKey();
    if (!apiKey) {
      writeJson(res, 500, { error: "missing SZTU_API_KEY in environment or .env" });
      return;
    }
    log(`request body=${JSON.stringify(summarizeBody(body))} sanitized=${JSON.stringify(summarizeBody(nextBody))} upstream=${JSON.stringify(summarizeBody(upstreamBody))}`);

    const upstream = https.request(
      {
        hostname: TARGET_HOST,
        path: TARGET_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
      },
      (upstreamRes) => {
        log(`response status=${upstreamRes.statusCode}`);
        if (wantsStream && (upstreamRes.statusCode || 500) < 400) {
          if (isResponsesApi) {
            emitResponsesStreamFromChatStream(res, upstreamRes);
          } else {
            forwardChatCompletionStream(res, upstreamRes);
          }
          return;
        }

        const chunks = [];

        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const rawResponse = Buffer.concat(chunks);
          const text = rawResponse.toString("utf8");

          if ((upstreamRes.statusCode || 500) >= 400) {
            res.writeHead(upstreamRes.statusCode || 502, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(text);
            return;
          }

          try {
            const payload = JSON.parse(text);
            if (!isResponsesApi) {
              const headers = {
                "Content-Type": upstreamRes.headers["content-type"] || "application/json; charset=utf-8",
                "Cache-Control": upstreamRes.headers["cache-control"] || "no-cache",
                Connection: "keep-alive",
              };

              res.writeHead(upstreamRes.statusCode || 200, headers);
              res.end(rawResponse);
              return;
            }

            writeJson(res, upstreamRes.statusCode || 200, chatCompletionsToResponses(payload));
          } catch (error) {
            log(`invalid-upstream-json ${String(error)} raw=${text.slice(0, 4000)}`);
            writeJson(res, 502, { error: "invalid upstream json" });
          }
        });
      }
    );

    upstream.on("error", (error) => {
      log(`upstream-error ${String(error)}`);
      if (!res.headersSent) {
        writeJson(res, 502, { error: String(error) });
        return;
      }
      res.end();
    });

    upstream.write(JSON.stringify(upstreamBody));
    upstream.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
  log(`listening http://127.0.0.1:${PORT}`);
});

server.on("error", (error) => {
  log(`server-error ${String(error)}`);
});

process.on("SIGINT", () => cleanupAndExit("SIGINT"));
process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));
process.on("exit", () => {
  try {
    if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch (error) {
    log(`pid-exit-cleanup-error ${String(error)}`);
  }
});
