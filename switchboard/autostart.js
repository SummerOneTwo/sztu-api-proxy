const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { PROJECT_ROOT } = require("../shared/env");
const { createLogger } = require("../shared/logger");
const { getService, normalizeServiceIds } = require("./catalog");
const { loadState, updateState, RUNTIME_DIR, ensureRuntimeDir } = require("./state");
const { startServices } = require("./process-manager");

ensureRuntimeDir();

const log = createLogger("switchboard", path.join(RUNTIME_DIR, "switchboard.log"));
const TASK_NAME = "SZTU API Switchboard Autostart";
const LAUNCHER_PATH = path.join(RUNTIME_DIR, "switchboard-autostart.cmd");
const SWITCHBOARD_SCRIPT = path.join(PROJECT_ROOT, "scripts", "sztu-switch.js");

function isSupported() {
  return process.platform === "win32";
}

function enabledServices() {
  return loadState().autostart.services;
}

function isEnabled() {
  return loadState().autostart.enabled;
}

function buildLauncherText() {
  const nodePath = process.execPath;
  return [
    "@echo off",
    "setlocal",
    `"${nodePath}" "${SWITCHBOARD_SCRIPT}" autostart-run`,
    "",
  ].join("\r\n");
}

function ensureLauncher() {
  ensureRuntimeDir();
  fs.writeFileSync(LAUNCHER_PATH, buildLauncherText(), "utf8");
}

function queryTask() {
  if (!isSupported()) {
    return { installed: false, supported: false };
  }
  const result = spawnSync("schtasks", ["/Query", "/TN", TASK_NAME], {
    windowsHide: true,
    encoding: "utf8",
  });
  return {
    supported: true,
    installed: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function createTask() {
  ensureLauncher();
  execFileSync(
    "schtasks",
    ["/Create", "/TN", TASK_NAME, "/TR", LAUNCHER_PATH, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"],
    {
      windowsHide: true,
      stdio: "ignore",
    }
  );
  log("autostart-create", { taskName: TASK_NAME, launcher: LAUNCHER_PATH });
}

function deleteTask() {
  if (!isSupported()) {
    return;
  }
  spawnSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  try {
    if (fs.existsSync(LAUNCHER_PATH)) {
      fs.unlinkSync(LAUNCHER_PATH);
    }
  } catch {}
  log("autostart-delete", { taskName: TASK_NAME });
}

function setAutostartConfig(enabled, serviceIds) {
  const services = normalizeServiceIds(serviceIds);
  const next = updateState((state) => ({
    ...state,
    autostart: {
      enabled: Boolean(enabled),
      services,
    },
  }));
  if (next.autostart.enabled && next.autostart.services.length > 0 && isSupported()) {
    createTask();
  }
  if (!next.autostart.enabled) {
    deleteTask();
  }
  return next;
}

async function runAutostart() {
  const state = loadState();
  if (!state.autostart.enabled) {
    return { ok: true, skipped: true, reason: "autostart disabled" };
  }
  const services = state.autostart.services
    .map((id) => getService(id))
    .filter(Boolean)
    .map((service) => service.id);
  if (services.length === 0) {
    return { ok: true, skipped: true, reason: "no services selected" };
  }
  const results = await startServices(services);
  log("autostart-run", { services, results: results.map((item) => ({ id: item.id, ok: item.ok })) });
  return {
    ok: results.every((item) => item.ok),
    services,
    results,
  };
}

module.exports = {
  TASK_NAME,
  LAUNCHER_PATH,
  buildLauncherText,
  createTask,
  deleteTask,
  enabledServices,
  isEnabled,
  isSupported,
  queryTask,
  runAutostart,
  setAutostartConfig,
};
