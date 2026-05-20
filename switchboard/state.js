const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT } = require("../shared/env");
const { normalizeServiceIds } = require("./catalog");

const RUNTIME_DIR = path.join(PROJECT_ROOT, "switchboard", ".runtime");
const STATE_PATH = path.join(RUNTIME_DIR, "switchboard-state.json");

function defaultState() {
  return {
    version: 1,
    autostart: {
      enabled: false,
      services: [],
    },
  };
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function normalizeState(state) {
  const source = state && typeof state === "object" ? state : {};
  const autostart = source.autostart && typeof source.autostart === "object" ? source.autostart : {};
  return {
    version: 1,
    autostart: {
      enabled: autostart.enabled === true,
      services: normalizeServiceIds(autostart.services),
    },
  };
}

function loadState() {
  try {
    ensureRuntimeDir();
    const text = fs.readFileSync(STATE_PATH, "utf8");
    return normalizeState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  ensureRuntimeDir();
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
}

function updateState(updater) {
  const current = loadState();
  const next = updater ? updater(current) : current;
  const normalized = normalizeState(next);
  saveState(normalized);
  return normalized;
}

module.exports = {
  STATE_PATH,
  RUNTIME_DIR,
  defaultState,
  ensureRuntimeDir,
  loadState,
  normalizeState,
  saveState,
  updateState,
};
