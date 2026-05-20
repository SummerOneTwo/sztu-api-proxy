const fs = require("fs");
const { ENV_PATH } = require("../shared/env");

const ENV_FIELDS = [
  { key: "SZTU_API_KEY", label: "SZTU API Key", secret: true },
  { key: "SZTU_DEFAULT_MODEL", label: "默认模型" },
  { key: "SZTU_DEFAULT_MAX_TOKENS", label: "默认输出 Token" },
  { key: "SZTU_MAX_TOKENS", label: "最大输出 Token" },
  { key: "OPENCODE_PROXY_PORT", label: "OpenCode 端口" },
  { key: "CODEBUDDY_PROXY_PORT", label: "CodeBuddy 端口" },
  { key: "CLAUDE_SZTU_PROXY_PORT", label: "Claude Code 端口" },
  { key: "SZTU_SWITCHBOARD_PORT", label: "Switchboard 端口" },
];

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readEnvText() {
  try {
    return fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return "";
  }
}

function readEnvConfig() {
  const values = parseEnvText(readEnvText());
  return {
    path: ENV_PATH,
    fields: ENV_FIELDS.map((field) => ({
      ...field,
      value: values[field.key] || "",
      present: Object.prototype.hasOwnProperty.call(values, field.key),
    })),
  };
}

function serializeValue(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    return "";
  }
  if (/[\s#"'=]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function writeEnvConfig(values) {
  const allowed = new Set(ENV_FIELDS.map((field) => field.key));
  const nextValues = {};
  for (const [key, value] of Object.entries(values && typeof values === "object" ? values : {})) {
    if (allowed.has(key)) {
      nextValues[key] = String(value == null ? "" : value).trim();
    }
  }

  const lines = readEnvText().split(/\r?\n/);
  const seen = new Set();
  const output = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !allowed.has(match[2])) {
      return line;
    }
    const key = match[2];
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(nextValues, key)) {
      return line;
    }
    if (!nextValues[key]) {
      return null;
    }
    return `${key}=${serializeValue(nextValues[key])}`;
  }).filter((line) => line !== null);

  for (const field of ENV_FIELDS) {
    if (!seen.has(field.key) && Object.prototype.hasOwnProperty.call(nextValues, field.key) && nextValues[field.key]) {
      output.push(`${field.key}=${serializeValue(nextValues[field.key])}`);
    }
  }

  fs.writeFileSync(ENV_PATH, `${output.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
  for (const [key, value] of Object.entries(nextValues)) {
    process.env[key] = value;
  }
  return readEnvConfig();
}

module.exports = {
  ENV_FIELDS,
  parseEnvText,
  readEnvConfig,
  writeEnvConfig,
};
