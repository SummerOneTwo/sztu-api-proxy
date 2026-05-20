const assert = require("assert");
const {
  anthropicMessagesToOpenAI,
  anthropicToolsToPrompt,
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

const prompt = anthropicToolsToPrompt(tools, messages);
assert(prompt.includes("- Write:"), "tool prompt should still advertise Write after a tool_result");
assert(prompt.includes("- Bash:"), "tool prompt should still advertise Bash after a tool_result");

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
