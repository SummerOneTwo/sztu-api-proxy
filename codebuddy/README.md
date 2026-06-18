# CodeBuddy

## Supported Models

The CodeBuddy proxy supports both SZTU models:

- `glm-5.1`
- `deepseek-v4-pro`
- `deepseek-v4-pro-instruct` (same upstream model, `thinking=false` — matches CK-Bench L2 judge)

Both models are exposed as local custom models through `models.json` and route
to:

```text
http://127.0.0.1:8787/v1/chat/completions
```

The client config may use `apiKey: "any"`; the proxy reads the real key from the
repository root `.env`.

## Runtime

Start the proxy:

```powershell
node .\codebuddy\codebuddy-proxy.js
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## Notes

- GLM defaults to `chat_template_kwargs.enable_thinking=false` for CodeBuddy
  traffic. This avoids empty final content when the output budget is spent on
  reasoning tokens.
- DeepSeek `deepseek-v4-pro` keeps `thinking=true` / `reasoning_effort=max`.
- DeepSeek `deepseek-v4-pro-instruct` routes to the same upstream model with
  `chat_template_kwargs.thinking=false` (CK-Bench agent eval default).
- `max_completion_tokens` and `max_output_tokens` are normalized to
  `max_tokens` and clamped by `SZTU_DEFAULT_MAX_TOKENS` / `SZTU_MAX_TOKENS`.
- Upstream 5xx errors are retried up to 3 attempts before returning the error to
  CodeBuddy.

## Verified Smoke Tests

The proxy was verified with direct API calls for:

- GLM non-stream chat
- GLM stream chat
- GLM Responses API conversion
- GLM native tool call
- GLM tool-result follow-up
- DeepSeek non-stream chat

It was also verified by running CodeBuddy CLI end-to-end against both models to
create a small zero-dependency Node.js todo CLI project and run its tests.
