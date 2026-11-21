# DropX WorkSpaces Scheduled Tasks Setup — INSIDE WORKSPACES VM
# No admin required. Run once in a normal PowerShell window inside the VM.
#
# Usage (inside the WorkSpaces VM):
#   cd C:\keepalive
#   Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
#   .\setup-tasks-vm.ps1
#
# This keeps the VM itself alive so Amazon doesn't idle-disconnect it.
# Only keepalive.ps1 is needed inside the VM — no lock-alert.

$scriptDir = $PSScriptRoot

Write-Host ""
Write-Host "DropX WorkSpaces Task Setup (Inside VM)" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Script folder: $scriptDir" -ForegroundColor Gray
Write-Host ""

$keepAliveScript = Join-Path $scriptDir "keepalive.ps1"

if (-not (Test-Path $keepAliveScript)) { Write-Host "MISSING: $keepAliveScript" -ForegroundColor Red; exit 1 }

Unregister-ScheduledTask -TaskName "DropX-WorkSpaces-KeepAlive" -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$keepAliveScript`""

# -Once -At + RepetitionInterval: works without admin
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 3)

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -Hidden

Register-ScheduledTask `
  -TaskName "DropX-WorkSpaces-KeepAlive" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "DropX: Keeps WorkSpaces VM alive by tapping F15 every 3 minutes" `
  -Force | Out-Null

Write-Host "  Registered: DropX-WorkSpaces-KeepAlive (every 3 min)" -ForegroundColor Green
Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host ""
Write-Host "To verify:        schtasks /query /tn DropX-WorkSpaces-KeepAlive"
Write-Host "To run now:       Start-ScheduledTask 'DropX-WorkSpaces-KeepAlive'"
Write-Host "To check log:     Get-Content '$scriptDir\keepalive.log' -Tail 20"
