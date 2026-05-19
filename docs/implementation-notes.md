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
SZTU_DEFAULT_MAX_TOKENS=16384
SZTU_MAX_TOKENS=32768
```

The proxies clamp client-provided larger values to the configured default
maximum.

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

Direct SZTU requests with OpenAI `tools` were not usable during testing.

GLM with `tools` returned:

```text
500 Internal Server Error
```

DeepSeek with `tools` sometimes reset the TLS connection or failed at the
gateway.

Conclusion:

```text
Do not rely on SZTU native OpenAI tools for these models.
For Claude Code, use prompt-mediated tool calls and translate them in the proxy.
```

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

### Why Native Tool Forwarding Was Disabled

Claude Code sends a large Anthropic `tools` list. Directly converting this list
to OpenAI `tools` and forwarding it to SZTU caused failures:

```text
GLM: 500
DeepSeek: connection reset or gateway failure
```

The current proxy does not forward native tools by default.

Native forwarding can be experimented with using:

```env
CLAUDE_SZTU_FORWARD_TOOLS=1
```

But it is not the default because the SZTU endpoint did not reliably support
OpenAI tool calls.

### Prompt-Mediated Tool Bridge

Instead of native OpenAI tools, the proxy selectively injects a small tool
instruction into the system prompt.

The instruction asks the model to output:

```text
<tool_call>{"name":"Read","input":{"file_path":"..."}}</tool_call>
```

The proxy then converts this model text into Anthropic content:

```json
{
  "type": "tool_use",
  "id": "toolu_...",
  "name": "Read",
  "input": {
    "file_path": "..."
  }
}
```

Claude Code receives the `tool_use`, executes the tool, then sends a
`tool_result` back to the proxy. The proxy converts that result into normal
OpenAI-style chat history for SZTU.

### Tool Prompt Minimization

Injecting all Claude Code tools made GLM unstable. It sometimes returned an
empty stream with usage `0/0`, or SZTU returned 502.

Final strategy:

```text
Only inject tool instructions when the user prompt clearly asks for external
state or action.
Only include relevant tools.
```

Examples:

```text
read/open/file/CLAUDE.md/AGENTS.md -> Read, LS
grep/search/find                  -> Grep, Glob, Read
edit/write/fix/implement          -> Read, Edit, MultiEdit, Write, Grep, Glob
run/test/bash/uv/python/node      -> Bash, Read
```

For normal chat such as `please only reply OK`, the proxy injects no tool
prompt.

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

All of these are normalized to Anthropic `tool_use`.

### Tool Result History

An early implementation converted previous assistant `tool_use` blocks back
into OpenAI `tool_calls` in history. Since native OpenAI tools are not being
used, this caused schema errors such as:

```text
request format doesn't match schema:
property "messages" validation failed:
property "content" validation failed: wrong type
```

Final strategy:

```text
When native tool forwarding is disabled, drop assistant tool_use history.
Keep only tool_result content as normal user text.
```

The tool result is sent upstream as:

```text
Tool result:
...

Answer the user's original request directly. Do not mention the tool call.
```

This avoids the model simply repeating the tool call.

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

- Tool calling is prompt-mediated, not native model tool calling.
- Tool format compliance depends on model behavior; the proxy includes several
  fallback parsers.
- GLM can be unstable behind SZTU/APISIX and sometimes returns 502.
- Long Claude Code system prompts make requests expensive in prompt tokens.
- Image/document inputs are currently omitted as text placeholders.

## Security and Open Source Hygiene

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
