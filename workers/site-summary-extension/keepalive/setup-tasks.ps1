# DropX WorkSpaces Scheduled Tasks Setup — LOCAL MACHINE
# No admin required. Run once in a normal PowerShell window.
#
# Usage (local machine where WorkSpaces client runs):
#   cd C:\keepalive
#   .\setup-tasks.ps1
#
# Uses wscript.exe as a silent launcher so no terminal window ever flashes.

$scriptDir = $PSScriptRoot

Write-Host ""
Write-Host "DropX WorkSpaces Task Setup (Local)" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Script folder: $scriptDir" -ForegroundColor Gray
Write-Host ""

$keepAliveScript = Join-Path $scriptDir "keepalive.ps1"
$lockAlertScript = Join-Path $scriptDir "lock-alert.ps1"

if (-not (Test-Path $keepAliveScript)) { Write-Host "MISSING: $keepAliveScript" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $lockAlertScript)) { Write-Host "MISSING: $lockAlertScript" -ForegroundColor Red; exit 1 }

# Write a tiny .vbs wrapper for each script — wscript runs it with no window at all
function Write-SilentLauncher([string]$psScript) {
  $vbsPath = [System.IO.Path]::ChangeExtension($psScript, ".vbs")
  $escaped = $psScript.Replace('"', '""')
  $vbs = @"
' Silent launcher — no terminal window
CreateObject("WScript.Shell").Run "powershell.exe -NonInteractive -ExecutionPolicy Bypass -File """ & "$escaped" & """", 0, False
"@
  [System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::ASCII)
  return $vbsPath
}

$keepAliveVbs = Write-SilentLauncher $keepAliveScript
$lockAlertVbs = Write-SilentLauncher $lockAlertScript
Write-Host "  Created silent launchers (.vbs)" -ForegroundColor Gray

function Register-DropXTask {
  param(
    [string]$Name,
    [string]$VbsScript,
    [int]$IntervalMinutes,
    [string]$Description
  )

  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

  # wscript.exe /B = batch mode (no dialog boxes), launches vbs with zero UI
  $action = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "/B `"$VbsScript`""

  # -Once -At + RepetitionInterval: works without admin (same as PPI worker)
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -Hidden

  Register-ScheduledTask `
    -TaskName $Name `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $Description `
    -Force | Out-Null

  Write-Host "  Registered: $Name (every ${IntervalMinutes} min, silent)" -ForegroundColor Green
}

Write-Host "Registering tasks..."

Register-DropXTask `
  -Name "DropX-WorkSpaces-KeepAlive" `
  -VbsScript $keepAliveVbs `
  -IntervalMinutes 3 `
  -Description "DropX: Keeps Amazon WorkSpaces client alive by tapping F15 every 3 minutes"

Register-DropXTask `
  -Name "DropX-WorkSpaces-LockAlert" `
  -VbsScript $lockAlertVbs `
  -IntervalMinutes 5 `
  -Description "DropX: Sends WhatsApp alert if WorkSpaces VM becomes locked"

Write-Host ""
Write-Host "Done! Both tasks registered — fully silent, no window flash." -ForegroundColor Green
Write-Host ""
Write-Host "IMPORTANT: Edit lock-alert.ps1 and fill in your WA_TOKEN." -ForegroundColor Yellow
Write-Host ""
Write-Host "To verify:" -ForegroundColor Cyan
Write-Host "  schtasks /query /tn DropX-WorkSpaces-KeepAlive"
Write-Host "  schtasks /query /tn DropX-WorkSpaces-LockAlert"
Write-Host ""
Write-Host "To run immediately:"
Write-Host "  Start-ScheduledTask 'DropX-WorkSpaces-KeepAlive'"
Write-Host "  Start-ScheduledTask 'DropX-WorkSpaces-LockAlert'"
Write-Host ""
Write-Host "To check keepalive log:"
Write-Host ("  Get-Content " + (Join-Path $scriptDir "keepalive.log") + " -Tail 20")
