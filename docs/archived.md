# Archived: GLM and Claude Code

> Historical trial-and-error for **GLM** and **Claude Code** only.
> **Do not use** for current CodeBuddy / DeepSeek setup.
>
> Active DeepSeek / CodeBuddy / OpenCode notes live in
> [implementation-notes.md](implementation-notes.md).
>
> Official API reference: [DeepSeek-V4-Pro_API_v1.0.md](DeepSeek-V4-Pro_API_v1.0.md)

---

# Implementation Notes and Troubleshooting (archived copy)

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
  claudecode/            # removed in v0.2.2
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

Proxy policy (trial, Claude Code era):

```text
SZTU_DEFAULT_MAX_TOKENS=32768
SZTU_MAX_TOKENS=32768
SZTU_THINKING_MIN_MAX_TOKENS=10000
```

### GLM 502 Instability

After fixing `max_tokens`, GLM still sometimes returned `502 Bad Gateway`
(openresty / APISIX). Looked like upstream instability.

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

### Native OpenAI Tools (Claude Code trial)

SZTU accepts native `tool_calls` as model output, but rejects request history
containing assistant `tool_calls` or `role=tool` messages.

Claude Code used `CLAUDE_SZTU_TOOL_HISTORY_MODE=text` by default.

## Claude Code Proxy (removed)

The `claudecode/` proxy translated Anthropic Messages API to SZTU chat
completions. Removed in changelog v0.2.2. See git history for full notes on
tool parsing, Anthropic SSE, GLM-first routing, and fallback behavior.

## Related archived files

- [GLM-5.1-FP8_API_v1.1.md](GLM-5.1-FP8_API_v1.1.md) — GLM API reference (GLM unavailable on current deployment)
- `claudecode/` directory — legacy, no longer supported
