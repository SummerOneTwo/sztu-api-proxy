# Implementation Notes and Troubleshooting

This document records the trial-and-error process used to make SZTU `glm-5.1`
and `deepseek-v4-pro` usable through local proxies for OpenCode, CodeBuddy, and
Claude Code.

It intentionally focuses on what was tried, what failed, what worked, and why.
Keep secrets out of this file. Real keys should only live in the repository root
`.env`.

## Current Layout

```text
sztu-api-proxy/
  .env                  # local only, ignored by git
  .env.example
  shared/env.js          # common .env loader
  opencode/
    opencode-proxy.js    # OpenAI-compatible proxy for OpenCode
    opencode.json        # user-maintained reference config
  codebuddy/
    codebuddy-proxy.js   # OpenAI/Responses-compatible proxy for CodeBuddy
    models.json          # user-maintained reference config
  claudecode/
    claudecode-proxy.js
    settings.json        # user-maintained reference config
  docs/
```

All proxies read the SZTU key from root `.env` through `shared/env.js`.

```env
SZTU_API_KEY=...
```

The client-side configs use placeholder keys such as `any`; the proxy replaces
that with the real SZTU key.

## SZTU API Findings

### Endpoint

Both GLM and DeepSeek use:

```text
https://apiai.sztu.edu.cn/v1/chat/completions
```

Working model names:

```text
glm-5.1
deepseek-v4-pro
```

### GLM `max_tokens` Issue

Important finding: `glm-5.1` returned `500 Internal Server Error` when
`max_tokens` was omitted in a minimal OpenAI request.

These requests returned 500:

```json
{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "hi" }]
}
```

```json
{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "hi" }],
  "stream": false
}
```

Adding a small `max_tokens` made the same request succeed:

```json
{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "hi" }],
  "stream": false,
  "max_tokens": 8192,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

Observed bounds:

```text
max_tokens=16       OK
max_tokens=64       OK
max_tokens=128      OK
max_tokens=512      OK
max_tokens=2048     OK
max_tokens=4096     OK
max_tokens=8192     OK
max_tokens=16384    OK
max_tokens=32768    OK
max_tokens=65536    400: max_tokens exceeds limit of 32768
max_tokens=131072   400: max_tokens exceeds limit of 32768
```

Conclusion:

```text
GLM supports a 128K context window, but max_tokens is the output budget.
For this SZTU deployment, max_tokens must be <= 32768.
Omitting max_tokens may trigger a server-side default that causes 500.
```

Proxy policy:

```text
SZTU_DEFAULT_MAX_TOKENS=32768
SZTU_MAX_TOKENS=32768
SZTU_THINKING_MIN_MAX_TOKENS=10000
```

The proxies clamp client-provided larger values to the configured default
maximum. Claude Code thinking requests are floored to the configured thinking
minimum unless the client already requested a larger budget.

### GLM 502 Instability

After fixing `max_tokens`, GLM still sometimes returned:

```text
502 Bad Gateway
openresty / APISIX
```

This happened even for valid requests and looked like upstream instability.
The Claude Code proxy now retries 5xx responses briefly before returning an
error to the client.

### DeepSeek Basic Behavior

DeepSeek worked with minimal requests:

```json
{
  "model": "deepseek-v4-pro",
  "messages": [{ "role": "user", "content": "hi" }],
  "stream": false,
  "max_tokens": 8192,
  "chat_template_kwargs": { "thinking": false }
}
```

For normal non-reasoning use, explicitly set:

```json
{
  "chat_template_kwargs": { "thinking": false }
}
```

DeepSeek was generally more stable than GLM during Claude Code testing.

### Native OpenAI Tools

Earlier tests showed SZTU instability when forwarding large Claude Code tool
lists directly. Current testing with small built-in tool sets shows
`deepseek-v4-pro` can return standard OpenAI-compatible `tool_calls`.

Current strategy:

```text
Use native OpenAI tool_calls by default.
Keep prompt-mediated parsing as fallback via CLAUDE_SZTU_TOOL_MODE=prompt.
Treat strict function calling as experimental until SZTU support is verified.
```

SZTU-specific history caveat:

```text
SZTU currently accepts native tool_calls as model output, but rejects request
history containing assistant tool_calls or role=tool messages.
```

For this reason, `CLAUDE_SZTU_TOOL_HISTORY_MODE=text` is the default. It keeps
the first tool call native, then sends tool results back as user text. A future
fully OpenAI-compatible backend can opt into `structured`.

## OpenCode Proxy

File:

```text
opencode/opencode-proxy.js
```

Purpose:

```text
OpenCode -> local OpenAI-compatible proxy -> SZTU chat/completions
```

Important compatibility work:

- Normalize model names to `glm-5.1` or `deepseek-v4-pro`.
- Add `stream_options.include_usage=true` for streaming requests.
- Clamp `max_tokens`.
- Remove unsupported request fields such as provider metadata and reasoning
  fields that SZTU does not accept.
- Add model-specific `chat_template_kwargs`.

OpenCode config is user-managed and only needs to point at:

```text
http://127.0.0.1:8788/v1
```

The client config should use a placeholder key such as `any`; the proxy reads
the real key from `.env`.

## CodeBuddy Proxy

File:

```text
codebuddy/codebuddy-proxy.js
```

Purpose:

```text
CodeBuddy -> local OpenAI/Responses-compatible proxy -> SZTU chat/completions
```

Important compatibility work:

- Supports `/v1/chat/completions`.
- Supports `/v1/responses` by converting Responses API-style input to chat
  completions.
- Preserves usage in streaming responses when SZTU sends usage.
- Converts some OpenAI Responses-style output back when needed.
- Removes hardcoded API key; now uses root `.env`.
- Uses `any` in `models.json`; the proxy provides the real key upstream.

Older approach:

```text
Use non-streaming to fake SSE to recover usage.
```

Current finding:

```text
SZTU streaming can include usage when stream_options.include_usage=true.
DeepSeek SSE usage was testable through the CodeBuddy proxy path.
```

Runtime logs:

```text
codebuddy/.runtime/
```

## Claude Code Proxy

File:

```text
claudecode/claudecode-proxy.js
```

Purpose:

```text
Claude Code -> local Anthropic-compatible proxy -> SZTU chat/completions
```

This was the hardest part because Claude Code expects the Anthropic Messages
API and Anthropic SSE event format, while SZTU exposes an OpenAI-compatible
chat completions endpoint.

### Claude Code Model Routing

Claude Code rejects arbitrary model names such as:

```text
glm-5.1
sztu/glm-5.1
deepseek-v4-pro
```

Working strategy in the proxy:

```text
model glm-5.1           -> proxy routes to glm-5.1
model deepseek-v4-pro   -> proxy routes to deepseek-v4-pro
```

Config example:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790",
    "ANTHROPIC_API_KEY": "any",
    "ANTHROPIC_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1"
  }
}
```

During early testing, Claude Code CLI aliases such as `sonnet` and `haiku`
were also used because some Claude Code versions reject arbitrary model names
when passed on the command line. The proxy still accepts those Claude-looking
model names as compatibility aliases, but the repository config uses the real
SZTU model names.

### Minimal Anthropic Compatibility

The proxy implements:

```text
POST /v1/messages
```

Non-streaming response shape:

```json
{
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "OK" }],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 9,
    "output_tokens": 2
  }
}
```

Streaming response event sequence:

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

The final `message_delta` includes:

```json
{
  "usage": {
    "input_tokens": 12027,
    "output_tokens": 2
  }
}
```

This is required for Claude Code to show usage correctly.

For streaming `tool_use`, Claude Code expects Anthropic-style input deltas. The
proxy must send:

```text
content_block_start  tool_use with input: {}
content_block_delta  input_json_delta with partial_json: "{\"command\":\"git diff\"}"
content_block_stop
```

Putting the full tool input only on `content_block_start.content_block.input`
can make Claude Code display an empty `IN` block and reject tools such as Bash
with:

```text
The required parameter `command` is missing
```

This can happen even when the proxy parser log shows `inputKeys:["command"]`,
because the parser had the command but the SSE event shape did not deliver it in
the format Claude Code consumes.

### Claude Code Health Probe

Claude Code sends `HEAD /` probes. The proxy logs these as `not-found`, which
is harmless.

Earlier bug:

```text
Proxy only matched req.url === "/v1/messages".
Claude Code sometimes used paths with query strings.
```

Fix:

```js
new URL(req.url || "/", `http://${HOST}:${PORT}`).pathname
```

### Native Tool Forwarding

The current default is native OpenAI-compatible tool forwarding.
Claude Code `tools` are translated into OpenAI `tools`, then SZTU/DeepSeek
`tool_calls` are translated back into Anthropic `tool_use`.

The old prompt-mediated bridge is still available as a fallback via:

```env
CLAUDE_SZTU_TOOL_MODE=prompt
```

Native mode avoids injecting XML tool instructions into the system prompt and
keeps the tool loop closer to the actual provider protocol.

### Tool Result History

In default SZTU mode, Claude Code `tool_result` messages are forwarded as
plain user text because the SZTU schema rejects request history containing
assistant `tool_calls` or `role: "tool"` messages.

`CLAUDE_SZTU_TOOL_HISTORY_MODE=structured` keeps the standard OpenAI loop:
assistant `tool_calls` followed by `role: "tool"` with the matching
`tool_call_id`. This is kept for future compatible providers, not the current
SZTU default.

In prompt mode, the proxy keeps the older text bridge:

```text
Tool result:
...

Continue the user's task. If more inspection, edits, or commands are needed,
request exactly one tool call. Otherwise answer concisely.
```

This keeps the old parser path available for fallback and regression checks.

### Claude Code DeepSeek-Only Mode (2026-05)

The Claude Code proxy is still optimized for `deepseek-v4-pro` only:

```text
All client model names map to SZTU_DEFAULT_MODEL (default: deepseek-v4-pro).
GLM remains available for OpenCode/CodeBuddy/direct tests but is not the CC default.
```

Reasoning is mapped per Claude Code request:

```text
thinking.type = enabled  -> chat_template_kwargs.thinking = true
thinking.type = adaptive -> true
thinking.type = disabled -> false
(no thinking field)      -> true
```

The proxy does not currently forward DeepSeek `reasoning_content` back to Claude
Code thinking blocks; only final `content` is surfaced to the client.

Reference config: `claudecode/settings.json`.

### Tool Output Formats Seen in Practice

Models did not consistently follow the requested XML/JSON format. The proxy
therefore accepts several loose formats:

1. Requested format:

```text
<tool_call>{"name":"Read","input":{"file_path":"..."}}</tool_call>
```

2. DeepSeek-style text:

```text
Tool: Read
Arguments: {"file_path":"..."}
```

3. Named XML:

```text
<tool_call name="Read">
{"file_path":"..."}
</tool_call>
```

4. Nested tool XML:

```text
<tool name="Read">
<parameter name="file_path">...</parameter>
</tool>
```

5. GLM-style arg key/value:

```text
<tool_call>Read
<arg_key>file_path</arg_key>
<arg_value>...</arg_value>
</tool_call>
```

6. Claude Code UI-style plain text:

```text
Read

Read: file_path: "C:\path\file.md"
```

7. Function-call-looking text:

```text
Read({"file_path":"C:\path\file.md"})
```

8. Broken repeated tool calls mixed with reasoning tags:

```text
<tool_call>Glob
pattern:
**/proxy.js
</think><tool_call>Glob
pattern:
**/.env
</think>
```

The proxy takes the first parseable tool call from this format. It does not try
to execute multiple tool calls from one malformed assistant message.

9. DeepSeek-style tool tags with full-width separators:

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>Glob<｜tool▁sep｜>{"pattern":"**/proxy.js"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

10. JSON arrays of tool calls:

```text
<tool_call>[{"name":"Glob","input":{"pattern":"**/*.js"}}]</tool_call>
```

11. Malformed `arg_key` entries where the model puts the key/value pair inside
    the tag body:

```text
<tool_call>Bash<arg_key>command": "git diff"</arg_value></tool_call>
```

12. DeepSeek `<tool-use>` XML:

```text
<tool-use name="Bash"><parameter name="command">ls -la</parameter></tool-use>
```

13. Repeated `Tool:` prefix with JSON body:

```text
Tool: Read
Tool: {"file_path":"README.md"}
```

14. Claude-style inline tool blocks:

```text
<tool-calls>
<tool_use id="...">Read: README.md</tool_use>
<tool_use id="...">Bash: tree -L 2</tool_use>
</tool-calls>
```

15. Truncated quoted Bash commands (repair leading quote, reject unbalanced quotes).

16. DeepSeek hyphenated `<tool-call>` with extra parameter attributes:

```text
<tool-call name="Read"><parameter name="file_path" string="true">README.md</parameter></tool-call>
```

17. DeepSeek `<invoke name="...">` XML:

```text
<invoke name="Write"><parameter name="file_path">index.html</parameter><parameter name="content">&lt;!doctype html&gt;</parameter></invoke>
```

18. Unnamed parameter XML where the tool is inferred from the inputs:

```text
<tool_call><parameter name="command">node --version</parameter></tool_call>
```

19. `Write`/`Edit` mismatches when Claude Code exposes only one of those tools.
If `Write` is unavailable but `Edit` is allowed, `content` is converted to
`new_string` and `old_string` is filled from the existing file when possible.
If `Edit` uses an empty `old_string` while `Write` is available, the call is
converted to `Write`.

When a completion contains multiple valid tool calls, the parser can now return
all of them. The older single-call API still returns the first parsed tool for
compatibility, while the proxy uses the multi-call API and emits multiple
Anthropic `tool_use` content blocks with separate indexes.

Before returning `tool_use`, the parser drops any input keys that are not listed
in the Claude Code tool `input_schema.properties`. This prevents errors such as:

```text
InputValidationError: Glob failed ... unexpected parameter `limit`
```

All of these are normalized to Anthropic `tool_use`.

The parser is now split into:

```text
claudecode/tool-parser.js
```

The design follows the useful idea from `NIyueeE/ds-free-api`: treat tool calls
as a repair pipeline instead of a single strict regex. The local implementation
does not copy that project's GPL code. It applies these steps:

```text
1. Normalize known tag variants and text quirks.
2. Remove fenced code blocks so examples are not executed as real tools.
3. Extract multiple candidate tool calls from strict and malformed tags.
4. Try loose XML, arg_key/arg_value, function-call, and key/value formats.
5. Repair small JSON defects such as single quotes, trailing commas, unquoted
   keys, and unescaped Windows backslashes.
6. Enforce the Claude Code tool whitelist, required input fields, and
   `input_schema.properties` allowlist.
7. Return every valid candidate through `parseToolCallsDetailed`; the legacy
   `parseToolCallDetailed` wrapper still returns the first valid tool.
```

This matters because a malformed tool call should not be silently treated as a
normal assistant answer when Claude Code is waiting for `tool_use`.

Parser-only regression test:

```powershell
node .\scripts\test-tool-parser.js
```

This test includes the `Read / Read: file_path: ...` failure format, escaped
and unescaped Windows paths, DeepSeek-style tags, JSON arrays, code-fence false
positives, allowed-tool filtering, missing required arguments, `Tool: {json}`,
`<tool-use>`, hyphenated `<tool-call>`, `<tool-calls>` inline tools, truncated
Bash quotes, XML entity decoding, `Write`/`Edit` repair, and Glob schema field
filtering. It also verifies that schema-allowed optional parameters are
preserved while unknown fields are stripped.

In native mode, OpenAI-compatible streaming `tool_calls` are accumulated by
call index before JSON parsing. This preserves fragmented `function.arguments`
instead of trying to parse partial argument chunks.

### Tool Result History

Structured history mode keeps the OpenAI function-calling loop intact:

```json
{ "role": "assistant", "tool_calls": [...] }
{ "role": "tool", "tool_call_id": "...", "content": "..." }
```

The SZTU default is text history because direct tests showed 400 schema errors
for assistant `tool_calls` / `role: "tool"` in request history. Tool selection
still ignores `tool_result` messages and uses the original user request, so a
plain `ls` result does not accidentally hide `Write`, `Edit`, or `Bash` during
the next turn.

Proxy helper regression test:

```powershell
node .\scripts\test-claudecode-proxy.js
```

### Verified Claude Code Commands

GLM normal call:

```powershell
claude -p --output-format json --model glm-5.1 "请只回复 GLM_OK"
```

Expected:

```json
{
  "result": "GLM_OK",
  "stop_reason": "end_turn"
}
```

DeepSeek normal call:

```powershell
claude -p --output-format json --model deepseek-v4-pro "请只回复 DS_OK"
```

Expected:

```json
{
  "result": "DS_OK",
  "stop_reason": "end_turn"
}
```

GLM Read tool call:

```powershell
claude -p --output-format json --model glm-5.1 "请读取 CLAUDE.md，然后只回复 GLM_READ_OK"
```

Observed successful result:

```json
{
  "num_turns": 2,
  "result": "GLM_READ_OK"
}
```

DeepSeek Read tool call:

```powershell
claude -p --output-format json --model deepseek-v4-pro "必须调用 Read 工具读取 CLAUDE.md，然后只回复 DS_READ_OK"
```

Observed successful result:

```json
{
  "num_turns": 2,
  "result": "DS_READ_OK"
}
```

Note: if the prompt asks for a missing file, Claude Code may execute a search
or read attempt and the model may truthfully report that the file does not
exist. That is not a proxy failure.

### Claude Code Limitations

This proxy is a compatibility layer, not a full Anthropic implementation.

Known limitations:

- Tool calling is native by default, but large MCP tool sets still need more
  real-world coverage.
- If the upstream model returns text instead of `tool_calls`, fallback parser
  quality still depends on model formatting.
- GLM can be unstable behind SZTU/APISIX and sometimes returns 502.
- Long Claude Code system prompts make requests expensive in prompt tokens.
- Image/document inputs are currently omitted as text placeholders.

## Security and Open Source Hygiene

## Runtime Logs

The proxy logs are kept under each proxy's ignored `.runtime` directory:

```text
opencode/.runtime/opencode-proxy.log
codebuddy/.runtime/codebuddy-proxy.log
claudecode/.runtime/claudecode-proxy.log
```

The logs use JSON Lines. Each line is one event and includes:

```text
ts          ISO timestamp
service     opencode / codebuddy / claudecode
event       request, upstream-response-start, response, upstream-error-response, ...
requestId   stable id for one client request
durationMs  elapsed time for upstream/response events
```

Useful debugging flow:

```powershell
rg "cc_mpc..." .\claudecode\.runtime\claudecode-proxy.log
rg '"event":"upstream-error-response"' .\**\.runtime\*.log
rg '"event":"tool-parse-hit"' .\claudecode\.runtime\claudecode-proxy.log
```

For every proxied request, the logs record sanitized summaries for both client
and upstream bodies:

```text
model, stream, max_tokens, message count, role list, content size,
last user preview, tool count, tool names, stream options, thinking flags
```

They intentionally do not log real API keys or Authorization headers.

Claude Code additionally logs:

```text
tool-parse-hit        model text was converted into Anthropic tool_use
tool-parse-miss       model looked like a tool call but no valid tool_use was produced
modelTextPreview      short preview of the raw tool-call text
inputKeys             tool input keys parsed from the model output
upstream-retryable-*  GLM/DS 5xx retry attempts
```

This makes the common failure modes distinguishable:

```text
listen EADDRINUSE             local port already occupied
upstream-error-response 502   SZTU/APISIX upstream failure
tool-parse-miss               model answered text instead of a parseable tool call
tool-parse-hit + CC error     parsed tool input may include invalid schema fields (should be filtered now)
bad-upstream-sse              upstream emitted malformed SSE JSON
```

Do:

```text
Use root .env for SZTU_API_KEY.
Commit .env.example.
Commit proxy code and sanitized config examples.
```

Do not:

```text
Commit .env.
Commit private secret directories.
Commit local absolute user-profile paths.
Commit historical status reports that mention private paths or secret policy.
```

The current repository ignores:

```text
.env
.runtime/
**/.runtime/
*.log
*.pid
```

## Quick Start

Create `.env`:

```env
SZTU_API_KEY=your_key_here
```

Start OpenCode proxy:

```powershell
node .\opencode\opencode-proxy.js
```

Start CodeBuddy proxy:

```powershell
node .\codebuddy\codebuddy-proxy.js
```

Start Claude Code proxy:

```powershell
node .\claudecode\claudecode-proxy.js
```

## Useful Debug Commands

Check syntax:

```powershell
node --check .\opencode\opencode-proxy.js
node --check .\codebuddy\codebuddy-proxy.js
node --check .\claudecode\claudecode-proxy.js
```

Check key loading without printing the key:

```powershell
node -e "const {getApiKey}=require('./shared/env'); const k=getApiKey(); console.log({hasKey:!!k,length:k.length})"
```

Search for accidental secrets before publishing:

```powershell
rg -n "(Bearer [A-Za-z0-9_-]{20,}|SZTU_API_KEY=.+|OPENAI_API_KEY=.+|ANTHROPIC_API_KEY=.+)" . --hidden -g "!.git/**" -g "!.runtime/**" -g "!.env"
```
