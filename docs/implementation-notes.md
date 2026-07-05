# Implementation Notes and Troubleshooting

This document records the trial-and-error process for SZTU `deepseek-v4-pro`
through the OpenCode and CodeBuddy local proxies.

Official API reference: [DeepSeek-V4-Pro_API_v1.0.md](DeepSeek-V4-Pro_API_v1.0.md)

Historical GLM / Claude Code notes: [archived.md](archived.md) (not used for
current CodeBuddy setup).

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
    codebuddy-proxy.js   # OpenAI-compatible proxy for CodeBuddy
    models.json          # user-maintained reference config
  docs/
```

All proxies read the SZTU key from root `.env` through `shared/env.js`.

```env
SZTU_API_KEY=...
```

The client-side configs use placeholder keys such as `any`; the proxy replaces
that with the real SZTU key.

## SZTU API Findings (DeepSeek)

### Endpoint

```text
https://apiai.sztu.edu.cn/v1/chat/completions
```

Upstream model name:

```text
deepseek-v4-pro
```

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

For reasoning tiers, see the official doc (`thinking` + `reasoning_effort`
`high` / `max`). The CodeBuddy proxy maps three client model ids to these
kwargs (see CodeBuddy Proxy below).

### `max_tokens` on SZTU (observed)

During testing on this deployment, output budget was capped at 32768:

```text
max_tokens=32768    OK
max_tokens=65536    400: max_tokens exceeds limit of 32768
```

The CodeBuddy proxy uses env-configurable defaults:

```text
SZTU_DEFAULT_MAX_TOKENS=8192   # when the client omits max_tokens
SZTU_MAX_TOKENS=32768          # cap for explicit client requests
```

For `deepseek-v4-pro-max`, the proxy floors `max_tokens` to 4000 when the
client sends a smaller value (official Think Max guidance).

### Upstream 502 Instability

SZTU sometimes returned:

```text
502 Bad Gateway
openresty / APISIX
```

This happened even for valid requests and looked like upstream instability.
Both proxies retry 5xx responses up to 3 times before returning an error.

### Native OpenAI Tools

Testing with small built-in tool sets shows `deepseek-v4-pro` can return
standard OpenAI-compatible `tool_calls`.

SZTU-specific history caveat:

```text
SZTU accepts native tool_calls as model output, but rejects request history
containing assistant tool_calls or role=tool messages.
```

The CodeBuddy proxy workaround:

```text
- Convert role=tool messages to role=user text summaries.
- Drop assistant messages that contain tool_calls (non-empty arrays only).
```

Verified through the CodeBuddy proxy path:

- GLM native tool call (historical; GLM no longer used)
- GLM tool-result follow-up (historical)
- DeepSeek non-stream chat
- CodeBuddy CLI end-to-end against DeepSeek models

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

- Normalize model names to `deepseek-v4-pro` (and legacy `glm-5.1` if still
  configured in `opencode.json`).
- Add `stream_options.include_usage=true` for streaming requests.
- Clamp `max_tokens`.
- Remove unsupported request fields such as provider metadata and top-level
  `reasoning` / `reasoning_effort` that SZTU does not accept as-is.
- Inject model-specific `chat_template_kwargs` (see `opencode/opencode.json`
  variants for `high` / `max`).

OpenCode config points at:

```text
http://127.0.0.1:8788/v1
```

The client config should use a placeholder key such as `any`; the proxy reads
the real key from `.env`.

Runtime logs:

```text
opencode/.runtime/opencode-proxy.log
```

## CodeBuddy Proxy

File:

```text
codebuddy/codebuddy-proxy.js
```

Purpose:

```text
CodeBuddy -> local OpenAI-compatible proxy -> SZTU chat/completions
```

### Client model ids (three tiers)

CodeBuddy `models.json` has no per-model effort field. Pick the tier from the
model dropdown:

| Client model id | `chat_template_kwargs` |
|-----------------|------------------------|
| `deepseek-v4-pro` | `thinking: true`, `reasoning_effort: "high"` |
| `deepseek-v4-pro-instruct` | `thinking: false` |
| `deepseek-v4-pro-max` | `thinking: true`, `reasoning_effort: "max"` |

All three map upstream to `deepseek-v4-pro`. Unknown client model ids return
400.

Internal alias: `deepseek-v4-pro-nothink` -> instruct.

### Compatibility work

- Supports `/v1/chat/completions` only (CodeBuddy custom models use this path).
- Preserves usage in streaming responses when SZTU sends usage
  (`stream_options.include_usage=true`).
- Uses `any` in `models.json`; the proxy provides the real key upstream.
- Strips client `reasoning` / `reasoning_effort` and re-injects kwargs by tier.

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
codebuddy/.runtime/codebuddy-proxy.log
```

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
```

The repository ignores:

```text
.env
.runtime/
**/.runtime/
*.log
*.pid
```

## Runtime Logs

The proxy logs are kept under each proxy's ignored `.runtime` directory:

```text
opencode/.runtime/opencode-proxy.log
codebuddy/.runtime/codebuddy-proxy.log
```

The logs use JSON Lines. Each line is one event and includes:

```text
ts          ISO timestamp
service     opencode / codebuddy
event       request, upstream-response-start, response, upstream-error-response, ...
requestId   stable id for one client request
durationMs  elapsed time for upstream/response events
```

Useful debugging flow:

```powershell
rg '"event":"upstream-error-response"' .\**\.runtime\*.log
rg "cb_..." .\codebuddy\.runtime\codebuddy-proxy.log
```

For every proxied request, the logs record sanitized summaries for both client
and upstream bodies:

```text
model, stream, max_tokens, message count, role list, content size,
last user preview, tool count, tool names, stream options, thinking flags
```

They intentionally do not log real API keys or Authorization headers.

Common failure modes:

```text
listen EADDRINUSE             local port already occupied
upstream-error-response 502   SZTU/APISIX upstream failure
unsupported-model             client model id not in the three-tier list
bad-upstream-sse              upstream emitted malformed SSE JSON
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

## Useful Debug Commands

Check syntax:

```powershell
node --check .\opencode\opencode-proxy.js
node --check .\codebuddy\codebuddy-proxy.js
```

Unit tests:

```powershell
node .\scripts\test-codebuddy-proxy.js
node .\scripts\test-api.js codebuddy
```

Check key loading without printing the key:

```powershell
node -e "const {getApiKey}=require('./shared/env'); const k=getApiKey(); console.log({hasKey:!!k,length:k.length})"
```

Search for accidental secrets before publishing:

```powershell
rg -n "(Bearer [A-Za-z0-9_-]{20,}|SZTU_API_KEY=.+|OPENAI_API_KEY=.+|ANTHROPIC_API_KEY=.+)" . --hidden -g "!.git/**" -g "!.runtime/**" -g "!.env"
```
