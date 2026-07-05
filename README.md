# SZTU API Proxy

Local compatibility proxies for SZTU `deepseek-v4-pro`.

Official API reference: [docs/DeepSeek-V4-Pro_API_v1.0.md](docs/DeepSeek-V4-Pro_API_v1.0.md)

Trial notes: [docs/implementation-notes.md](docs/implementation-notes.md)

## Environment

Create `.env` in the repository root:

```env
SZTU_API_KEY=your_key_here
```

Optional ports:

```env
CODEBUDDY_PROXY_PORT=8787
OPENCODE_PROXY_PORT=8788
```

## Proxies

CodeBuddy:

```powershell
node .\codebuddy\codebuddy-proxy.js
```

OpenCode:

```powershell
node .\opencode\opencode-proxy.js
```

Runtime logs and PID files are under each proxy's `.runtime/` (`events/`, `payloads/`, `streams/`).

## Tests

```powershell
node .\scripts\test-api.js direct
node .\scripts\test-api.js codebuddy
node .\scripts\test-codebuddy-proxy.js
```

See [scripts/README.md](scripts/README.md) for the full test matrix.
