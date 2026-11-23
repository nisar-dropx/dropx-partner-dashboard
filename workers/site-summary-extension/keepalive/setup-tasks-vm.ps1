# DropX WorkSpaces Scheduled Tasks Setup — INSIDE WORKSPACES VM
# No admin required. Run once in a normal PowerShell window inside the VM.
#
# Usage (inside the WorkSpaces VM):
#   cd D:\keepalive   (or wherever you put the files)
#   .\setup-tasks-vm.ps1
#
# Uses wscript.exe as a silent launcher so no terminal window ever flashes.

$scriptDir = $PSScriptRoot

Write-Host ""
Write-Host "DropX WorkSpaces Task Setup (VM)" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "Script folder: $scriptDir" -ForegroundColor Gray
Write-Host ""

$keepAliveScript = Join-Path $scriptDir "keepalive.ps1"

if (-not (Test-Path $keepAliveScript)) { Write-Host "MISSING: $keepAliveScript" -ForegroundColor Red; exit 1 }

# Write a tiny .vbs wrapper — wscript runs it with zero window
$vbsPath = [System.IO.Path]::ChangeExtension($keepAliveScript, ".vbs")
$escaped = $keepAliveScript.Replace('"', '""')
$vbs = @"
' Silent launcher — no terminal window
CreateObject("WScript.Shell").Run "powershell.exe -NonInteractive -ExecutionPolicy Bypass -File """ & "$escaped" & """", 0, False
"@
[System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::ASCII)
Write-Host "  Created silent launcher: $vbsPath" -ForegroundColor Gray

Unregister-ScheduledTask -TaskName "DropX-WorkSpaces-KeepAlive" -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "/B `"$vbsPath`""

# -Once -At + RepetitionInterval: no admin needed
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

Write-Host "  Registered: DropX-WorkSpaces-KeepAlive (every 3 min, silent)" -ForegroundColor Green
Write-Host ""
Write-Host "Done! Task runs silently every 3 min — no window flash." -ForegroundColor Green
Write-Host ""
Write-Host "To verify:   schtasks /query /tn DropX-WorkSpaces-KeepAlive"
Write-Host "To run now:  Start-ScheduledTask 'DropX-WorkSpaces-KeepAlive'"
$logPath = Join-Path $scriptDir "keepalive.log"
Write-Host "To check log: Get-Content $logPath -Tail 20"
