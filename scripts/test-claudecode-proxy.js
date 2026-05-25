const assert = require("assert");
const {
  anthropicMessagesToOpenAI,
  anthropicToolsToPrompt,
  anthropicToolsToOpenAI,
  countAnthropicInputTokens,
  boundedToolParseText,
  buildUpstreamBody,
  buildUpstreamRequest,
  fallbackModelFor,
  hasToolExecutionHistory,
  hasUnsafeToolExecutionHistory,
  isRetryableFallbackStatus,
  isReadOnlyToolName,
  selectRelevantTools,
  shouldFallbackToModel,
  toAnthropicMessage,
  upstreamToolName,
  userIntentText,
} = require("../claudecode/claudecode-proxy");

const EXPECTED_PRIMARY_MODEL = process.env.SZTU_DEFAULT_MODEL || "glm-5.1";
const EXPECTED_FALLBACK_MODEL = String(process.env.CLAUDE_SZTU_FALLBACK_MODEL || "deepseek-v4-pro").trim();

function expectedFallbackFor(model) {
  return EXPECTED_FALLBACK_MODEL && EXPECTED_FALLBACK_MODEL !== model ? EXPECTED_FALLBACK_MODEL : "";
}

function expectedChatTemplateKwargs(model, thinking) {
  return model === "deepseek-v4-pro" ? { thinking } : { enable_thinking: thinking };
}

const tools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"].map((name) => ({
  name,
  description: `${name} tool`,
  input_schema: {
    type: "object",
    properties:
      name === "Bash"
        ? { command: { type: "string" } }
        : name === "Read"
          ? { file_path: { type: "string" } }
          : name === "Write"
            ? { file_path: { type: "string" }, content: { type: "string" } }
            : { pattern: { type: "string" } },
  },
}));

const autocodeTools = [
  ...tools,
  {
    name: "Skill",
    description: "Launch a skill",
    input_schema: {
      type: "object",
      properties: { skill: { type: "string" } },
      required: ["skill"],
    },
  },
  {
    name: "mcp__autocode__problem_create",
    description: "Create an AutoCode problem workspace",
    input_schema: {
      type: "object",
      properties: {
        problem_dir: { type: "string" },
        problem_name: { type: "string" },
        interactive: { type: "boolean" },
      },
      required: ["problem_dir", "problem_name"],
    },
  },
  {
    name: "mcp__autocode__generator_build",
    description: "Build an AutoCode generator",
    input_schema: {
      type: "object",
      properties: { problem_dir: { type: "string" } },
      required: ["problem_dir"],
    },
  },
];

const messages = [
  {
    role: "user",
    content: "Create a personal blog website with HTML, CSS, JavaScript, then preview it locally.",
  },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "total 0" }],
  },
];

const intent = userIntentText(messages);
assert(intent.includes("Create a personal blog website"), "intent should preserve the original user task");
assert(!intent.includes("total 0"), "intent should ignore tool result output");

const selected = selectRelevantTools(tools, messages).map((tool) => tool.name);
assert(selected.includes("Write"), "tool selection after tool_result should still include Write");
assert(selected.includes("Bash"), "tool selection after tool_result should still include Bash for preview tasks");

const autocodeSelected = selectRelevantTools(autocodeTools, [
  { role: "user", content: "用 AutoCode 创建一道竞赛题，先调用 mcp__autocode__problem_create。" },
]).map((tool) => tool.name);
assert(autocodeSelected.includes("mcp__autocode__problem_create"), "AutoCode intents should include autocode MCP tools");
assert(
  !autocodeSelected.includes("Skill"),
  "explicit autocode MCP tool requests should not be diluted by the Skill tool",
);
assert(
  !autocodeSelected.includes("mcp__autocode__generator_build"),
  "AutoCode intents with explicit tool names should not advertise unrelated MCP tools",
);

const pluginAutocodeTools = autocodeTools.map((tool) =>
  tool.name.startsWith("mcp__autocode__")
    ? { ...tool, name: tool.name.replace("mcp__autocode__", "mcp__plugin_autocode_autocode__") }
    : tool,
);
const pluginAutocodeSelected = selectRelevantTools(pluginAutocodeTools, [
  { role: "user", content: "用 AutoCode 创建一道竞赛题，先调用 mcp__autocode__problem_create。" },
]).map((tool) => tool.name);
assert(
  pluginAutocodeSelected.includes("mcp__plugin_autocode_autocode__problem_create"),
  "explicit short AutoCode MCP names should select plugin-scoped Claude Code tools",
);
assert(
  !pluginAutocodeSelected.includes("mcp__plugin_autocode_autocode__generator_build"),
  "explicit short AutoCode MCP names should not select unrelated plugin-scoped tools",
);

const autocodeWorkflowSelected = selectRelevantTools(autocodeTools, [
  { role: "user", content: "用 AutoCode 完整走一遍出题流程。" },
]).map((tool) => tool.name);
assert(
  autocodeWorkflowSelected.includes("Skill"),
  "broad AutoCode workflow prompts should still expose the Skill tool",
);
assert(
  autocodeWorkflowSelected.includes("mcp__autocode__problem_create"),
  "broad AutoCode workflow prompts should still expose AutoCode MCP tools",
);

const prompt = anthropicToolsToPrompt(tools, messages);
assert(prompt.includes("- Write:"), "tool prompt should still advertise Write after a tool_result");
assert(prompt.includes("- Bash:"), "tool prompt should still advertise Bash after a tool_result");

const nativeUpstream = buildUpstreamBody({
  tools,
  messages: [{ role: "user", content: "请使用 Read 工具读取 CLAUDE.md。只发工具调用。" }],
  max_tokens: 512,
}, { toolMode: "native" });
assert(nativeUpstream.tools, "native mode should forward OpenAI tools upstream");
assert.strictEqual(nativeUpstream.tool_choice, "auto", "native mode should use OpenAI auto tool choice");
assert(
  !nativeUpstream.messages.some((message) => String(message.content || "").includes("<tool_call>")),
  "native mode should not inject prompt-mediated XML tool instructions",
);

const promptUpstream = buildUpstreamBody({
  tools,
  messages: [{ role: "user", content: "请使用 Read 工具读取 CLAUDE.md。只发工具调用。" }],
  max_tokens: 512,
}, { toolMode: "prompt" });
assert(!promptUpstream.tools, "prompt mode should not forward OpenAI tools upstream");
assert(
  promptUpstream.messages.some((message) => String(message.content || "").includes("<tool_call>")),
  "prompt mode should keep XML tool instructions for parser fallback",
);

const upstreamThinkingBody = buildUpstreamBody({
  model: "claude-3-5-haiku-latest",
  messages: [{ role: "user", content: "请只回复 OK" }],
  max_tokens: 128,
});
assert.strictEqual(upstreamThinkingBody.model, EXPECTED_PRIMARY_MODEL, "Claude Code proxy should use the configured default engineering model");
assert.deepStrictEqual(
  upstreamThinkingBody.chat_template_kwargs,
  expectedChatTemplateKwargs(EXPECTED_PRIMARY_MODEL, true),
  "upstream should receive the configured model's thinking template kwargs",
);
assert.strictEqual(
  upstreamThinkingBody.max_tokens,
  10000,
  "thinking requests should get enough upstream token budget for reasoning plus answer text",
);
assert.strictEqual(fallbackModelFor(upstreamThinkingBody), expectedFallbackFor(EXPECTED_PRIMARY_MODEL), "Claude Code fallback model should follow configuration");
assert.strictEqual(shouldFallbackToModel({ messages: [{ role: "user", content: "hello" }] }, upstreamThinkingBody), Boolean(expectedFallbackFor(EXPECTED_PRIMARY_MODEL)), "fresh user requests may fall back when a distinct fallback is configured");
assert.strictEqual(shouldFallbackToModel({ messages }, upstreamThinkingBody), false, "unsafe prior tool execution should not switch fallback models");
assert.strictEqual(hasToolExecutionHistory({ messages }), true, "tool_use/tool_result history should count as tool execution history");
assert.strictEqual(hasUnsafeToolExecutionHistory({ messages }), true, "Bash tool history should block mid-loop fallback");
const readOnlyMessages = [
  { role: "user", content: "read README" },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "mcp__plugin_autocode_autocode__file_read", input: { path: "README.md" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "README content" }] },
];
assert.strictEqual(isReadOnlyToolName("mcp__plugin_autocode_autocode__file_read"), true, "MCP file_read should count as read-only fallback-safe history");
assert.strictEqual(hasUnsafeToolExecutionHistory({ messages: readOnlyMessages }), false, "read-only tool history should allow safe fallback");
assert.strictEqual(shouldFallbackToModel({ messages: readOnlyMessages }, upstreamThinkingBody), Boolean(expectedFallbackFor(EXPECTED_PRIMARY_MODEL)), "read-only tool history may fall back when a distinct fallback is configured");
assert.strictEqual(isRetryableFallbackStatus(502), true, "5xx upstream statuses should be fallback-eligible");
assert.strictEqual(isRetryableFallbackStatus(400), false, "schema/client errors should not be fallback-eligible");

const upstreamLargeThinkingBody = buildUpstreamBody({
  model: "claude-3-5-haiku-latest",
  messages: [{ role: "user", content: "请只回复 OK" }],
  max_tokens: 32000,
});
assert.strictEqual(upstreamLargeThinkingBody.max_tokens, 32000, "large thinking requests should preserve the requested upstream token budget");

const upstreamNoThinkingBody = buildUpstreamBody({
  model: "claude-3-5-haiku-latest",
  messages: [{ role: "user", content: "请只回复 OK" }],
  max_tokens: 128,
  thinking: { type: "disabled" },
});
assert.strictEqual(upstreamNoThinkingBody.max_tokens, 128, "disabled thinking should preserve the requested token budget");
assert.deepStrictEqual(upstreamNoThinkingBody.chat_template_kwargs, expectedChatTemplateKwargs(EXPECTED_PRIMARY_MODEL, false), "disabled thinking should map to the configured model template kwargs");
const fallbackThinkingBody = buildUpstreamBody({
  model: "claude-3-5-haiku-latest",
  messages: [{ role: "user", content: "请只回复 OK" }],
  max_tokens: 128,
}, { upstreamModel: "deepseek-v4-pro" });
assert.strictEqual(fallbackThinkingBody.model, "deepseek-v4-pro", "fallback request should target DeepSeek when requested");
assert.deepStrictEqual(fallbackThinkingBody.chat_template_kwargs, { thinking: true }, "DeepSeek fallback should receive thinking in chat_template_kwargs");
const upstreamMessages = anthropicMessagesToOpenAI({ tools, messages }, { toolMode: "native" });
assert(
  !upstreamMessages.some((message) => Array.isArray(message.tool_calls)),
  "default native mode should not send assistant tool_calls in history because SZTU rejects them",
);
const nativeTextToolResultMessage = upstreamMessages.find((message) => String(message.content || "").includes("Tool result:\ntotal 0"));
assert(nativeTextToolResultMessage, "default native mode should use SZTU-compatible text tool_result history");

const structuredUpstreamMessages = anthropicMessagesToOpenAI(
  { tools, messages },
  { toolMode: "native", toolHistoryMode: "structured" },
);
const assistantToolCallMessage = structuredUpstreamMessages.find((message) => Array.isArray(message.tool_calls));
assert(assistantToolCallMessage, "structured history mode should preserve assistant tool_use as OpenAI tool_calls");
assert.strictEqual(assistantToolCallMessage.tool_calls[0].function.name, "Bash", "structured history mode should preserve built-in tool name");
const structuredToolResultMessage = structuredUpstreamMessages.find((message) => message.role === "tool");
assert(structuredToolResultMessage, "structured history mode should forward tool_result as OpenAI tool role");
assert.strictEqual(structuredToolResultMessage.tool_call_id, "toolu_1", "structured tool result should preserve tool_call_id");
assert.strictEqual(structuredToolResultMessage.content, "total 0", "structured tool result content should be plain string");

const promptUpstreamMessages = anthropicMessagesToOpenAI({ tools, messages }, { toolMode: "prompt" });
const toolResultMessage = promptUpstreamMessages.find((message) => String(message.content || "").includes("Tool result:\ntotal 0"));
assert(toolResultMessage, "prompt mode should keep tool_result as user text");
assert(
  toolResultMessage.content.includes("request exactly one new tool call"),
  "prompt-mode tool result should allow follow-up tool calls",
);
assert(
  toolResultMessage.content.includes("Do not repeat the same tool call"),
  "tool result prompt should discourage repeated GLM tool calls",
);
assert(
  !toolResultMessage.content.includes("Answer the user's original request directly"),
  "prompt-mode tool result should not force a final answer",
);

const longThinking = `${"x".repeat(70000)}\n<tool_call name="Read"><file_path>README.md</file_path></tool_call>`;
const boundedLongThinking = boundedToolParseText(longThinking);
assert.strictEqual(boundedLongThinking.truncated, true, "long stream text should be bounded before tool parsing");
assert(
  boundedLongThinking.text.startsWith('<tool_call name="Read">'),
  "bounded stream parser input should keep the latest tool call marker",
);

const countTokens = countAnthropicInputTokens({
  system: "system prompt",
  messages: [{ role: "user", content: "hello" }],
  tools,
});
assert(countTokens > 0, "count token estimator should return a positive token count");

const longToolName = `mcp__very_long_server_name__${"x".repeat(80)}`;
const longTool = {
  name: longToolName,
  description: "Long MCP tool name",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const longToolRequest = buildUpstreamRequest({
  messages: [{ role: "user", content: "use long tool" }],
  tools: [longTool],
}, { toolMode: "native" });
assert.strictEqual(longToolRequest.toolHistoryMode, "text", "SZTU-compatible text tool history should be the default");
const shortenedName = longToolRequest.upstreamBody.tools[0].function.name;
assert.notStrictEqual(shortenedName, longToolName, "long tool names should be shortened for OpenAI-compatible providers");
assert(/^[A-Za-z0-9_-]{1,64}$/.test(shortenedName), "shortened tool name should satisfy OpenAI tool-name limits");
assert.strictEqual(
  upstreamToolName(longToolName, longToolRequest.toolNameMaps),
  shortenedName,
  "tool name mapping should be stable within one request",
);

const translatedLongTool = toAnthropicMessage(
  {
    id: "msg_long_tool",
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call_long",
              type: "function",
              function: { name: shortenedName, arguments: "{\"path\":\"README.md\"}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
  "deepseek-v4-pro",
  [longTool],
  "test_long_tool",
  { toolNameMaps: longToolRequest.toolNameMaps },
);
assert.strictEqual(translatedLongTool.content[0].name, longToolName, "OpenAI tool calls should restore original Claude tool name");
assert.deepStrictEqual(translatedLongTool.content[0].input, { path: "README.md" }, "OpenAI tool arguments should parse as tool input");

const strictTools = anthropicToolsToOpenAI([{
  name: "Read",
  description: "Read file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "path", extra: true } },
    required: ["file_path"],
    unsupported: true,
  },
}], { strict: true });
assert.strictEqual(strictTools[0].function.strict, true, "strict mode should mark function tools strict");
assert.strictEqual(strictTools[0].function.parameters.additionalProperties, false, "strict object schema should forbid extra fields");
assert.strictEqual(strictTools[0].function.parameters.unsupported, undefined, "strict schema should drop unsupported top-level fields");

const multiToolMessage = toAnthropicMessage(
  {
    id: "msg_multi",
    choices: [
      {
        message: {
          content:
            '<tool_call name="Read"><file_path>README.md</file_path></tool_call><tool_call name="Bash"><command>node --version</command></tool_call>',
        },
        finish_reason: "stop",
      },
    ],
  },
  "deepseek-v4-pro",
  tools,
  "test_multi",
);
assert.strictEqual(multiToolMessage.stop_reason, "tool_use", "multi parsed tool calls should stop as tool_use");
assert.deepStrictEqual(
  multiToolMessage.content.map((part) => part.name),
  ["Read", "Bash"],
  "non-stream proxy conversion should preserve multiple parsed tool calls",
);
assert.deepStrictEqual(
  multiToolMessage.content.map((part) => part.input),
  [{ file_path: "README.md" }, { command: "node --version" }],
  "non-stream proxy conversion should preserve each tool input",
);

console.log("claudecode proxy helper tests ok");
