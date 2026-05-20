const { spawn } = require("child_process");
const { listServices, normalizeServiceIds } = require("./catalog");
const { buildDashboardState, getServiceStatus, restartServices, startServices, stopServices } = require("./process-manager");
const { loadState } = require("./state");
const { queryTask, isSupported: autostartSupported, setAutostartConfig, runAutostart } = require("./autostart");
const { startServer, PORT, HOST } = require("./server");

function title(text) {
  console.log(`\n${text}`);
}

function line(label, value) {
  console.log(`${label.padEnd(14)} ${value}`);
}

function printUsage() {
  console.log(`SZTU Switchboard

Usage:
  node scripts/sztu-switch.js serve
  node scripts/sztu-switch.js status
  node scripts/sztu-switch.js start <service...>
  node scripts/sztu-switch.js stop <service...>
  node scripts/sztu-switch.js restart <service...>
  node scripts/sztu-switch.js autostart on <service...>
  node scripts/sztu-switch.js autostart off
  node scripts/sztu-switch.js autostart run
  node scripts/sztu-switch.js open

Services:
  ${listServices().map((service) => `${service.id} (${service.name})`).join(", ")}
`);
}

function openBrowser(url) {
  if (process.platform !== "win32") {
    return;
  }
  const child = spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function printStatus() {
  const dashboard = await buildDashboardState();
  const state = loadState();
  title("Switchboard status");
  line("Server", `${HOST}:${PORT}`);
  line("Autostart", state.autostart.enabled ? `on (${state.autostart.services.join(", ") || "none"})` : "off");
  line("Task", autostartSupported() ? (queryTask().installed ? "installed" : "missing") : "unsupported");
  line("Running", `${dashboard.summary.running}/${dashboard.summary.total}`);
  line("Healthy", `${dashboard.summary.healthy}/${dashboard.summary.total}`);
  for (const service of dashboard.services) {
    line(
      service.id,
      `${service.state}${service.pid ? ` pid=${service.pid}` : ""}${service.health?.status ? ` health=${service.health.status}` : ""}`
    );
  }
}

async function runCommand(argv) {
  const [command = "serve", subcommand, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }

  if (command === "serve") {
    startServer();
    console.log(`Switchboard listening at http://${HOST}:${PORT}`);
    return;
  }

  if (command === "open") {
    const url = `http://${HOST}:${PORT}`;
    openBrowser(url);
    console.log(url);
    return;
  }

  if (command === "status") {
    await printStatus();
    return;
  }

  if (command === "start" || command === "stop" || command === "restart") {
    const services = normalizeServiceIds([subcommand, ...rest].filter(Boolean));
    if (services.length === 0) {
      throw new Error("No valid services provided");
    }
    const result =
      command === "start" ? await startServices(services)
      : command === "stop" ? await stopServices(services)
      : await restartServices(services);
    console.log(JSON.stringify({ command, services: result }, null, 2));
    return;
  }

  if (command === "autostart") {
    if (subcommand === "on") {
      const services = normalizeServiceIds(rest);
      const state = setAutostartConfig(true, services);
      console.log(JSON.stringify({ ok: true, state, task: queryTask() }, null, 2));
      return;
    }
    if (subcommand === "off") {
      const state = setAutostartConfig(false, []);
      console.log(JSON.stringify({ ok: true, state, task: queryTask() }, null, 2));
      return;
    }
    if (subcommand === "run") {
      const result = await runAutostart();
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }

  printUsage();
}

module.exports = {
  printUsage,
  runCommand,
};
