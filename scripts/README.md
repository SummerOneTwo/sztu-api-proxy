# Test Scripts

Main entry:

```powershell
node .\scripts\test-api.js direct
```

Suites:

```text
direct      Calls SZTU upstream directly.
opencode    Calls http://127.0.0.1:8788/v1/chat/completions.
codebuddy   Calls http://127.0.0.1:8787/v1/chat/completions and /v1/responses.
claudecode  Calls http://127.0.0.1:8790/v1/messages.
all         Runs every suite.
```

The root `.env` must contain:

```env
SZTU_API_KEY=...
```

Proxy suites require the matching proxy to be running first:

```powershell
node .\opencode\opencode-proxy.js
node .\codebuddy\codebuddy-proxy.js
node .\claudecode\claudecode-proxy.js
```

Examples:

```powershell
node .\scripts\test-api.js direct
node .\scripts\test-api.js claudecode
node .\scripts\test-api.js opencode codebuddy
node .\scripts\test-api.js all
```

Parser-only check for Claude Code tool-call formats:

```powershell
node .\scripts\test-tool-parser.js
```

Claude Code proxy helper regression check:

```powershell
node .\scripts\test-claudecode-proxy.js
```

Switchboard dashboard and CLI:

```powershell
node .\scripts\sztu-switch.js serve
node .\scripts\sztu-switch.js status
node .\scripts\sztu-switch.js autostart on opencode codebuddy
```

Switchboard helper check:

```powershell
node .\scripts\test-switchboard.js
```

The Claude Code suite checks:

- health endpoint
- Sonnet and Haiku Claude model aliases routed to the configured default SZTU model
- non-streaming Anthropic message conversion
- streaming Anthropic SSE conversion with usage
- native `tool_calls` to Anthropic `tool_use` conversion
- native streaming `tool_calls` conversion
- SZTU-compatible text-mode tool-result history loop

When a proxy test fails, check the JSONL runtime logs and search by
`requestId`:

```powershell
Get-Content -Tail 30 .\claudecode\.runtime\claudecode-proxy.log
Get-Content -Tail 30 .\codebuddy\.runtime\codebuddy-proxy.log
Get-Content -Tail 30 .\opencode\.runtime\opencode-proxy.log
```
