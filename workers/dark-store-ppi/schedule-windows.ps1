# Run this ONCE (no admin needed) to set up the Windows Task Scheduler job.
# The task runs every 30 minutes, silently, in the background.
# Node.js must be installed and in PATH.
#
# BEFORE RUNNING: set $workerDir below to the folder where you put the files.

$workerDir = "C:\ppi-worker"   # ← change this if you extracted to a different folder
$nodeExe   = (Get-Command node -ErrorAction Stop).Source
$script    = Join-Path $workerDir "fetch.mjs"
$logFile   = Join-Path $workerDir "run.log"

# Log wrapper: node fetch.mjs >> run.log 2>&1
$wrapperArg = "/c node `"$script`" >> `"$logFile`" 2>&1"

# PPI every 30 minutes
$actionPPI = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument $wrapperArg `
  -WorkingDirectory $workerDir

$trigger30 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)

# No -RunLevel Highest so it works without admin
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew `
  -Hidden

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-PPI" `
  -Action $actionPPI `
  -Trigger $trigger30 `
  -Settings $settings `
  -Force | Out-Null

Write-Host "PPI task registered: runs every 30 minutes."
Write-Host "Log file: $logFile"

# Inbound shipments once per hour (with --inbound flag) — ready for when GC access is granted
$wrapperArgInbound = "/c node `"$script`" --inbound >> `"$logFile`" 2>&1"
$actionInbound = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument $wrapperArgInbound `
  -WorkingDirectory $workerDir

$trigger60 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 60) -Once -At (Get-Date)

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-Inbound" `
  -Action $actionInbound `
  -Trigger $trigger60 `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Inbound task registered: runs every 60 minutes."
Write-Host "Done."
Write-Host ""
Write-Host "To trigger immediately:  Start-ScheduledTask 'DropX-DarkStore-PPI'"
Write-Host "To check last run:       Get-Content '$logFile' -Tail 30"
