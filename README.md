# SZTU API Proxy

Local compatibility proxies for SZTU `glm-5.1` and `deepseek-v4-pro`.

This repository only contains proxy code. Client configuration files such as
OpenCode `opencode.json` or CodeBuddy `model.json` can be copied into each
subdirectory by the user.

## Claude Code (No Longer Supported)

The Claude Code proxy has been removed. This project no longer supports Claude Code.
Use OpenCode or CodeBuddy instead.

## Environment

Create `.env` in the repository root:

```env
SZTU_API_KEY=your_key_here
```

Optional:

```env
SZTU_DEFAULT_MODEL=glm-5.1
OPENCODE_PROXY_PORT=8788
CODEBUDDY_PROXY_PORT=8787
SZTU_DEFAULT_MAX_TOKENS=32768
SZTU_MAX_TOKENS=32768
SZTU_THINKING_MIN_MAX_TOKENS=10000
```

## Proxies

OpenCode:

```powershell
node .\opencode\opencode-proxy.js
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
```

Run everything:

```powershell
node .\scripts\test-api.js all
```

See [scripts/README.md](scripts/README.md) for the full test matrix.
