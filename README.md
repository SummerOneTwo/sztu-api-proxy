# SZTU API Proxy

Local compatibility proxies for SZTU `glm-5.1` and `deepseek-v4-pro`.

This repository only contains proxy code. Client configuration files such as
OpenCode `opencode.json`, Claude Code `settings.json`, or CodeBuddy
`model.json` can be copied into each subdirectory by the user.

## Environment

Create `.env` in the repository root:

```env
SZTU_API_KEY=your_key_here
```

Optional:

```env
OPENCODE_PROXY_PORT=8788
CLAUDE_SZTU_PROXY_PORT=8790
CODEBUDDY_PROXY_PORT=8787
SZTU_DEFAULT_MAX_TOKENS=16384
SZTU_MAX_TOKENS=32768
```

## Proxies

OpenCode:

```powershell
node .\opencode\opencode-proxy.js
```

Claude Code:

```powershell
node .\claudecode\claudecode-proxy.js
```

CodeBuddy:

```powershell
node .\codebuddy\codebuddy-proxy.js
```

Runtime logs and PID files are written under each proxy's `.runtime` folder.

## Tests

Run direct SZTU API checks:

```powershell
node .\scripts\test-api.js direct
```

Run proxy checks after starting the matching proxy:

```powershell
node .\scripts\test-api.js opencode
node .\scripts\test-api.js codebuddy
node .\scripts\test-api.js claudecode
```

Run everything:

```powershell
node .\scripts\test-api.js all
```

See [scripts/README.md](scripts/README.md) for the full test matrix.
