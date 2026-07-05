# Test Scripts

Main entry:

```powershell
node .\scripts\test-api.js direct
```

Suites:

```text
direct      Calls SZTU upstream directly.
opencode    Calls http://127.0.0.1:8788/v1/chat/completions.
codebuddy   Calls http://127.0.0.1:8787/v1/chat/completions.
all         Runs every suite.
```

The root `.env` must contain:

```env
SZTU_API_KEY=...
```

Proxy suites require the matching proxy to be running first.

```powershell
node .\opencode\opencode-proxy.js
node .\codebuddy\codebuddy-proxy.js
```

Examples:

```powershell
node .\scripts\test-api.js direct
node .\scripts\test-api.js codebuddy
node .\scripts\test-codebuddy-proxy.js
```

When a proxy test fails, check the JSONL runtime logs and search by
`requestId`:

```powershell
Get-Content -Tail 30 .\codebuddy\.runtime\codebuddy-proxy.log
Get-Content -Tail 30 .\opencode\.runtime\opencode-proxy.log
```
