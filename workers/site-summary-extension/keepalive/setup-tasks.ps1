# DropX WorkSpaces Scheduled Tasks Setup — LOCAL MACHINE
# No admin required. Run once in a normal PowerShell window.
#
# Usage (local laptop where WorkSpaces client runs):
#   cd C:\keepalive
#   Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
#   .\setup-tasks.ps1

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

function Register-DropXTask {
  param(
    [string]$Name,
    [string]$Script,
    [int]$IntervalMinutes,
    [string]$Description
  )

  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$Script`""

  # -Once -At + RepetitionInterval: works without admin, same pattern as PPI worker
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

  Write-Host "  Registered: $Name (every ${IntervalMinutes} min)" -ForegroundColor Green
}

Write-Host "Registering tasks..."

Register-DropXTask `
  -Name "DropX-WorkSpaces-KeepAlive" `
  -Script $keepAliveScript `
  -IntervalMinutes 3 `
  -Description "DropX: Keeps Amazon WorkSpaces client alive by tapping F15 every 3 minutes"

Register-DropXTask `
  -Name "DropX-WorkSpaces-LockAlert" `
  -Script $lockAlertScript `
  -IntervalMinutes 5 `
  -Description "DropX: Sends WhatsApp alert if WorkSpaces VM becomes locked"

Write-Host ""
Write-Host "Done! Both tasks registered." -ForegroundColor Green
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
