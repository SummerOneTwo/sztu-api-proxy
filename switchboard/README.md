# SZTU Switchboard

Local control console for the three SZTU proxy processes.

## UI

Start the dashboard:

```powershell
node .\scripts\sztu-switch.js serve
```

Open the dashboard in a browser:

```powershell
node .\scripts\sztu-switch.js open
```

Default URL:

```text
http://127.0.0.1:8795
```

## CLI

```powershell
node .\scripts\sztu-switch.js status
node .\scripts\sztu-switch.js start opencode codebuddy
node .\scripts\sztu-switch.js stop claudecode
node .\scripts\sztu-switch.js restart opencode
node .\scripts\sztu-switch.js autostart on opencode codebuddy
node .\scripts\sztu-switch.js autostart off
node .\scripts\sztu-switch.js autostart run
```

## Behavior

- `start` / `stop` / `restart` support multiple service IDs in one command.
- `autostart on` stores the selected services and creates a Windows Task
  Scheduler task that runs on logon with limited privileges.
- `autostart off` removes the scheduled task and clears the launcher script.
- The dashboard keeps run selection and autostart selection separate.
- Service status, PID, health, and logs come from the proxy runtime folders.
- The dashboard includes recommended connection snippets for OpenCode,
  CodeBuddy, and Claude Code.

## Services

- `opencode`
- `codebuddy`
- `claudecode`
