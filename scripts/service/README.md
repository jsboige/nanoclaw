# NanoClaw Windows Service

Runs NanoClaw as a Windows service using [NSSM](https://nssm.cc/) so it:
- Starts automatically at boot
- Restarts on crash (5s delay, unlimited retries)
- Logs to `logs/nanoclaw.out.log` and `logs/nanoclaw.err.log` (10 MB rotation)
- Gracefully shuts down on stop (10s timeout before SIGKILL)

## Files

| File | Purpose |
|------|---------|
| `nssm.exe` | Portable NSSM 2.24 binary (Windows 64-bit) |
| `start-nanoclaw.ps1` | Launcher that loads `.env` into process env then starts `node dist/index.js` |
| `install-service.ps1` | Registers the `NanoClaw` Windows service (requires admin) |
| `uninstall-service.ps1` | Removes the `NanoClaw` Windows service (requires admin) |

## Install (one-time, requires admin)

```powershell
# 1. Open PowerShell as Administrator
# 2. cd to project root
cd d:\nanoclaw

# 3. Install service
.\scripts\service\install-service.ps1

# 4. Start
Start-Service NanoClaw
```

## Daily operations (no admin required)

```powershell
# Status
Get-Service NanoClaw

# Stop / start / restart
Stop-Service NanoClaw
Start-Service NanoClaw
Restart-Service NanoClaw

# Live tail of logs
Get-Content .\logs\nanoclaw.out.log -Tail 50 -Wait
```

## Updating the code

After `git pull` or code changes:

```powershell
cd d:\nanoclaw
npm run build
Restart-Service NanoClaw
```

The service will pick up new `dist/` and `.env` on restart.

## Uninstall (requires admin)

```powershell
.\scripts\service\uninstall-service.ps1
```

## Troubleshooting

**Service won't start:**
- Check `logs\nanoclaw.err.log`
- Try running `.\scripts\service\start-nanoclaw.ps1` directly to see errors inline

**`.env` values not loaded:**
- NSSM runs the service as `LocalSystem` by default
- The launcher loads `.env` from the working directory (configured via NSSM `AppDirectory`)
- Verify the service's working dir: `.\scripts\service\nssm.exe get NanoClaw AppDirectory`

**Need to run as a different user (for Google Drive access):**

The `LocalSystem` account does NOT have access to user-profile mounted drives like `G:\Mon Drive\` (Google Drive Desktop). Configure NSSM to run as your user:

```powershell
.\scripts\service\nssm.exe set NanoClaw ObjectName ".\YOUR_USERNAME" "YOUR_PASSWORD"
Restart-Service NanoClaw
```

Or use a system-wide mount (symlink Google Drive into a machine-accessible path).
