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
SZTU_DEFAULT_MODEL=deepseek-v4-pro
OPENCODE_PROXY_PORT=8788
CLAUDE_SZTU_PROXY_PORT=8790
CODEBUDDY_PROXY_PORT=8787
SZTU_DEFAULT_MAX_TOKENS=32768
SZTU_MAX_TOKENS=32768
SZTU_THINKING_MIN_MAX_TOKENS=10000
```

Claude Code proxy (`claudecode/`) is currently optimized for DeepSeek; see
`claudecode/README.md`.

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

## Switchboard

Use the local control console to manage proxy processes, status, logs, `.env`
settings, recommended client snippets, and Windows autostart:

```powershell
node .\scripts\sztu-switch.js serve
```

The dashboard runs at `http://127.0.0.1:8795` by default. See
[switchboard/README.md](switchboard/README.md) for the command list.

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
