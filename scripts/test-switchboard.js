const assert = require("assert");
const path = require("path");
const { PROJECT_ROOT } = require("../shared/env");
const { listServices, normalizeServiceIds } = require("../switchboard/catalog");
const { buildLauncherText, isSupported, queryTask } = require("../switchboard/autostart");
const { isPublicFile } = require("../switchboard/server");
const { defaultState, normalizeState } = require("../switchboard/state");
const { parseEnvText } = require("../switchboard/env-config");

const services = listServices();
assert.strictEqual(services.length, 3, "switchboard should expose three proxy services");
assert.deepStrictEqual(
  normalizeServiceIds(["opencode", "invalid", "codebuddy", "opencode"]),
  ["opencode", "codebuddy"],
  "service id normalization should drop invalid ids and dedupe"
);

const state = normalizeState({
  autostart: {
    enabled: true,
    services: ["claudecode", "bogus", "codebuddy"],
  },
});
assert.deepStrictEqual(
  state.autostart.services,
  ["claudecode", "codebuddy"],
  "state normalization should keep valid autostart services only"
);

const launcher = buildLauncherText();
assert(launcher.includes("autostart-run"), "launcher should call autostart-run");
assert(launcher.includes("sztu-switch.js"), "launcher should invoke the switchboard script");

const defaults = defaultState();
assert.strictEqual(defaults.autostart.enabled, false, "default autostart should be off");
assert.deepStrictEqual(defaults.autostart.services, [], "default autostart should have no services");

const task = queryTask();
assert.strictEqual(typeof task.installed, "boolean", "task query should return an installed flag");
assert.strictEqual(typeof isSupported(), "boolean", "platform support check should be boolean");
assert.deepStrictEqual(
  parseEnvText("SZTU_API_KEY=abc\nSZTU_DEFAULT_MODEL=\"deepseek-v4-pro\"\n# ignored\n"),
  { SZTU_API_KEY: "abc", SZTU_DEFAULT_MODEL: "deepseek-v4-pro" },
  "env parser should parse simple .env values"
);
assert.strictEqual(
  isPublicFile(path.join(PROJECT_ROOT, "switchboard", "public", "index.html")),
  true,
  "static server should allow files inside public"
);
assert.strictEqual(
  isPublicFile(path.join(PROJECT_ROOT, "switchboard", "public2", "index.html")),
  false,
  "static server should reject sibling paths that only share the same prefix"
);

console.log("switchboard helper tests ok");
