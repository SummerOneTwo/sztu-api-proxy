const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { PROJECT_ROOT } = require("../shared/env");
const { createLogger, durationMs } = require("../shared/logger");
const { getService, listServices, normalizeServiceIds } = require("./catalog");
const { RUNTIME_DIR, ensureRuntimeDir } = require("./state");

ensureRuntimeDir();

const log = createLogger("switchboard", path.join(RUNTIME_DIR, "switchboard.log"));

function serviceRuntimeDir(service) {
  return path.join(path.dirname(service.scriptPath), ".runtime");
}

function servicePidPath(service) {
  return path.join(serviceRuntimeDir(service), `${service.runtimeBaseName}.pid`);
}

function serviceLogPath(service) {
  return path.join(serviceRuntimeDir(service), `${service.runtimeBaseName}.log`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPid(pidPath) {
  try {
    const text = fs.readFileSync(pidPath, "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });
    const text = await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getServiceStatus(serviceOrId) {
  const service = typeof serviceOrId === "string" ? getService(serviceOrId) : serviceOrId;
  if (!service) {
    return null;
  }

  const pidPath = servicePidPath(service);
  const pid = readPid(pidPath);
  const running = processAlive(pid);
  if (!running) {
    if (pid && fs.existsSync(pidPath)) {
      try {
        fs.unlinkSync(pidPath);
      } catch {}
    }
    return {
      ...service,
      pid: null,
      running: false,
      healthy: false,
      state: "stopped",
      health: { ok: false, status: 0, error: "not running" },
      pidPath,
      logPath: serviceLogPath(service),
      startedAt: null,
    };
  }

  const health = await probeHealth(service.healthUrl);
  const stat = fs.existsSync(pidPath) ? fs.statSync(pidPath) : null;
  const startedAt = stat ? stat.mtimeMs : null;
  const state = health.ok ? "running" : "degraded";
  return {
    ...service,
    pid,
    running: true,
    healthy: health.ok,
    state,
    health,
    pidPath,
    logPath: serviceLogPath(service),
    startedAt,
  };
}

async function getAllServiceStatuses() {
  return Promise.all(listServices().map((service) => getServiceStatus(service)));
}

async function waitForStart(service, startedAt) {
  const deadline = Date.now() + 12000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await getServiceStatus(service);
    if (lastStatus.running && lastStatus.healthy) {
      return { ok: true, status: lastStatus, durationMs: Date.now() - startedAt };
    }
    if (lastStatus.running && lastStatus.state === "degraded") {
      return { ok: true, status: lastStatus, durationMs: Date.now() - startedAt, warning: "service started but health check is not ready yet" };
    }
    await sleep(250);
  }
  return {
    ok: Boolean(lastStatus?.running),
    status: lastStatus,
    durationMs: Date.now() - startedAt,
    warning: lastStatus?.running ? "service is still starting" : "service did not start",
  };
}

function launchService(service) {
  fs.mkdirSync(serviceRuntimeDir(service), { recursive: true });
  const child = spawn(process.execPath, [service.scriptPath], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return child.pid;
}

async function startService(id) {
  const service = getService(id);
  if (!service) {
    return { ok: false, error: `unknown service: ${id}` };
  }

  const existing = await getServiceStatus(service);
  if (existing?.running) {
    return { ok: true, alreadyRunning: true, status: existing };
  }

  const startedAt = Date.now();
  const pid = launchService(service);
  log("start", { service: service.id, pid, scriptPath: service.scriptPath });
  const started = await waitForStart(service, startedAt);
  return {
    ok: started.ok,
    pid,
    warning: started.warning,
    status: started.status || (await getServiceStatus(service)),
  };
}

async function stopService(id) {
  const service = getService(id);
  if (!service) {
    return { ok: false, error: `unknown service: ${id}` };
  }

  const pidPath = servicePidPath(service);
  const pid = readPid(pidPath);
  if (!pid) {
    return { ok: true, alreadyStopped: true, status: await getServiceStatus(service) };
  }

  const startedAt = Date.now();
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
      await sleep(1200);
      if (processAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {}

  for (let attempt = 0; attempt < 20; attempt++) {
    if (!processAlive(pid)) {
      break;
    }
    await sleep(150);
  }

  try {
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
  } catch {}

  log("stop", { service: service.id, pid, durationMs: Date.now() - startedAt });
  return {
    ok: true,
    status: await getServiceStatus(service),
  };
}

async function restartService(id) {
  const stopped = await stopService(id);
  if (!stopped.ok) {
    return stopped;
  }
  const started = await startService(id);
  return {
    ok: started.ok,
    status: started.status,
    warning: started.warning,
  };
}

async function startServices(ids) {
  const results = [];
  for (const id of normalizeServiceIds(ids)) {
    results.push({ id, ...(await startService(id)) });
  }
  return results;
}

async function stopServices(ids) {
  const results = [];
  for (const id of normalizeServiceIds(ids)) {
    results.push({ id, ...(await stopService(id)) });
  }
  return results;
}

async function restartServices(ids) {
  const results = [];
  for (const id of normalizeServiceIds(ids)) {
    results.push({ id, ...(await restartService(id)) });
  }
  return results;
}

function readTail(filePath, lines = 120) {
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stat.size - start);
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const parts = text.split(/\r?\n/);
    return parts.slice(Math.max(0, parts.length - lines)).join("\n").trimEnd();
  } catch {
    return "";
  }
}

async function buildDashboardState() {
  const statuses = await getAllServiceStatuses();
  const running = statuses.filter((service) => service.running).length;
  const healthy = statuses.filter((service) => service.healthy).length;
  return {
    services: statuses,
    summary: {
      total: statuses.length,
      running,
      healthy,
      stopped: statuses.length - running,
    },
  };
}

module.exports = {
  buildDashboardState,
  getAllServiceStatuses,
  getServiceStatus,
  readTail,
  restartService,
  restartServices,
  serviceLogPath,
  servicePidPath,
  serviceRuntimeDir,
  startService,
  startServices,
  stopService,
  stopServices,
};
