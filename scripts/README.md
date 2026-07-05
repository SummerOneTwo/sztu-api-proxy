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
node .\scripts\test-codebuddy-envelope.js
```

When a proxy test fails, search events by `requestId`, then open sidecar files:

```powershell
Get-Content -Tail 30 .\codebuddy\.runtime\events\*.jsonl
Get-Content .\codebuddy\.runtime\payloads\cb_REQUEST_ID\sanitized.json
Get-Content .\codebuddy\.runtime\streams\cb_REQUEST_ID.sse
Get-Content -Tail 30 .\opencode\.runtime\events\*.jsonl
```

Envelope salvage fixture (optional): `codebuddy/.runtime/fixtures/envelope-fail-*.txt`
