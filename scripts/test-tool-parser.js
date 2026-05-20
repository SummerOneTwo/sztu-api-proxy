const assert = require("assert");
const path = require("path");
const { parseToolCallDetailed, parseToolCallText, parseToolCallsText } = require("../claudecode/tool-parser");

const tools = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
  },
  {
    name: "Bash",
    input_schema: {
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" } },
    },
  },
  {
    name: "Grep",
    input_schema: {
      type: "object",
      required: ["pattern"],
      properties: { pattern: { type: "string" }, path: { type: "string" } },
    },
  },
  {
    name: "Glob",
    input_schema: {
      type: "object",
      required: ["pattern"],
      properties: { pattern: { type: "string" }, path: { type: "string" } },
    },
  },
];

const winPath = String.raw`C:\userProgram\program\sztu-api-proxy\codebuddy\README.md`;

const cases = [
  {
    name: "requested xml json",
    text: `<tool_call>{"name":"Read","input":{"file_path":"${winPath.replace(/\\/g, "\\\\")}"}}</tool_call>`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "tool arguments block",
    text: `Tool: Read\nArguments: {"file_path":"${winPath.replace(/\\/g, "\\\\")}"}`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "named xml",
    text: `<tool_call name="Read">\n{"file_path":"${winPath.replace(/\\/g, "\\\\")}"}\n</tool_call>`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "parameter xml",
    text: `<tool name="Read"><parameter name="file_path">${winPath}</parameter></tool>`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "arg key value xml",
    text: `<tool_call>Read\n<arg_key>file_path</arg_key><arg_value>${winPath}</arg_value></tool_call>`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "claude ui read format",
    text: `Read\n\nRead: file_path: "${winPath}"`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "one line key value",
    text: `Read: file_path="${winPath}"`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "function call",
    text: `Read({"file_path":"${winPath.replace(/\\/g, "\\\\")}"})`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "bare command key value",
    text: `Bash command: "node --version"`,
    expect: { name: "Bash", input: { command: "node --version" } },
  },
  {
    name: "loose json repair",
    text: `<tool_call>{name:'Grep', input:{pattern:'TODO', path:'src',},}</tool_call>`,
    expect: { name: "Grep", input: { pattern: "TODO", path: "src" } },
  },
  {
    name: "unescaped windows path json repair",
    text: `<tool_call>{"name":"Read","input":{"file_path":"${winPath}"}}</tool_call>`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "broken repeated glob tool call with think tags",
    text: `<tool_call>Glob\npattern:\n**/proxy.js\n</think><tool_call>Glob\npattern:\n**/.env\n</think><tool_call>Glob\npattern:\n*/config\n</think>`,
    expect: { name: "Glob", input: { pattern: "**/proxy.js" } },
  },
  {
    name: "malformed arg key contains command pair",
    text: `<tool_call>Bash<arg_key>command": "git diff"</arg_value><arg_key>description": "Show working tree changes"</arg_value></tool_call>`,
    expect: { name: "Bash", input: { command: "git diff" } },
  },
  {
    name: "truncated bash command unclosed quote",
    text: 'Bash command: "ls -la c:/userProgram/program/sztu-api-proxy/',
    expect: { name: "Bash", input: { command: "ls -la c:/userProgram/program/sztu-api-proxy/" } },
  },
  {
    name: "truncated bash json unclosed quote",
    text: '<tool_call>{"name":"Bash","input":{"command":"\\"ls -la c:/userProgram/program/sztu-api-proxy/"}}</tool_call>',
    expect: { name: "Bash", input: { command: "ls -la c:/userProgram/program/sztu-api-proxy/" } },
  },
  {
    name: "deepseek tool tags",
    text: `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>Glob<｜tool▁sep｜>{"pattern":"**/proxy.js"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>`,
    expect: { name: "Glob", input: { pattern: "**/proxy.js" } },
  },
  {
    name: "json array first valid tool",
    text: `<tool_call>[{"name":"Glob","input":{"pattern":"**/*.js"}},{"name":"Read","input":{"file_path":"README.md"}}]</tool_call>`,
    expect: { name: "Glob", input: { pattern: "**/*.js" } },
  },
  {
    name: "deepseek tool-use bash",
    text: '让我先了解项目结构。 <tool-use name="Bash"> <parameter name="command">ls -la</parameter> </parameter> </tool-use>',
    expect: { name: "Bash", input: { command: "ls -la" } },
  },
  {
    name: "deepseek tool-use read",
    text: '<tool-use name="Read"><parameter name="file_path">README.md</parameter></tool-use>',
    expect: { name: "Read", input: { file_path: "README.md" } },
  },
  {
    name: "deepseek tool-call hyphen read with typed parameter",
    text: `<tool-call name="Read"> <parameter name="file_path" string="true">${winPath}</parameter> </parameter> </tool-call>`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "unnamed tool call inferred bash parameter",
    text: `<tool_call><parameter name="command">"node --version"</parameter><parameter name="description">Check Node</parameter></tool_call>`,
    expect: { name: "Bash", input: { command: "node --version" } },
  },
  {
    name: "deepseek tool colon json one line",
    text: `Tool: Read Tool: {"file_path": "${winPath.replace(/\\/g, "\\\\")}"}`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "deepseek tool colon json multiline",
    text: `Tool: Read\nTool: {"file_path": "${winPath.replace(/\\/g, "\\\\")}"}`,
    expect: { name: "Read", input: { file_path: winPath } },
  },
  {
    name: "deepseek tool colon json first of repeated",
    text: `Tool: Read Tool: {"file_path": "README.md"} Tool: Read Tool: {"file_path": "package.json"}`,
    expect: { name: "Read", input: { file_path: "README.md" } },
  },
  {
    name: "glob named xml strips unknown limit",
    text: '<tool_call name="Glob"> {"pattern": "**/*.js", "path": "src", "limit": 50} </tool_call>',
    expect: { name: "Glob", input: { pattern: "**/*.js", path: "src" } },
  },
  {
    name: "tool-calls inline read",
    text: '<tool-calls><tool_use id="x">Read: README.md</tool_use></tool-calls>',
    expect: { name: "Read", input: { file_path: "README.md" } },
  },
  {
    name: "tool-calls inline bash",
    text: "<tool-calls><tool_use id=\"x\">Bash: tree -L 2</tool_use><tool_use id=\"y\">Read: package.json</tool_use></tool-calls>",
    expect: { name: "Bash", input: { command: "tree -L 2" } },
  },
  {
    name: "named xml child elements read",
    text: '<tool_call name="Read"><file_path>README.md</file_path></tool_call>',
    expect: { name: "Read", input: { file_path: "README.md" } },
  },
  {
    name: "named xml child elements bash strips description",
    text: '<tool_call name="Bash"><command>find .</command><description>List files</description></tool_call>',
    expect: { name: "Bash", input: { command: "find ." } },
  },
  {
    name: "repeated named xml child elements first read",
    text: '<tool_call name="Read"><file_path>README.md</file_path></tool_call><tool_call name="Read"><file_path>CHANGELOG.md</file_path></tool_call>',
    expect: { name: "Read", input: { file_path: "README.md" } },
  },
];

for (const testCase of cases) {
  const parsed = parseToolCallText(testCase.text, tools);
  assert(parsed, `${testCase.name}: expected a parsed tool call`);
  assert.strictEqual(parsed.type, "tool_use", `${testCase.name}: type`);
  assert.strictEqual(parsed.name, testCase.expect.name, `${testCase.name}: name`);
  assert.deepStrictEqual(parsed.input, testCase.expect.input, `${testCase.name}: input`);
}

const editTools = [
  ...tools,
  {
    name: "Edit",
    input_schema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
    },
  },
  {
    name: "Write",
    input_schema: {
      type: "object",
      required: ["file_path", "content"],
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
];

const editAsCreate = parseToolCallText(
  `<tool_call name="Edit"> {"file_path":"demo-blog/new-index.html","old_string":"","new_string":"<!DOCTYPE html><html><head></head><body>Blog</body></html>"} </tool_call>`,
  editTools,
);
assert(editAsCreate, "edit named xml with html body: expected a parsed tool call");
assert.strictEqual(editAsCreate.name, "Write", "edit named xml with html body: should repair empty Edit to Write");
assert.deepStrictEqual(editAsCreate.input, {
  file_path: "demo-blog/new-index.html",
  content: "<!DOCTYPE html><html><head></head><body>Blog</body></html>",
});

const editOnlyTools = editTools.filter((tool) => tool.name !== "Write");
const writeAsEdit = parseToolCallText(
  `<tool_call name="Write"> {"file_path":"demo-blog/new-index.html","content":"<!DOCTYPE html><html><head></head><body>Blog</body></html>"} </tool_call>`,
  editOnlyTools,
);
assert(writeAsEdit, "write named xml with only Edit allowed: expected a parsed tool call");
assert.strictEqual(writeAsEdit.name, "Edit", "write named xml with only Edit allowed: should repair Write to Edit");
assert.deepStrictEqual(writeAsEdit.input, {
  file_path: "demo-blog/new-index.html",
  old_string: "",
  new_string: "<!DOCTYPE html><html><head></head><body>Blog</body></html>",
});

const existingReadmePath = path.resolve(__dirname, "..", "README.md");
const overwriteExistingAsEdit = parseToolCallText(
  `<tool_call name="Write"> {"file_path":${JSON.stringify(existingReadmePath)},"content":"# Replacement"} </tool_call>`,
  editOnlyTools,
);
assert(overwriteExistingAsEdit, "write existing file with only Edit allowed: expected a parsed tool call");
assert.strictEqual(overwriteExistingAsEdit.name, "Edit", "write existing file with only Edit allowed: should repair Write to Edit");
assert.strictEqual(overwriteExistingAsEdit.input.file_path, existingReadmePath);
assert.strictEqual(overwriteExistingAsEdit.input.new_string, "# Replacement");
assert(
  overwriteExistingAsEdit.input.old_string.includes("# SZTU API Proxy"),
  "write existing file with only Edit allowed: old_string should contain existing file contents",
);

const invokeWriteAsEdit = parseToolCallText(
  `<tool_call><invoke name="Write"><parameter name="file_path" string="true">demo-blog/new-index.html</parameter><parameter name="content" string="true">&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;Blog&lt;/body&gt;&lt;/html&gt;</parameter></invoke></tool>`,
  editOnlyTools,
);
assert(invokeWriteAsEdit, "invoke write with only Edit allowed: expected a parsed tool call");
assert.strictEqual(invokeWriteAsEdit.name, "Edit", "invoke write with only Edit allowed: should repair Write to Edit");
assert.deepStrictEqual(invokeWriteAsEdit.input, {
  file_path: "demo-blog/new-index.html",
  old_string: "",
  new_string: "<!DOCTYPE html><html><head></head><body>Blog</body></html>",
});

const repeatedNamedXmlTools = parseToolCallsText(
  '<tool_call name="Read"><file_path>README.md</file_path></tool_call><tool_call name="Read"><file_path>CHANGELOG.md</file_path></tool_call>',
  tools,
);
assert.strictEqual(repeatedNamedXmlTools.length, 2, "repeated named xml should parse both tool calls");
assert.deepStrictEqual(repeatedNamedXmlTools.map((tool) => tool.input.file_path), ["README.md", "CHANGELOG.md"]);

const inlineTools = parseToolCallsText(
  '<tool-calls><tool_use id="x">Bash: tree -L 2</tool_use><tool_use id="y">Read: package.json</tool_use></tool-calls>',
  tools,
);
assert.strictEqual(inlineTools.length, 2, "inline tool-calls should parse both tool calls");
assert.deepStrictEqual(inlineTools.map((tool) => tool.name), ["Bash", "Read"]);
assert.deepStrictEqual(inlineTools.map((tool) => tool.input), [{ command: "tree -L 2" }, { file_path: "package.json" }]);

const jsonArrayTools = parseToolCallsText(
  '<tool_call>[{"name":"Glob","input":{"pattern":"**/*.js"}},{"name":"Read","input":{"file_path":"README.md"}}]</tool_call>',
  tools,
);
assert.strictEqual(jsonArrayTools.length, 2, "json array should parse both tool calls");
assert.deepStrictEqual(jsonArrayTools.map((tool) => tool.name), ["Glob", "Read"]);

const bashWithDescriptionTools = [
  {
    name: "Bash",
    input_schema: {
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" }, description: { type: "string" } },
    },
  },
];
const bashWithDescription = parseToolCallText(
  '<tool_call name="Bash"><command>find .</command><description>List files</description><limit>10</limit></tool_call>',
  bashWithDescriptionTools,
);
assert.deepStrictEqual(
  bashWithDescription.input,
  { command: "find .", description: "List files" },
  "schema-allowed optional parameters should be preserved while unknown fields are stripped",
);

const misses = [
  {
    name: "ordinary prose",
    text: "I read the file yesterday and it looked fine.",
  },
  {
    name: "disallowed tool",
    text: `Write: file_path="${winPath}", content="x"`,
  },
  {
    name: "missing required field",
    text: "Read: path=\"README.md\"",
  },
  {
    name: "tool example inside code fence",
    text: "Example:\n```text\n<tool_call>{\"name\":\"Read\",\"input\":{\"file_path\":\"README.md\"}}</tool_call>\n```",
  },
  {
    name: "bash command with unbalanced interior quotes",
    text: 'Bash command: "git diff "main"',
  },
];

for (const testCase of misses) {
  assert.strictEqual(parseToolCallText(testCase.text, tools), null, `${testCase.name}: expected null`);
}

const detailed = parseToolCallDetailed(`<tool_call>Read\npath: "README.md"\n</think>`, tools);
assert.strictEqual(detailed.tool, null, "detailed miss should not return missing-required tool");
assert.strictEqual(detailed.candidates, 1, "detailed miss should report candidates");
assert.strictEqual(detailed.reason, "no-valid-candidate", "detailed miss should report reason");

console.log(`tool parser ok: ${cases.length} parsed, ${misses.length} rejected`);
