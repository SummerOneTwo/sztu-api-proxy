# CodeBuddy

## Supported Models

Three client model ids route to upstream `deepseek-v4-pro`:

| Model id | `chat_template_kwargs` |
|----------|------------------------|
| `deepseek-v4-pro` | `thinking: true`, `reasoning_effort: "high"` |
| `deepseek-v4-pro-instruct` | `thinking: false` |
| `deepseek-v4-pro-max` | `thinking: true`, `reasoning_effort: "max"` |

Copy `models.json` to `~/.codebuddy/models.json` or `.codebuddy/models.json`.
The client may use `apiKey: "any"`; the proxy reads the real key from root `.env`.

Endpoint:

```text
http://127.0.0.1:8787/v1/chat/completions
```

See [../docs/implementation-notes.md](../docs/implementation-notes.md) for trial
notes. Official parameters: [../docs/DeepSeek-V4-Pro_API_v1.0.md](../docs/DeepSeek-V4-Pro_API_v1.0.md).

## Runtime

```powershell
node .\codebuddy\codebuddy-proxy.js
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## Notes

- Pick reasoning tier by **model id** in CodeBuddy (no per-model effort field in `models.json`).
- Missing `max_tokens` defaults to **8192**; cap at **32768** (hardcoded in proxy).
- `deepseek-v4-pro-max` raises `max_tokens` to at least 4000 per official Think Max guidance.
- Upstream 5xx errors retry up to 3 times.
- Tool history: assistant `tool_calls` dropped; `role: tool` converted to user text.
- JSONL logs under `.runtime/`; entries older than 7 days are pruned automatically.

## Tests

```powershell
node ..\scripts\test-codebuddy-proxy.js
node ..\scripts\test-api.js codebuddy
```
