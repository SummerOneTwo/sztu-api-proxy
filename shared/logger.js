const fs = require("fs");
const path = require("path");
const {
  ensureRuntimeLayout,
  eventsPath,
  payloadFile,
  streamPath,
} = require("./runtime-paths");

const LOG_RETENTION_DAYS = 3;
const RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneTimers = new Map();

function dateKeyForTs(ts = new Date()) {
  const year = ts.getFullYear();
  const month = String(ts.getMonth() + 1).padStart(2, "0");
  const day = String(ts.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatForLog(value) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: value.cause?.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatForLog(item));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = formatForLog(childValue);
    }
    return out;
  }
  return String(value);
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function bodiesDiffer(a, b) {
  return stableStringify(a) !== stableStringify(b);
}

function writeFileAsync(filePath, data) {
  return new Promise((resolve, reject) => {
    fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        reject(mkdirErr);
        return;
      }
      fs.writeFile(filePath, data, (writeErr) => {
        if (writeErr) {
          reject(writeErr);
          return;
        }
        resolve();
      });
    });
  });
}

function appendFileAsync(filePath, data) {
  return new Promise((resolve, reject) => {
    fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        reject(mkdirErr);
        return;
      }
      fs.appendFile(filePath, data, (appendErr) => {
        if (appendErr) {
          reject(appendErr);
          return;
        }
        resolve();
      });
    });
  });
}

function removePathAsync(targetPath) {
  return new Promise((resolve) => {
    fs.rm(targetPath, { recursive: true, force: true }, () => resolve());
  });
}

function listDirAsync(dirPath) {
  return new Promise((resolve) => {
    fs.readdir(dirPath, { withFileTypes: true }, (err, entries) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(entries);
    });
  });
}

function statAsync(targetPath) {
  return new Promise((resolve) => {
    fs.stat(targetPath, (err, stats) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stats);
    });
  });
}

async function pruneRuntime(serviceDir) {
  const cutoff = Date.now() - RETENTION_MS;
  const eventsRoot = path.join(serviceDir, ".runtime", "events");
  const payloadsRootDir = path.join(serviceDir, ".runtime", "payloads");
  const streamsRootDir = path.join(serviceDir, ".runtime", "streams");

  const eventEntries = await listDirAsync(eventsRoot);
  for (const entry of eventEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(eventsRoot, entry.name);
    const stats = await statAsync(filePath);
    if (stats && stats.mtimeMs < cutoff) {
      await removePathAsync(filePath);
    }
  }

  for (const rootDir of [payloadsRootDir, streamsRootDir]) {
    const entries = await listDirAsync(rootDir);
    for (const entry of entries) {
      const targetPath = path.join(rootDir, entry.name);
      const stats = await statAsync(targetPath);
      if (stats && stats.mtimeMs < cutoff) {
        await removePathAsync(targetPath);
      }
    }
  }
}

function schedulePrune(serviceDir) {
  if (pruneTimers.has(serviceDir)) {
    return;
  }
  pruneRuntime(serviceDir).catch(() => {});
  const timer = setInterval(() => {
    pruneRuntime(serviceDir).catch(() => {});
  }, PRUNE_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  pruneTimers.set(serviceDir, timer);
}

function createWriteQueue() {
  let chain = Promise.resolve();
  return function enqueue(task) {
    chain = chain.then(task).catch(() => {});
    return chain;
  };
}

function createLogger(service, serviceDir) {
  ensureRuntimeLayout(serviceDir);
  schedulePrune(serviceDir);
  const enqueue = createWriteQueue();

  function log(event, fields) {
    const ts = new Date();
    const entry = formatForLog({
      ts: ts.toISOString(),
      service,
      event,
      ...(fields && typeof fields === "object" ? fields : { message: fields }),
    });
    const line = `${JSON.stringify(entry)}\n`;
    const filePath = eventsPath(serviceDir, dateKeyForTs(ts));
    enqueue(() => appendFileAsync(filePath, line));
  }

  function logPayload(requestId, name, data) {
    if (!requestId || !name) {
      return;
    }
    const filePath = payloadFile(serviceDir, requestId, name);
    const text = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
    enqueue(() => writeFileAsync(filePath, text));
  }

  function logPayloadIfDifferent(requestId, name, data, baseline) {
    if (!requestId || !name || !bodiesDiffer(data, baseline)) {
      return;
    }
    logPayload(requestId, name, data);
  }

  function logStream(requestId, text) {
    if (!requestId) {
      return;
    }
    const filePath = streamPath(serviceDir, requestId);
    enqueue(() => writeFileAsync(filePath, typeof text === "string" ? text : String(text ?? "")));
  }

  function logRequestBodies(requestId, clientBody, sanitizedBody) {
    logPayload(requestId, "sanitized.json", sanitizedBody);
    logPayloadIfDifferent(requestId, "client.json", clientBody, sanitizedBody);
  }

  return {
    log,
    logPayload,
    logPayloadIfDifferent,
    logRequestBodies,
    logStream,
  };
}

function makeRequestId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function durationMs(startedAt) {
  return Date.now() - startedAt;
}

function requestMeta(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    model: body?.model,
    stream: body?.stream === true,
    max_tokens: body?.max_tokens,
    messages: messages.length || undefined,
    tools: tools.length || undefined,
    tool_choice: body?.tool_choice,
    chat_template_kwargs: body?.chat_template_kwargs,
  };
}

module.exports = {
  bodiesDiffer,
  createLogger,
  dateKeyForTs,
  durationMs,
  logRetentionMs: () => RETENTION_MS,
  makeRequestId,
  pruneRuntime,
  requestMeta,
};
