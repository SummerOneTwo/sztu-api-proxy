const assert = require("assert");
const { parseToolCallDetailed, parseToolCallText } = require("../claudecode/tool-parser");

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
