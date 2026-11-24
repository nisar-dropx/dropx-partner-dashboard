# Run this ONCE (no admin needed) to set up the Windows Task Scheduler jobs.
# Node.js must be installed and in PATH.
#
# BEFORE RUNNING: set $workerDir below to the folder where you put the files.
# On tabgafoo that is often C:\ppi-worker or D:\ppi-worker.

$workerDir = "C:\ppi-worker"
$nodeExe   = (Get-Command node -ErrorAction Stop).Source
$script    = Join-Path $workerDir "fetch.mjs"
$monitor   = Join-Path $workerDir "site-summary-monitor.mjs"
$logFile   = Join-Path $workerDir "run.log"
$siteLog   = Join-Path $workerDir "site-summary.log"

if (-not (Test-Path $script)) { throw "Missing $script — set `$workerDir correctly." }
if (-not (Test-Path $monitor)) { throw "Missing $monitor — copy site-summary-monitor.mjs into $workerDir first." }

# No -RunLevel Highest so it works without admin
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew `
  -Hidden

# ── PPI every 30 minutes ───────────────────────────────────────────────────────
$wrapperArg = "/c node `"$script`" >> `"$logFile`" 2>&1"
$actionPPI = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wrapperArg -WorkingDirectory $workerDir
$trigger30 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-PPI" `
  -Action $actionPPI `
  -Trigger $trigger30 `
  -Settings $settings `
  -Force | Out-Null

Write-Host "PPI task registered: runs every 30 minutes."
Write-Host "Log file: $logFile"

# ── Inbound every 60 minutes ───────────────────────────────────────────────────
$wrapperArgInbound = "/c node `"$script`" --inbound >> `"$logFile`" 2>&1"
$actionInbound = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wrapperArgInbound -WorkingDirectory $workerDir
$trigger60 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 60) -Once -At (Get-Date)

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-Inbound" `
  -Action $actionInbound `
  -Trigger $trigger60 `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Inbound task registered: runs every 60 minutes."

# ── Site Summary monitor: long-running loop (do NOT open a PowerShell window) ─
# Starts at user logon and keeps polling every POLL_INTERVAL_SECONDS (default 60).
# Firefox must stay logged into Site Summary so Mons cookies stay fresh.
$wrapperArgSite = "/c node `"$monitor`" >> `"$siteLog`" 2>&1"
$actionSite = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $wrapperArgSite -WorkingDirectory $workerDir
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$settingsSite = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -Hidden

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-SiteSummary" `
  -Action $actionSite `
  -Trigger $triggerLogon `
  -Settings $settingsSite `
  -Force | Out-Null

Write-Host "Site Summary monitor registered: starts at logon and stays running."
Write-Host "Log file: $siteLog"
Write-Host "Done."
Write-Host ""
Write-Host "Start Site Summary now:  Start-ScheduledTask 'DropX-DarkStore-SiteSummary'"
Write-Host "Check Site Summary log:  Get-Content '$siteLog' -Tail 40"
Write-Host "Stop Site Summary:       Stop-ScheduledTask 'DropX-DarkStore-SiteSummary'"
