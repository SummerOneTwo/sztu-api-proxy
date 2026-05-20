const path = require("path");
const { PROJECT_ROOT, envNumber, loadDotEnv } = require("../shared/env");

loadDotEnv();

function serviceUrl(port, healthPath = "/health") {
  return `http://127.0.0.1:${port}${healthPath}`;
}

function makeService(definition) {
  const port = envNumber(definition.portEnv, definition.defaultPort);
  return {
    id: definition.id,
    name: definition.name,
    shortName: definition.shortName,
    description: definition.description,
    scriptPath: path.join(PROJECT_ROOT, definition.scriptPath),
    runtimeBaseName: definition.runtimeBaseName,
    port,
    healthPath: definition.healthPath || "/health",
    healthUrl: serviceUrl(port, definition.healthPath || "/health"),
    tags: definition.tags || [],
  };
}

const SERVICES = [
  makeService({
    id: "opencode",
    name: "OpenCode",
    shortName: "OC",
    description: "OpenCode chat / responses bridge",
    scriptPath: "opencode/opencode-proxy.js",
    runtimeBaseName: "opencode-proxy",
    portEnv: "OPENCODE_PROXY_PORT",
    defaultPort: 8788,
  }),
  makeService({
    id: "codebuddy",
    name: "CodeBuddy",
    shortName: "CB",
    description: "CodeBuddy chat / responses bridge",
    scriptPath: "codebuddy/codebuddy-proxy.js",
    runtimeBaseName: "codebuddy-proxy",
    portEnv: "CODEBUDDY_PROXY_PORT",
    defaultPort: 8787,
  }),
  makeService({
    id: "claudecode",
    name: "Claude Code",
    shortName: "CC",
    description: "Claude Code Anthropic compatibility proxy",
    scriptPath: "claudecode/claudecode-proxy.js",
    runtimeBaseName: "claudecode-proxy",
    portEnv: "CLAUDE_SZTU_PROXY_PORT",
    defaultPort: 8790,
  }),
];

function listServices() {
  return SERVICES.slice();
}

function getService(id) {
  return SERVICES.find((service) => service.id === id) || null;
}

function normalizeServiceIds(ids) {
  const valid = new Set(SERVICES.map((service) => service.id));
  return [...new Set((Array.isArray(ids) ? ids : [ids]).map((value) => String(value || "").trim()).filter((id) => valid.has(id)))];
}

module.exports = {
  getService,
  listServices,
  normalizeServiceIds,
  SERVICES,
};
