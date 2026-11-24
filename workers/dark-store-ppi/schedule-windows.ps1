# Run this ONCE (no admin needed) to set up the Windows Task Scheduler jobs.
# Node.js must be installed and in PATH.
#
# BEFORE RUNNING: set $workerDir below to the folder where you put the files.
# On tabgafoo that is often C:\ppi-worker or D:\ppi-worker.

$workerDir = "C:\ppi-worker"
$null = Get-Command node -ErrorAction Stop
$script    = Join-Path $workerDir "fetch.mjs"
$monitor   = Join-Path $workerDir "site-summary-monitor.mjs"
$logFile   = Join-Path $workerDir "run.log"
$siteLog   = Join-Path $workerDir "site-summary.log"

if (-not (Test-Path $script)) {
  throw "Missing $script - set workerDir correctly."
}
if (-not (Test-Path $monitor)) {
  throw "Missing $monitor - copy site-summary-monitor.mjs into $workerDir first."
}

# Current-user tasks only - no admin / AtLogOn elevation needed on WorkSpaces.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# No -RunLevel Highest so it works without admin
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -Hidden

function Register-DropXTask {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)]$Action,
    [Parameter(Mandatory = $true)]$Trigger,
    [Parameter(Mandatory = $true)]$Settings
  )
  try {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $Action `
      -Trigger $Trigger `
      -Settings $Settings `
      -Principal $principal `
      -Force | Out-Null
    Write-Host "OK  $TaskName"
    return $true
  } catch {
    Write-Host "FAIL $TaskName - $($_.Exception.Message)"
    return $false
  }
}

# PPI every 30 minutes
$wrapperArg = "/c node `"$script`" >> `"$logFile`" 2>&1"
$actionPPI = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wrapperArg -WorkingDirectory $workerDir
$trigger30 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)
Register-DropXTask -TaskName "DropX-DarkStore-PPI" -Action $actionPPI -Trigger $trigger30 -Settings $settings | Out-Null
Write-Host "  Log: $logFile"

# Inbound every 60 minutes
$wrapperArgInbound = "/c node `"$script`" --inbound >> `"$logFile`" 2>&1"
$actionInbound = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wrapperArgInbound -WorkingDirectory $workerDir
$trigger60 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 60) -Once -At (Get-Date)
Register-DropXTask -TaskName "DropX-DarkStore-Inbound" -Action $actionInbound -Trigger $trigger60 -Settings $settings | Out-Null

# Site Summary: --once every 1 minute (same permission model as PPI; no AtLogOn / long-running process).
# MultipleInstances IgnoreNew prevents overlap if a poll is still running.
$wrapperArgSite = "/c node `"$monitor`" --once >> `"$siteLog`" 2>&1"
$actionSite = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wrapperArgSite -WorkingDirectory $workerDir
$trigger1 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 1) -Once -At (Get-Date)
$settingsSite = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -Hidden
$siteOk = Register-DropXTask -TaskName "DropX-DarkStore-SiteSummary" -Action $actionSite -Trigger $trigger1 -Settings $settingsSite
Write-Host "  Log: $siteLog"
Write-Host ""

if ($siteOk) {
  Start-ScheduledTask -TaskName "DropX-DarkStore-SiteSummary"
  Start-Sleep -Seconds 3
  Write-Host "Started DropX-DarkStore-SiteSummary. Recent log:"
  if (Test-Path $siteLog) {
    Get-Content $siteLog -Tail 20
  } else {
    Write-Host "(log not written yet - wait one minute and run: Get-Content '$siteLog' -Tail 40)"
  }
} else {
  Write-Host "Site Summary task was NOT registered. Run PowerShell as the logged-in WorkSpaces user (no admin needed for this version)."
}

Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Start-ScheduledTask 'DropX-DarkStore-SiteSummary'"
Write-Host "  Get-ScheduledTask 'DropX-DarkStore-SiteSummary' | Get-ScheduledTaskInfo"
Write-Host "  Get-Content '$siteLog' -Tail 40"
Write-Host "  Stop-ScheduledTask 'DropX-DarkStore-SiteSummary'"
