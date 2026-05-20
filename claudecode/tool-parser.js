const fs = require("fs");

const COMMON_REQUIRED = {
  Read: ["file_path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  Bash: ["command"],
  Edit: ["file_path", "old_string", "new_string"],
  MultiEdit: ["file_path", "edits"],
  Write: ["file_path", "content"],
};

function parseToolCallText(text, allowedTools) {
  return parseToolCallDetailed(text, allowedTools).tool;
}

function parseToolCallDetailed(text, allowedTools) {
  const result = parseToolCallsDetailed(text, allowedTools);
  return {
    tool: result.tools[0] || null,
    candidates: result.candidates,
    rejected: result.rejected,
    reason: result.reason,
    matchedFormat: result.matchedFormat,
    rawInputKeys: result.rawInputKeys,
    strippedKeys: result.strippedKeys,
  };
}

function parseToolCallsDetailed(text, allowedTools) {
  if (typeof text !== "string" || !text.trim()) {
    return { tools: [], candidates: 0, rejected: [], reason: "empty" };
  }

  const tools = normalizeAllowedTools(allowedTools);
  const normalized = normalizeText(text);
  const searchable = removeCodeFences(normalized);
  const candidates = extractCandidates(searchable, tools);
  const rejected = [];
  const parsedResults = [];
  const acceptedRaw = [];

  for (const candidate of candidates) {
    if (acceptedRaw.some((raw) => raw.includes(candidate.raw) || candidate.raw.includes(raw))) {
      continue;
    }
    const parsedList = asArray(parseCandidate(candidate, tools));
    for (const parsed of parsedList) {
      const finalized = finalizeTool(parsed, tools);
      if (finalized) {
        parsedResults.push({ ...finalized, matchedFormat: candidate.format });
        acceptedRaw.push(candidate.raw);
        continue;
      }
      rejected.push({
        format: candidate.format,
        name: parsed?.name,
        inputKeys: parsed?.input && typeof parsed.input === "object" ? Object.keys(parsed.input) : [],
      });
    }
  }

  if (parsedResults.length > 0) {
    const first = parsedResults[0];
    return {
      tools: parsedResults.map((result) => result.tool),
      candidates: candidates.length,
      rejected,
      matchedFormat: first.matchedFormat,
      rawInputKeys: first.rawInputKeys,
      strippedKeys: first.strippedKeys,
    };
  }

  return {
    tools: [],
    candidates: candidates.length,
    rejected,
    reason: candidates.length ? "no-valid-candidate" : "no-candidate",
  };
}

function extractCandidates(text, tools) {
  return [
    ...extractDeepSeekTagCandidates(text),
    ...extractToolUseCandidates(text),
    ...extractInvokeCandidates(text),
    ...extractUnnamedParameterCandidates(text),
    ...extractToolCallsInlineCandidates(text, tools),
    ...extractNamedXmlCandidates(text),
    ...extractToolXmlCandidates(text),
    ...extractArgKeyCandidates(text),
    ...extractToolCallBlockCandidates(text, tools),
    ...extractToolArgumentsCandidates(text),
    ...extractToolColonJsonCandidates(text, tools),
    ...extractJsonCandidates(text),
    ...extractFunctionCandidates(text, tools),
    ...extractPlainKeyValueCandidates(text, tools),
  ];
}

function extractDeepSeekTagCandidates(text) {
  const candidates = [];
  const callRe =
    /<\|(?:redacted_)?tool_call_begin\|>\s*([A-Za-z0-9_-]+)\s*(?:<\|(?:redacted_)?tool_sep\|>|\n)\s*([\s\S]*?)(?=<\|(?:redacted_)?tool_call_end\|>|<\|(?:redacted_)?tool_call_begin\|>|<\|(?:redacted_)?tool_calls_end\|>|<\/think>|$)/gi;
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "deepseek-tags", name: match[1], inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractToolUseCandidates(text) {
  const candidates = [];
  const callRe = /<tool-use\s+name=["']?([A-Za-z0-9_-]+)["']?\s*>([\s\S]*?)(?=<\/tool-use>|<tool-use\b|$)/gi;
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "tool-use-xml", name: match[1], inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractInvokeCandidates(text) {
  const candidates = [];
  const callRe = /<invoke\s+name=["']?([A-Za-z0-9_-]+)["']?[^>]*>\s*([\s\S]*?)(?=<\/invoke>|<\/tool[-_]call>|<\/tool>|<invoke\b|$)/gi;
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "invoke-xml", name: match[1], inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractUnnamedParameterCandidates(text) {
  const candidates = [];
  const callRe = /<tool[-_]call>\s*([\s\S]*?)(?=<\/tool[-_]call>|<\/tool>|<tool[-_]call>|$)/gi;
  for (const match of text.matchAll(callRe)) {
    if (/<parameter\b/i.test(match[1]) && !/<invoke\b/i.test(match[1])) {
      candidates.push({ format: "unnamed-parameter-xml", inputText: match[1], raw: match[0] });
    }
  }
  return candidates;
}

function extractToolCallsInlineCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const useRe = new RegExp(`<tool_use\\b[^>]*>\\s*(${names})\\s*:\\s*([\\s\\S]*?)\\s*<\\/tool_use>`, "gi");
  for (const match of text.matchAll(useRe)) {
    candidates.push({
      format: "tool-calls-inline",
      name: canonicalToolName(match[1], tools),
      inputText: match[2],
      raw: match[0],
    });
  }
  return candidates;
}

function extractNamedXmlCandidates(text) {
  const candidates = [];
  const callRe = /<tool[-_]call\s+name=["']?([A-Za-z0-9_-]+)["']?[^>]*>\s*([\s\S]*?)(?=<\/tool[-_]call>|<\/think>|<tool[-_]call\b|$)/gi;
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "named-xml", name: match[1], inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractToolXmlCandidates(text) {
  const candidates = [];
  const callRe = /<tool\s+name=["']?([A-Za-z0-9_-]+)["']?>\s*([\s\S]*?)(?=<\/tool>|<\/think>|<tool\b|$)/gi;
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "parameter-xml", name: match[1], inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractArgKeyCandidates(text) {
  const candidates = [];
  const callRe = /<tool[-_]call>\s*([A-Za-z0-9_-]+)\s*([\s\S]*?)(?=<\/tool[-_]call>|<\/think>|<tool[-_]call>|$)/gi;
  for (const match of text.matchAll(callRe)) {
    if (/<arg_key\b/i.test(match[2])) {
      candidates.push({ format: "arg-key-xml", name: match[1], inputText: match[2], raw: match[0] });
    }
  }
  return candidates;
}

function extractToolCallBlockCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const callRe = new RegExp(`<tool[-_]call>\\s*(${names})\\s*([\\s\\S]*?)(?=<\\/tool[-_]call>|<\\/think>|<tool[-_]call>|$)`, "gi");
  for (const match of text.matchAll(callRe)) {
    if (!/<arg_key\b|<parameter\b/i.test(match[2])) {
      candidates.push({ format: "broken-tool-call", name: canonicalToolName(match[1], tools), inputText: match[2], raw: match[0] });
    }
  }
  return candidates;
}

function extractToolArgumentsCandidates(text) {
  const candidates = [];
  const callRe = /Tool:\s*([A-Za-z0-9_-]+)\s*(?:\n)+Arguments:\s*([\s\S]*?)(?=\n\s*Tool:\s*[A-Za-z0-9_-]+|<\/think>|$)/gi;
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "tool-arguments", name: match[1], inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractToolColonJsonCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const headerRe = new RegExp(`Tool:\\s*(${names})\\s+Tool:\\s*`, "gi");
  let match;
  while ((match = headerRe.exec(text)) !== null) {
    const jsonStart = match.index + match[0].length;
    if (text[jsonStart] !== "{") {
      continue;
    }
    const jsonText = extractFirstJsonObject(text.slice(jsonStart));
    if (!jsonText) {
      continue;
    }
    candidates.push({
      format: "tool-colon-json",
      name: canonicalToolName(match[1], tools),
      inputText: jsonText,
      raw: text.slice(match.index, jsonStart + jsonText.length),
    });
  }
  return candidates;
}

function extractJsonCandidates(text) {
  const candidates = [];
  const envelopeRe = /<\|?tool_calls?\|?>\s*([\s\S]*?)\s*(?:<\/\|?tool_calls?\|?>|<\/think>|$)|<tool[-_]call>\s*([\s\S]*?)\s*(?:<\/tool[-_]call>|<\/think>|$)/gi;
  for (const match of text.matchAll(envelopeRe)) {
    const inputText = match[1] || match[2] || "";
    if (inputText.includes("{")) {
      candidates.push({ format: "json-envelope", inputText, raw: match[0] });
    }
  }

  const jsonText = extractFirstJsonObject(text);
  if (jsonText) {
    candidates.push({ format: "json-object", inputText: jsonText, raw: jsonText });
  }
  return candidates;
}

function extractFunctionCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const callRe = new RegExp(`(?:^|\\n)\\s*(${names})\\s*\\(\\s*([\\s\\S]*?)\\s*\\)\\s*(?=\\n|$)`, "gi");
  for (const match of text.matchAll(callRe)) {
    candidates.push({ format: "function-call", name: canonicalToolName(match[1], tools), inputText: match[2], raw: match[0] });
  }
  return candidates;
}

function extractPlainKeyValueCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const nameLine = new RegExp(`^\\s*(${names})\\s*$`, "i");
  const colonLine = new RegExp(`^\\s*(${names})\\s*:\\s*([\\s\\S]+)$`, "i");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  if (lines.length >= 2 && nameLine.test(lines[0])) {
    const toolName = lines[0].match(nameLine)[1];
    const rest = lines.slice(1).join("\n");
    const repeated = rest.match(colonLine);
    candidates.push({
      format: "plain-key-value",
      name: canonicalToolName(toolName, tools),
      inputText: repeated ? repeated[2] : rest,
      raw: text,
    });
  }

  const oneLine =
    text.match(colonLine) ||
    text.match(new RegExp(`^\\s*(${names})\\s+([A-Za-z_][A-Za-z0-9_ -]*[:=][\\s\\S]+)$`, "i"));
  if (oneLine) {
    candidates.push({
      format: "plain-key-value",
      name: canonicalToolName(oneLine[1], tools),
      inputText: oneLine[2],
      raw: oneLine[0],
    });
  }
  return candidates;
}

function parseCandidate(candidate) {
  if (candidate.format === "json-envelope" || candidate.format === "json-object") {
    return parseJsonToolCandidate(candidate.inputText);
  }
  if (candidate.format === "tool-colon-json") {
    const parsed = parseLooseJson(candidate.inputText);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      name: candidate.name,
      input: parsed.input && typeof parsed.input === "object" ? parsed.input : parsed,
    };
  }
  if (candidate.format === "parameter-xml" || candidate.format === "tool-use-xml" || candidate.format === "invoke-xml") {
    return {
      name: candidate.name,
      input: parseParameterXml(candidate.inputText),
    };
  }
  if (candidate.format === "unnamed-parameter-xml") {
    const input = parseParameterXml(candidate.inputText);
    return {
      name: inferToolNameFromInput(input),
      input,
    };
  }
  if (candidate.format === "named-xml" || candidate.format === "broken-tool-call") {
    return {
      name: candidate.name,
      input: parseNamedXmlInput(candidate.inputText),
    };
  }
  if (candidate.format === "arg-key-xml") {
    return {
      name: candidate.name,
      input: parseArgKeyXml(candidate.inputText),
    };
  }
  if (candidate.format === "tool-calls-inline") {
    return {
      name: candidate.name,
      input: parseInlineToolBody(candidate.name, candidate.inputText),
    };
  }
  return {
    name: candidate.name,
    input: parseInputText(candidate.inputText),
  };
}

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseInlineToolBody(name, inputText) {
  const text = String(inputText || "").trim();
  if (!text) {
    return {};
  }
  const jsonText = extractFirstJsonObject(text);
  if (jsonText) {
    const parsed = parseLooseJson(jsonText);
    if (parsed && typeof parsed === "object") {
      return parsed.input && typeof parsed.input === "object" ? parsed.input : parsed;
    }
  }
  if (name === "Read" && !/[:=]/.test(text)) {
    return { file_path: text };
  }
  if (name === "Bash") {
    return { command: text };
  }
  if (name === "Glob" && !/[:=]/.test(text)) {
    return { pattern: text };
  }
  if (name === "Grep" && !/[:=]/.test(text)) {
    return { pattern: text };
  }
  return parseKeyValues(text);
}

function parseJsonToolCandidate(text) {
  const jsonText = extractFirstJsonValue(text);
  if (!jsonText) {
    return null;
  }
  const parsed = parseLooseJson(jsonText);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => {
        if (!item || typeof item.name !== "string") {
          return null;
        }
        return {
          name: item.name,
          input: item.input && typeof item.input === "object" ? item.input : {},
        };
      })
      .filter(Boolean);
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!item || typeof item.name !== "string") {
    return null;
  }
  return {
    name: item.name,
    input: item.input && typeof item.input === "object" ? item.input : {},
  };
}

function parseInputText(text) {
  const jsonText = extractFirstJsonObject(text);
  if (jsonText) {
    const parsed = parseLooseJson(jsonText);
    if (parsed && typeof parsed === "object") {
      return parsed.input && typeof parsed.input === "object" ? parsed.input : parsed;
    }
  }
  return parseKeyValues(text);
}

function parseParameterXml(text) {
  const input = {};
  const params = text.matchAll(/<parameter\b[^>]*\bname=["']?([^"'>\s]+)["']?[^>]*>\s*([\s\S]*?)\s*<\/parameter>/gi);
  for (const param of params) {
    input[param[1]] = decodeXmlEntities(param[2].trim());
  }
  return input;
}

function parseChildElementXml(text) {
  const input = {};
  const tags = text.matchAll(/<([A-Za-z_][A-Za-z0-9_-]*)\s*>\s*([\s\S]*?)\s*<\/\1\s*>/gi);
  for (const tag of tags) {
    input[tag[1]] = decodeXmlEntities(tag[2].trim());
  }
  return input;
}

function parseNamedXmlInput(text) {
  const source = String(text || "").trim();
  if (!source) {
    return {};
  }
  if (/<parameter\s+name=/i.test(source)) {
    return parseParameterXml(source);
  }
  if (source.includes("{")) {
    const input = parseInputText(source);
    if (Object.keys(input).length > 0) {
      return input;
    }
  }
  const childInput = parseChildElementXml(source);
  if (Object.keys(childInput).length > 0) {
    return childInput;
  }
  return parseInputText(source);
}

function parseArgKeyXml(text) {
  const input = {};
  const pairs = text.matchAll(/<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi);
  for (const pair of pairs) {
    input[pair[1].trim()] = pair[2].trim();
  }
  const malformedPairs = text.matchAll(/<arg_key>\s*([A-Za-z_][A-Za-z0-9_]*["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^<\n]+))\s*<\/arg_value>/gi);
  for (const pair of malformedPairs) {
    Object.assign(input, parseKeyValues(pair[1].replace(/^([A-Za-z_][A-Za-z0-9_]*)["']\s*:/, "$1:")));
  }
  return input;
}

function inferToolNameFromInput(input) {
  if (!input || typeof input !== "object") {
    return "";
  }
  if (input.command !== undefined) {
    return "Bash";
  }
  if (input.file_path !== undefined && input.content !== undefined) {
    return "Write";
  }
  if (input.file_path !== undefined && input.old_string !== undefined && input.new_string !== undefined) {
    return "Edit";
  }
  if (input.file_path !== undefined) {
    return "Read";
  }
  if (input.pattern !== undefined) {
    return "Glob";
  }
  return "";
}

function parseKeyValues(text) {
  const input = {};
  const source = String(text || "").trim();
  const pairRegex = /([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\n,]*)(?:\n|,|$)/g;
  let match;
  while ((match = pairRegex.exec(source))) {
    const raw = match[2].trim();
    const value = raw ? raw : readNextNonEmptyLine(source, pairRegex.lastIndex);
    input[match[1]] = unquote(value.trim());
  }
  return input;
}

function readNextNonEmptyLine(source, index) {
  const rest = source.slice(index).split("\n").map((line) => line.trim()).filter(Boolean);
  return rest[0] || "";
}

function finalizeTool(parsed, tools) {
  if (!parsed || typeof parsed.name !== "string") {
    return null;
  }

  let name = canonicalToolName(parsed.name, tools);
  let allowed = tools?.get(name.toLowerCase());
  if (tools && !allowed) {
    if (name === "Write" && tools.has("edit")) {
      name = canonicalToolName("Edit", tools);
      allowed = tools.get(name.toLowerCase());
    } else {
      return null;
    }
  }

  const input = parsed.input && typeof parsed.input === "object" ? { ...parsed.input } : {};
  if (name === "Edit" && input.content !== undefined && input.new_string === undefined) {
    input.new_string = input.content;
    if (input.old_string === undefined) {
      input.old_string = existingFileContent(input.file_path) ?? "";
    }
    delete input.content;
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      input[key] = normalizeInputValue(value);
    }
  }
  const rawInputKeys = Object.keys(input);
  const strippedKeys = [];
  const allowedProps = allowed?.properties;
  if (allowedProps && allowedProps.length > 0) {
    for (const key of Object.keys(input)) {
      if (!allowedProps.includes(key)) {
        strippedKeys.push(key);
        delete input[key];
      }
    }
  }
  if (name === "Edit" && input.old_string === "" && typeof input.new_string === "string" && input.file_path) {
    const writeName = canonicalToolName("Write", tools);
    const writeAllowed = !tools || tools.has(writeName.toLowerCase());
    if (writeAllowed) {
      return {
        tool: {
          type: "tool_use",
          id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          name: writeName,
          input: {
            file_path: input.file_path,
            content: input.new_string,
          },
        },
        rawInputKeys,
        strippedKeys,
      };
    }
    input.old_string = existingFileContent(input.file_path) ?? input.old_string;
  }
  const required = allowed?.required || COMMON_REQUIRED[name] || [];
  if (required.some((key) => input[key] === undefined || (input[key] === "" && !(name === "Edit" && key === "old_string")))) {
    return null;
  }
  if (name === "Bash" && typeof input.command === "string" && hasUnbalancedQuotes(input.command)) {
    return null;
  }

  return {
    tool: {
      type: "tool_use",
      id: `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      input,
    },
    rawInputKeys,
    strippedKeys,
  };
}

function parseToolCallsText(text, allowedTools) {
  return parseToolCallsDetailed(text, allowedTools).tools;
}

function existingFileContent(filePath) {
  if (typeof filePath !== "string" || !filePath) {
    return null;
  }
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch {}
  return null;
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeAllowedTools(allowedTools) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
    return null;
  }

  const map = new Map();
  for (const tool of allowedTools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    map.set(tool.name.toLowerCase(), {
      name: tool.name,
      required: schemaRequired(tool.input_schema) || COMMON_REQUIRED[tool.name] || [],
      properties: schemaProperties(tool.input_schema),
    });
  }
  return map.size > 0 ? map : null;
}

function schemaRequired(schema) {
  return Array.isArray(schema?.required) ? schema.required.filter((key) => typeof key === "string") : null;
}

function schemaProperties(schema) {
  if (!schema?.properties || typeof schema.properties !== "object") {
    return null;
  }
  return Object.keys(schema.properties).filter((key) => typeof key === "string");
}

function normalizeText(text) {
  return text
    .replace(/\uFF5C/g, "|")
    .replace(/\uFF1C/g, "<")
    .replace(/\uFF1E/g, ">")
    .replace(/\u2581/g, "_")
    .replace(/\r\n/g, "\n")
    .trim();
}

function removeCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, "\n");
}

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Truncated model output often leaves a lone opening quote; keep the command body.
  if (
    (trimmed.startsWith('"') && !trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && !trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1);
  }
  return trimmed;
}

function hasUnbalancedQuotes(value) {
  const text = String(value || "");
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }
  }
  return inSingle || inDouble;
}

function normalizeInputValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  return unquote(value);
}

function canonicalToolName(name, tools) {
  const raw = String(name || "");
  return tools?.get(raw.toLowerCase())?.name || raw;
}

function toolNamesPattern(tools) {
  const names = tools ? [...tools.values()].map((tool) => tool.name) : Object.keys(COMMON_REQUIRED);
  return names.map(escapeRegExp).join("|");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  try {
    const repaired = text
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/\\(u(?![0-9a-fA-F]{4})|[^"\\/bfnrtu])/g, (match) => `\\\\${match.slice(1)}`);
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text) {
  const value = extractFirstJsonValue(text);
  return value && value.startsWith("{") ? value : null;
}

function extractFirstJsonValue(text) {
  if (typeof text !== "string") {
    return null;
  }
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  let start = -1;
  if (objectStart >= 0 && arrayStart >= 0) {
    start = Math.min(objectStart, arrayStart);
  } else {
    start = Math.max(objectStart, arrayStart);
  }
  if (start < 0) {
    return null;
  }
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

module.exports = { parseToolCallDetailed, parseToolCallText, parseToolCallsDetailed, parseToolCallsText };
