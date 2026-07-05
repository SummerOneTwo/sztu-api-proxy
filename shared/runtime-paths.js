const path = require("path");

function runtimeDir(serviceDir) {
  return path.join(serviceDir, ".runtime");
}

function eventsDir(serviceDir) {
  return path.join(runtimeDir(serviceDir), "events");
}

function payloadsRoot(serviceDir) {
  return path.join(runtimeDir(serviceDir), "payloads");
}

function streamsDir(serviceDir) {
  return path.join(runtimeDir(serviceDir), "streams");
}

function fixturesDir(serviceDir) {
  return path.join(runtimeDir(serviceDir), "fixtures");
}

function eventsPath(serviceDir, dateKey) {
  return path.join(eventsDir(serviceDir), `${dateKey}.jsonl`);
}

function payloadDir(serviceDir, requestId) {
  return path.join(payloadsRoot(serviceDir), requestId);
}

function payloadFile(serviceDir, requestId, name) {
  return path.join(payloadDir(serviceDir, requestId), name);
}

function streamPath(serviceDir, requestId) {
  return path.join(streamsDir(serviceDir), `${requestId}.sse`);
}

function pidPath(serviceDir, baseName) {
  return path.join(runtimeDir(serviceDir), `${baseName}.pid`);
}

function ensureRuntimeLayout(serviceDir) {
  const dirs = [
    runtimeDir(serviceDir),
    eventsDir(serviceDir),
    payloadsRoot(serviceDir),
    streamsDir(serviceDir),
    fixturesDir(serviceDir),
  ];
  for (const dir of dirs) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  ensureRuntimeLayout,
  eventsDir,
  eventsPath,
  fixturesDir,
  payloadDir,
  payloadFile,
  payloadsRoot,
  pidPath,
  runtimeDir,
  streamPath,
  streamsDir,
};
