const fs = require("fs");
const http = require("http");
const path = require("path");
const { envNumber, PROJECT_ROOT } = require("../shared/env");
const { createLogger, durationMs, makeRequestId } = require("../shared/logger");
const { listServices, normalizeServiceIds, getService } = require("./catalog");
const { buildDashboardState, readTail, restartServices, startServices, stopServices } = require("./process-manager");
const { TASK_NAME, isSupported: autostartSupported, isEnabled: isAutostartEnabled, queryTask, runAutostart, setAutostartConfig } = require("./autostart");
const { ensureRuntimeDir, loadState } = require("./state");
const { readEnvConfig, writeEnvConfig } = require("./env-config");

ensureRuntimeDir();

const PORT = envNumber("SZTU_SWITCHBOARD_PORT", 8795);
const HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(PROJECT_ROOT, "switchboard", "public");
const LOG_PATH = path.join(PROJECT_ROOT, "switchboard", ".runtime", "switchboard.log");
const log = createLogger("switchboard", LOG_PATH);
let taskQueryCache = { expiresAt: 0, installed: false };

function json(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
  const text = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": text.length,
    "Cache-Control": "no-cache",
  });
  res.end(text);
}

function isPublicFile(filePath) {
  const relative = path.relative(PUBLIC_DIR, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function handleApiState(res) {
  const dashboard = await buildDashboardState();
  const state = loadState();
  const taskInstalled = getCachedTaskInstalled();
  json(res, 200, {
    services: dashboard.services,
    summary: dashboard.summary,
    autostart: {
      enabled: state.autostart.enabled,
      services: state.autostart.services,
      supported: autostartSupported(),
      installed: taskInstalled,
      taskName: TASK_NAME,
      systemEnabled: isAutostartEnabled(),
    },
    server: {
      host: HOST,
      port: PORT,
    },
  });
}

function getCachedTaskInstalled() {
  if (Date.now() < taskQueryCache.expiresAt) {
    return taskQueryCache.installed;
  }
  const installed = queryTask().installed;
  taskQueryCache = {
    expiresAt: Date.now() + 5000,
    installed,
  };
  return installed;
}

async function handleApiLogs(req, res, url) {
  const serviceId = url.searchParams.get("service") || "";
  const service = getService(serviceId);
  if (!service) {
    json(res, 404, { error: `unknown service: ${serviceId}` });
    return;
  }
  const lines = Math.max(10, Math.min(Number(url.searchParams.get("lines") || 120) || 120, 400));
  const text = readTail(path.join(path.dirname(service.scriptPath), ".runtime", `${service.runtimeBaseName}.log`), lines);
  json(res, 200, {
    service: service.id,
    lines: text ? text.split(/\r?\n/) : [],
    text,
  });
}

async function handleAction(res, body) {
  const action = String(body.action || "").trim();
  const serviceIds = normalizeServiceIds(body.services || body.serviceIds || body.ids);
  if (action === "start") {
    json(res, 200, { ok: true, results: await startServices(serviceIds) });
    return;
  }
  if (action === "stop") {
    json(res, 200, { ok: true, results: await stopServices(serviceIds) });
    return;
  }
  if (action === "restart") {
    json(res, 200, { ok: true, results: await restartServices(serviceIds) });
    return;
  }
  if (action === "toggle-autostart") {
    const enabled = Boolean(body.enabled);
    const state = setAutostartConfig(enabled, serviceIds);
    json(res, 200, { ok: true, state });
    return;
  }
  if (action === "run-autostart") {
    json(res, 200, await runAutostart());
    return;
  }
  json(res, 400, { error: `unknown action: ${action}` });
}

function notFound(res, req) {
  json(res, 404, { error: "not found", url: req.url });
}

const server = http.createServer(async (req, res) => {
  const requestId = makeRequestId("sb");
  const startedAt = Date.now();
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, services: listServices().map((service) => service.id) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      await handleApiState(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      await handleApiLogs(req, res, url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/env") {
      json(res, 200, readEnvConfig());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/env") {
      const body = await parseBody(req);
      json(res, 200, writeEnvConfig(body.values));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      await handleAction(res, await parseBody(req));
      return;
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const filePath = path.resolve(PUBLIC_DIR, relative);
    if (!isPublicFile(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      notFound(res, req);
      return;
    }
    serveFile(res, filePath);
    log("static", { requestId, path: url.pathname, durationMs: durationMs(startedAt) });
  } catch (error) {
    log("server-error", { requestId, error });
    json(res, 500, { error: error.message });
  }
});

function startServer() {
  server.listen(PORT, HOST, () => {
    log("listening", { host: HOST, port: PORT });
  });
  server.on("error", (error) => {
    log("server-error", { error });
  });
}

module.exports = {
  PORT,
  HOST,
  isPublicFile,
  startServer,
};
