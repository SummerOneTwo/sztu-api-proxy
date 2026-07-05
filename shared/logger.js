const fs = require("fs");
const path = require("path");

const LOG_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneTimers = new Map();

function logRetentionMs() {
  return LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function pruneLogFile(logPath) {
  if (!fs.existsSync(logPath)) {
    return;
  }
  const cutoff = Date.now() - logRetentionMs();
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    if (!raw) {
      return;
    }
    const kept = [];
    let dropped = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        const ts = Date.parse(entry.ts);
        if (Number.isFinite(ts) && ts < cutoff) {
          dropped += 1;
          continue;
        }
      } catch {
        // keep malformed lines
      }
      kept.push(line);
    }
    if (dropped > 0) {
      fs.writeFileSync(logPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    }
  } catch {
    // ignore prune errors
  }
}

function schedulePrune(logPath) {
  if (pruneTimers.has(logPath)) {
    return;
  }
  pruneLogFile(logPath);
  const timer = setInterval(() => pruneLogFile(logPath), PRUNE_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  pruneTimers.set(logPath, timer);
}

function createLogger(service, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  schedulePrune(logPath);
  return function log(event, fields) {
    const entry = formatForLog({
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
  return body;
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

module.exports = {
  createLogger,
  durationMs,
  logRetentionMs,
  makeRequestId,
  pruneLogFile,
  summarizeBody,
};
