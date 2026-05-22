const assert = require("assert");
const {
  anthropicMessagesToOpenAI,
  anthropicToolsToPrompt,
  countAnthropicInputTokens,
  boundedToolParseText,
  buildUpstreamBody,
  selectRelevantTools,
  toAnthropicMessage,
  userIntentText,
} = require("../claudecode/claudecode-proxy");

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

const upstreamThinkingBody = buildUpstreamBody({
  model: "claude-3-5-haiku-latest",
  messages: [{ role: "user", content: "请只回复 OK" }],
  max_tokens: 128,
});
assert.strictEqual(upstreamThinkingBody.model, "deepseek-v4-pro", "Claude Code proxy should default to the currently healthy DeepSeek upstream");
assert.deepStrictEqual(
  upstreamThinkingBody.chat_template_kwargs,
  { thinking: true },
  "DeepSeek upstream should receive thinking in chat_template_kwargs",
);
assert.strictEqual(
  upstreamThinkingBody.max_tokens,
  10000,
  "thinking requests should get enough upstream token budget for reasoning plus answer text",
);

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
const upstreamMessages = anthropicMessagesToOpenAI({ tools, messages });
const toolResultMessage = upstreamMessages.find((message) => message.content.includes("Tool result:\ntotal 0"));
assert(toolResultMessage, "tool result should be forwarded into OpenAI history");
assert(
  toolResultMessage.content.includes("request exactly one tool call"),
  "tool result prompt should allow follow-up tool calls",
);
assert(
  !toolResultMessage.content.includes("Answer the user's original request directly"),
  "tool result prompt should not force a final answer",
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
