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
  const searchable = /mcp__autocode__/i.test(normalized) ? normalized : removeCodeFences(normalized);
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
        parsedResults.push({ ...finalized, matchedFormat: candidate.format, rawLength: String(candidate.raw || "").length });
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
    const selectedResults = selectBestParsedResults(parsedResults);
    const first = selectedResults[0];
    return {
      tools: selectedResults.map((result) => result.tool),
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

function selectBestParsedResults(parsedResults) {
  if (parsedResults.length <= 1) {
    return parsedResults;
  }
  const firstName = parsedResults[0].tool?.name;
  if (!firstName || parsedResults.some((result) => result.tool?.name !== firstName)) {
    return parsedResults;
  }
  if (!autocodeToolSuffix(firstName)) {
    return parsedResults;
  }
  if (autocodeToolSuffix(firstName) !== "file_save") {
    return [parsedResults[0]];
  }
  return [
    parsedResults.reduce((best, current) =>
      parsedResultScore(current) > parsedResultScore(best) ? current : best,
    ),
  ];
}

function parsedResultScore(result) {
  const input = result.tool?.input && typeof result.tool.input === "object" ? result.tool.input : {};
  const stringBytes = Object.values(input).reduce((sum, value) => {
    if (typeof value === "string") {
      return sum + value.length;
    }
    return sum;
  }, 0);
  return Object.keys(input).length * 100000 + stringBytes * 10 + (result.rawLength || 0);
}

function extractCandidates(text, tools) {
  return [
    ...extractDeepSeekTagCandidates(text),
    ...extractCallingJsonCandidates(text, tools),
    ...extractToolUseCandidates(text),
    ...extractInvokeCandidates(text),
    ...extractUnnamedParameterCandidates(text),
    ...extractToolCallsInlineCandidates(text, tools),
    ...extractNamedXmlCandidates(text),
    ...extractToolXmlCandidates(text),
    ...extractMalformedNestedArgCandidates(text, tools),
    ...extractArgKeyCandidates(text),
    ...extractToolCallBlockCandidates(text, tools),
    ...extractToolArgumentsCandidates(text),
    ...extractToolColonJsonCandidates(text, tools),
    ...extractJsonCandidates(text),
    ...extractFunctionCandidates(text, tools),
    ...extractPlainKeyValueCandidates(text, tools),
  ];
}

function extractCallingJsonCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const headerRe = new RegExp(`(?:^|\\n)\\s*(?:\\*{1,2})?(?:calling|call|调用)\\s*:?(?:\\*{1,2})?\\s*\`?(${names})\`?`, "gi");
  let match;
  while ((match = headerRe.exec(text)) !== null) {
    const rest = text.slice(headerRe.lastIndex, headerRe.lastIndex + 12000);
    const fenced = rest.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const inputText = fenced ? fenced[1] : extractFirstJsonObject(rest);
    if (!inputText) {
      continue;
    }
    candidates.push({
      format: "calling-json",
      name: canonicalToolName(match[1], tools),
      inputText,
      raw: text.slice(match.index, headerRe.lastIndex + rest.indexOf(inputText) + inputText.length),
    });
  }
  return candidates;
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
    const named = parseNameParameterXml(candidate.inputText);
    if (named) {
      return named;
    }
    const input = parseParameterXml(candidate.inputText);
    return {
      name: inferToolNameFromInput(input),
      input,
    };
  }
  if (candidate.format === "named-xml" || candidate.format === "broken-tool-call") {
    return {
      name: candidate.name,
      input:
        candidate.name === "mcp__autocode__file_save"
          ? parseFileSaveInput(candidate.inputText)
          : parseNamedXmlInput(candidate.inputText),
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
      .map(parseJsonToolItem)
      .filter(Boolean);
  }
  return parseJsonToolItem(parsed);
}

function parseJsonToolItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const functionCall = item.function && typeof item.function === "object" ? item.function : null;
  const name =
    typeof item.name === "string"
      ? item.name
      : typeof item.tool === "string"
        ? item.tool
        : typeof functionCall?.name === "string"
          ? functionCall.name
          : null;
  if (!name) {
    return null;
  }
  const rawInput =
    item.input && typeof item.input === "object"
      ? item.input
      : item.arguments !== undefined
        ? item.arguments
        : item.args !== undefined
          ? item.args
          : functionCall?.arguments;
  let input = {};
  if (rawInput && typeof rawInput === "object") {
    input = rawInput;
  } else if (typeof rawInput === "string") {
    const parsedInput = parseLooseJson(rawInput);
    if (parsedInput && typeof parsedInput === "object") {
      input = parsedInput;
    }
  }
  return { name, input };
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
  const source = String(text || "");
  const openRe = /<(parameter|param)\b/gi;
  let match;
  while ((match = openRe.exec(source)) !== null) {
    const tagName = match[1].toLowerCase();
    const tagEnd = findXmlTagEnd(source, openRe.lastIndex);
    if (tagEnd < 0) {
      break;
    }

    const rawAttrs = source.slice(openRe.lastIndex, tagEnd);
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const attrs = selfClosing ? rawAttrs.replace(/\/\s*$/, "") : rawAttrs;
    const name = xmlAttribute(attrs, "name");
    const attrValue = xmlAttribute(attrs, "value") ?? xmlAttribute(attrs, "content");
    if (!name) {
      openRe.lastIndex = tagEnd + 1;
      continue;
    }

    if (selfClosing) {
      if (attrValue !== null) {
        input[name] = decodeXmlEntities(attrValue.trim());
      }
      openRe.lastIndex = tagEnd + 1;
      continue;
    }

    const closeRe = new RegExp(`</${tagName}\\s*>`, "ig");
    closeRe.lastIndex = tagEnd + 1;
    const close = closeRe.exec(source);
    if (!close) {
      if (attrValue !== null) {
        input[name] = decodeXmlEntities(attrValue.trim());
      }
      openRe.lastIndex = tagEnd + 1;
      continue;
    }

    const bodyValue = source.slice(tagEnd + 1, close.index).trim();
    const chosen = chooseParameterValue(name, attrValue, bodyValue);
    if (chosen !== null) {
      input[name] = decodeXmlEntities(chosen.trim());
    }
    if (attrValue !== null && /<(?:parameter|param)\b/i.test(bodyValue)) {
      openRe.lastIndex = tagEnd + 1;
    } else {
      openRe.lastIndex = close.index + close[0].length;
    }
  }
  const broken = parseBrokenParameterXml(source);
  for (const [key, value] of Object.entries(broken)) {
    if (input[key] === undefined || shouldPreferBrokenParameterValue(key, input[key], value)) {
      input[key] = value;
    }
  }
  return input;
}

function shouldPreferBrokenParameterValue(key, current, repaired) {
  if (typeof current !== "string" || typeof repaired !== "string") {
    return false;
  }
  if (/<\/?(?:parameter|param|tool[-_]?call)\b/i.test(current)) {
    return true;
  }
  if (/^(problem_dir|problem_name|solution_type|source_path|path|file_path)$/.test(key)) {
    return !/[\r\n]/.test(repaired) && (/[\r\n]/.test(current) || current.length > repaired.length * 2);
  }
  return false;
}

function parseBrokenParameterXml(text) {
  const input = {};
  const source = String(text || "");
  const openRe = /<(parameter|param)\b/gi;
  let match;
  while ((match = openRe.exec(source)) !== null) {
    const tagStart = match.index;
    const nextOpen = findNextParamOpen(source, openRe.lastIndex);
    const close = source.indexOf(`</${match[1]}>`, openRe.lastIndex);
    const segmentEnd = minPositive(nextOpen, close, source.length);
    const segment = source.slice(tagStart, segmentEnd);
    const name = xmlAttribute(segment, "name");
    if (!name || input[name] !== undefined) {
      continue;
    }
    const value = extractBrokenParamAttributeFromSegment(segment);
    if (value !== null) {
      input[name] = value;
    }
  }
  return input;
}

function extractBrokenParamAttributeFromSegment(segment) {
  const attrRe = /\b(?:value|content)\s*=\s*(["'])/i;
  const attrMatch = attrRe.exec(segment);
  if (!attrMatch) {
    return null;
  }
  const valueStart = attrMatch.index + attrMatch[0].length;
  const valueEnd = findBrokenParamValueEnd(segment, valueStart, attrMatch[1]);
  if (valueEnd <= valueStart) {
    return null;
  }
  return decodeXmlEntities(segment.slice(valueStart, valueEnd).trim());
}

function findXmlTagEnd(source, start) {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
  }
  return -1;
}

function chooseParameterValue(name, attrValue, bodyValue) {
  const attr = attrValue === null ? null : String(attrValue);
  const body = String(bodyValue || "");
  if (attr === null) {
    return body;
  }
  if (!body.trim()) {
    return attr;
  }
  if (/<(?:parameter|param)\b/i.test(body)) {
    return attr;
  }
  if (name === "content") {
    return body.length > attr.length ? body : attr;
  }
  return body || attr;
}

function xmlAttribute(attrs, name) {
  const quoted = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(attrs);
  if (quoted) {
    return quoted[2];
  }
  const bare = new RegExp(`\\b${escapeRegExp(name)}=([^\\s>]+)`, "i").exec(attrs);
  return bare ? bare[1] : null;
}

function extractMalformedNestedArgCandidates(text, tools) {
  const candidates = [];
  const names = toolNamesPattern(tools);
  const callRe = new RegExp(`<tool[-_]call>\\s*(${names})\\s*<tool[-_]call>([\\s\\S]*?)<\\/tool[-_]call>`, "gi");
  for (const match of text.matchAll(callRe)) {
    if (/<arg_key\b|<\/arg_key>\s*[\s\S]*?<arg_value\b/i.test(match[2])) {
      candidates.push({ format: "arg-key-xml", name: canonicalToolName(match[1], tools), inputText: match[2], raw: match[0] });
    }
  }
  return candidates;
}

function parseNameParameterXml(text) {
  const name = String(text || "").match(/<name>\s*([A-Za-z0-9_-]+)\s*<\/name>/i)?.[1];
  const parameterValues = parseNameParameterValuePairs(text);
  if (name && Object.keys(parameterValues).length > 0) {
    return {
      name,
      input: parameterValues,
    };
  }
  const parameter = String(text || "").match(/<parameter(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/parameter>/i)?.[1];
  if (!name || !parameter) {
    return null;
  }
  const parsed = parseInputText(decodeXmlEntities(parameter.trim()));
  return {
    name,
    input: parsed && typeof parsed === "object" ? parsed : {},
  };
}

function parseNameParameterValuePairs(text) {
  const input = {};
  const source = String(text || "");
  const pairRe = /<parameter>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<\/parameter>\s*<value>\s*([\s\S]*?)\s*<\/value>/gi;
  for (const pair of source.matchAll(pairRe)) {
    input[pair[1]] = decodeXmlEntities(pair[2].trim());
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
  if (/<(?:parameter|param)\s+name=/i.test(source)) {
    return parseParameterXml(source);
  }
  if (source.includes("{")) {
    const input = parseInputText(source);
    if (Object.keys(input).length > 0) {
      return input;
    }
  }
  const childInput = parseChildElementXml(source);
  if (Object.keys(childInput).length === 1 && typeof childInput.input === "string" && /<\s*[A-Za-z_][A-Za-z0-9_-]*\b/i.test(childInput.input)) {
    const unwrapped = parseNamedXmlInput(childInput.input);
    if (Object.keys(unwrapped).length > 0) {
      return unwrapped;
    }
  }
  if (Object.keys(childInput).length > 0) {
    return childInput;
  }
  return parseInputText(source);
}

function parseFileSaveInput(text) {
  const parsed = parseNamedXmlInput(text);
  const attrRepaired = parseSelfClosingFileSaveInput(text, parsed);
  const brokenAttrRepaired = parseBrokenFileSaveParameterInput(text);
  const repaired = parseJsonishFileSaveInput(text);
  let best = parsed;
  for (const candidate of [attrRepaired, brokenAttrRepaired, repaired]) {
    if (!candidate) {
      continue;
    }
    const bestContentLength = typeof best.content === "string" ? best.content.length : 0;
    const candidateContentLength = typeof candidate.content === "string" ? candidate.content.length : 0;
    if (candidateContentLength > bestContentLength) {
      best = {
        ...candidate,
        problem_dir: usableFileSaveField(parsed.problem_dir) ? parsed.problem_dir : candidate.problem_dir,
        path: usableFileSaveField(parsed.path) ? parsed.path : candidate.path,
        content: candidate.content,
      };
    }
  }
  return best;
}

function usableFileSaveField(value) {
  return typeof value === "string" && value.trim() && !/[\r\n]/.test(value) && !/<\/?(?:parameter|param|tool[-_]?call)\b/i.test(value);
}

function parseSelfClosingFileSaveInput(text, parsed = {}) {
  const content = extractGreedySelfClosingParamAttribute(text, "content");
  if (content === null) {
    return null;
  }
  const problemDir = usableFileSaveField(parsed.problem_dir) ? parsed.problem_dir : extractGreedySelfClosingParamAttribute(text, "problem_dir");
  const path = usableFileSaveField(parsed.path) ? parsed.path : extractGreedySelfClosingParamAttribute(text, "path");
  if (!problemDir || !path) {
    return null;
  }
  return { problem_dir: problemDir, path, content };
}

function extractGreedySelfClosingParamAttribute(text, paramName) {
  const source = String(text || "");
  const nameRe = new RegExp(`\\bname\\s*=\\s*["']${escapeRegExp(paramName)}["']`, "gi");
  let nameMatch;
  while ((nameMatch = nameRe.exec(source)) !== null) {
    const tagStart = Math.max(
      source.lastIndexOf("<parameter", nameMatch.index),
      source.lastIndexOf("<param", nameMatch.index),
    );
    const previousClose = source.lastIndexOf("/>", nameMatch.index);
    if (tagStart < 0 || previousClose > tagStart) {
      continue;
    }
    const attrRe = /\b(?:value|content)\s*=\s*(["'])/gi;
    attrRe.lastIndex = tagStart;
    const attrMatch = attrRe.exec(source);
    if (!attrMatch) {
      continue;
    }
    const quote = attrMatch[1];
    const start = attrRe.lastIndex;
    const closeRe = new RegExp(`${escapeRegExp(quote)}\\s*\\/\\s*>`, "g");
    closeRe.lastIndex = start;
    const close = closeRe.exec(source);
    if (!close) {
      continue;
    }
    return decodeXmlEntities(source.slice(start, close.index).trim());
  }
  return null;
}

function parseBrokenFileSaveParameterInput(text) {
  const problemDir = extractBrokenParamAttribute(text, "problem_dir");
  const path = extractBrokenParamAttribute(text, "path");
  const content = extractBrokenParamAttribute(text, "content");
  if (!problemDir || !path || content === null) {
    return null;
  }
  return { problem_dir: problemDir, path, content };
}

function extractBrokenParamAttribute(text, paramName) {
  const source = String(text || "");
  const openRe = /<(parameter|param)\b/gi;
  let match;
  while ((match = openRe.exec(source)) !== null) {
    const tagStart = match.index;
    const nextOpen = findNextParamOpen(source, openRe.lastIndex);
    const toolClose = source.indexOf("</tool_call>", openRe.lastIndex);
    const segmentEnd = minPositive(nextOpen, toolClose, source.length);
    const segment = source.slice(tagStart, segmentEnd);
    const name = xmlAttribute(segment, "name");
    if (name !== paramName) {
      continue;
    }

    const attrRe = /\b(?:value|content)\s*=\s*(["'])/i;
    const attrMatch = attrRe.exec(segment);
    if (!attrMatch) {
      continue;
    }
    const valueStart = attrMatch.index + attrMatch[0].length;
    if (hasNormalOpeningTagEnd(segment, valueStart, attrMatch[1])) {
      continue;
    }
    const valueEnd = findBrokenParamValueEnd(segment, valueStart, attrMatch[1]);
    if (valueEnd <= valueStart) {
      continue;
    }
    return decodeXmlEntities(segment.slice(valueStart, valueEnd).trim());
  }
  return null;
}

function hasNormalOpeningTagEnd(segment, start, quote) {
  const normalEndRe = new RegExp(`${escapeRegExp(quote)}\\s*>`, "g");
  normalEndRe.lastIndex = start;
  const normalEnd = normalEndRe.exec(segment);
  if (!normalEnd) {
    return false;
  }
  const closeTag = segment.slice(start).search(/<\/(?:parameter|param)\s*>/i);
  return closeTag < 0 || normalEnd.index < start + closeTag;
}

function findNextParamOpen(source, start) {
  const rest = source.slice(start);
  const match = /<(?:parameter|param)\b/i.exec(rest);
  return match ? start + match.index : -1;
}

function findBrokenParamValueEnd(segment, start, quote) {
  const closeTag = segment.slice(start).search(/<\/(?:parameter|param)\s*>/i);
  if (closeTag >= 0) {
    return start + closeTag;
  }
  const selfClosingRe = new RegExp(`${escapeRegExp(quote)}\\s*\\/\\s*>`, "g");
  selfClosingRe.lastIndex = start;
  const selfClosing = selfClosingRe.exec(segment);
  if (selfClosing) {
    return selfClosing.index;
  }
  return segment.length;
}

function minPositive(...values) {
  return values.filter((value) => typeof value === "number" && value >= 0).reduce((best, value) => Math.min(best, value), Infinity);
}

function parseJsonishFileSaveInput(text) {
  const source = String(text || "");
  const problemDir = extractJsonishStringField(source, "problem_dir");
  const path = extractJsonishStringField(source, "path");
  const content = extractJsonishStringField(source, "content");
  if (!problemDir || !path || content === null) {
    return null;
  }
  return { problem_dir: problemDir, path, content };
}

function extractJsonishStringField(text, key) {
  const keyRe = new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']`, "i");
  const match = keyRe.exec(text);
  if (!match) {
    return null;
  }
  const start = match.index + match[0].length;
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
    if (char !== '"' && char !== "'") {
      continue;
    }
    const rest = text.slice(index + 1);
    if (/^\s*(?:,\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*:|[})])/.test(rest)) {
      return decodeJsonishString(text.slice(start, index));
    }
  }
  return decodeJsonishString(text.slice(start));
}

function decodeJsonishString(value) {
  return String(value || "")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function parseArgKeyXml(text) {
  const input = {};
  const source = repairArgKeyXml(text);
  const pairs = source.matchAll(/(?:<arg_key>|<tool[-_]call>|^)\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi);
  for (const pair of pairs) {
    input[pair[1].trim()] = pair[2].trim();
  }
  const barePairs = source.matchAll(
    /(?:<arg_key>|<tool[-_]call>|^)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<\/arg_key>)?\s*<arg_value>\s*([\s\S]*?)(?=<\/arg_value>\s*<arg_key>|<arg_key>|<tool[-_]call>\s*[A-Za-z_][A-Za-z0-9_]*\s*(?:<\/arg_key>)?\s*<arg_value>|<\/tool[-_]call>|$)/gi,
  );
  for (const pair of barePairs) {
    if (input[pair[1]] === undefined) {
      input[pair[1]] = pair[2].replace(/<\/arg_value>\s*$/i, "").trim();
    }
  }
  const malformedPairs = source.matchAll(/<arg_key>\s*([A-Za-z_][A-Za-z0-9_]*["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^<\n]+))\s*<\/arg_value>/gi);
  for (const pair of malformedPairs) {
    Object.assign(input, parseKeyValues(pair[1].replace(/^([A-Za-z_][A-Za-z0-9_]*)["']\s*:/, "$1:")));
  }
  return input;
}

function repairArgKeyXml(text) {
  return String(text || "")
    .replace(/<arg_value>([^<]*?)<tool[-_]call>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<\/arg_key>/gi, "<arg_value>$1</arg_value><arg_key>$2</arg_key>")
    .replace(/<tool[-_]call>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<\/arg_key>/gi, "<arg_key>$1</arg_key>")
    .replace(/<\/arg_value>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<\/arg_key>/gi, "</arg_value><arg_key>$1</arg_key>")
    .replace(/<tool[-_]call>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<arg_value>/gi, "<arg_key>$1</arg_key><arg_value>");
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

  const input = parsed.input && typeof parsed.input === "object" ? { ...parsed.input } : {};
  let name = canonicalToolName(parsed.name, tools);
  let allowed = tools?.get(name.toLowerCase());
  if (tools && !allowed) {
    if (name === "Write" && tools.has("edit")) {
      name = canonicalToolName("Edit", tools);
      allowed = tools.get(name.toLowerCase());
    } else if (name === "Read") {
      const fileReadTool = findAllowedAutocodeTool(tools, "file_read");
      if (!fileReadTool) {
        return null;
      }
      name = fileReadTool.name;
      allowed = fileReadTool;
      if (input.path === undefined && input.file_path !== undefined) {
        input.path = input.file_path;
      }
      delete input.file_path;
    } else {
      return null;
    }
  }

  if (name === "Edit" && input.content !== undefined && input.new_string === undefined) {
    input.new_string = input.content;
    if (input.old_string === undefined) {
      input.old_string = existingFileContent(input.file_path) ?? "";
    }
    delete input.content;
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      input[key] = normalizeInputValue(value, allowed?.propertyTypes?.[key], key);
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

function findAllowedAutocodeTool(tools, suffix) {
  if (!tools) {
    return null;
  }
  for (const tool of tools.values()) {
    if (autocodeToolSuffix(tool.name) === suffix) {
      return tool;
    }
  }
  return null;
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
      propertyTypes: schemaPropertyTypes(tool.input_schema),
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

function schemaPropertyTypes(schema) {
  if (!schema?.properties || typeof schema.properties !== "object") {
    return null;
  }
  const types = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (value && typeof value === "object" && typeof value.type === "string") {
      types[key] = value.type;
    }
  }
  return types;
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

function normalizeInputValue(value, expectedType, key = "") {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = unquote(value);
  if (expectedType === "object" || expectedType === "array") {
    const parsed = parseLooseJson(normalized);
    if (expectedType === "object" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    if (expectedType === "array" && Array.isArray(parsed)) {
      return parsed;
    }
  }
  if (expectedType === "boolean") {
    const boolText = normalized.replace(/<\/arg_value>\s*$/i, "").replace(/[)\]}]+$/g, "").trim().toLowerCase();
    if (boolText === "true") {
      return true;
    }
    if (boolText === "false") {
      return false;
    }
  }
  if (expectedType === "number" || expectedType === "integer") {
    const numberText = normalized.replace(/<\/arg_value>\s*$/i, "").replace(/[)\]}]+$/g, "").trim();
    if (/^-?\d+(?:\.\d+)?$/.test(numberText)) {
      const n = Number(numberText);
      if (Number.isFinite(n)) {
        return expectedType === "integer" ? Math.trunc(n) : n;
      }
    }
  }
  if (/^(problem_dir|problem_name|solution_type|source_path|path|file_path)$/.test(key)) {
    return normalized.replace(/<\/arg_value>\s*$/i, "").replace(/["']?\)+$/g, "").trim();
  }
  return normalized;
}

function canonicalToolName(name, tools) {
  const raw = String(name || "");
  const lower = raw.toLowerCase();
  const direct = tools?.get(lower)?.name;
  if (direct) {
    return direct;
  }
  const suffix = autocodeToolSuffix(lower);
  if (suffix && tools) {
    for (const tool of tools.values()) {
      if (autocodeToolSuffix(tool.name) === suffix) {
        return tool.name;
      }
    }
  }
  return raw;
}

function toolNamesPattern(tools) {
  const names = tools ? [...tools.values()].flatMap(toolNameAliases) : Object.keys(COMMON_REQUIRED);
  return names.map(escapeRegExp).join("|");
}

function toolNameAliases(tool) {
  const names = [tool.name];
  const suffix = autocodeToolSuffix(tool.name);
  if (suffix) {
    names.push(`mcp__autocode__${suffix}`);
    names.push(`mcp__plugin_autocode_autocode__${suffix}`);
  }
  return [...new Set(names)];
}

function autocodeToolSuffix(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("mcp__autocode__")) {
    return lower.slice("mcp__autocode__".length);
  }
  if (lower.startsWith("mcp__plugin_autocode_autocode__")) {
    return lower.slice("mcp__plugin_autocode_autocode__".length);
  }
  return "";
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
