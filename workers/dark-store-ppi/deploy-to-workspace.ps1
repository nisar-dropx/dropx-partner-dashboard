# Run this ONCE from your laptop (C:\Users\johna machine).
# It copies the worker to the workspace machine (tabgafoo) and registers the Task Scheduler job.
#
# Prerequisites:
#   1. The workspace machine must be reachable (Amazon Workspaces must be open/connected)
#   2. D:\ppi-worker\.env must exist on the workspace — the script creates a template if missing
#
# Usage:  .\deploy-to-workspace.ps1

$workerSrc  = "$PSScriptRoot"
$workspace  = "\\tsclient\D\ppi-worker"   # D: drive of workspace via RDP drive mapping
$workerDest = "D:\ppi-worker"             # path as seen FROM the workspace machine

# ── 1. Copy worker files to workspace ─────────────────────────────────────────
Write-Host "Copying worker files to workspace ($workspace)..."

if (-not (Test-Path $workspace)) {
  Write-Error "Cannot reach workspace at $workspace. Make sure RDP is connected and drive sharing is enabled (Local Resources > More > Drives)."
  exit 1
}

New-Item -ItemType Directory -Force -Path $workspace | Out-Null
Copy-Item "$workerSrc\fetch.mjs"           "$workspace\fetch.mjs"           -Force
Copy-Item "$workerSrc\package.json"        "$workspace\package.json"         -Force
Copy-Item "$workerSrc\schedule-windows.ps1" "$workspace\schedule-windows.ps1" -Force

# Create .env template on workspace if it doesn't exist yet
$envDest = "$workspace\.env"
if (-not (Test-Path $envDest)) {
  Write-Host "Creating .env template on workspace — fill in SUPABASE_SERVICE_KEY before first run."
  @"
SUPABASE_URL=https://uimajyffojydenqsegjv.supabase.co
SUPABASE_SERVICE_KEY=PASTE_SERVICE_ROLE_KEY_HERE
COMPANY_ID=43866344-b550-4e8a-9a2d-9d23f3d8a997
"@ | Set-Content $envDest -Encoding utf8
} else {
  Write-Host ".env already exists on workspace — not overwriting."
}

Write-Host "Files copied."

# ── 2. Register the scheduled task on the workspace via psexec / Invoke-Command ─
# Since we can't run remote PowerShell easily over RDP, print the one command to run on workspace.
Write-Host ""
Write-Host "============================================================"
Write-Host "FILES ARE ON THE WORKSPACE. Now do ONE more step:"
Write-Host ""
Write-Host "Open PowerShell ON THE WORKSPACE MACHINE and run:"
Write-Host ""
Write-Host "  powershell -ExecutionPolicy Bypass -File D:\ppi-worker\schedule-windows.ps1"
Write-Host ""
Write-Host "That registers the Task Scheduler job. Done — fully automatic after that."
Write-Host "============================================================"
Write-Host ""
Write-Host "Also: make sure the Supabase key is filled in at D:\ppi-worker\.env on the workspace."
Write-Host "To test immediately after setup:"
Write-Host "  Start-ScheduledTask 'DropX-DarkStore-PPI'"
Write-Host "  Get-Content D:\ppi-worker\run.log -Tail 30"
