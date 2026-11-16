# Run this ONCE as Administrator to set up the Windows Task Scheduler job.
# The task runs every 30 minutes, silently, in the background.
# Node.js must be installed and in PATH.

$workerDir = "C:\Users\johna\Desktop\Dropx Logistics\dashboard\production\dropx-partner-dashboard\workers\dark-store-ppi"
$nodeExe   = (Get-Command node -ErrorAction Stop).Source
$script    = Join-Path $workerDir "fetch.mjs"
$logFile   = Join-Path $workerDir "run.log"

# PPI every 30 minutes
$actionPPI = New-ScheduledTaskAction `
  -Execute $nodeExe `
  -Argument "$script 2>&1" `
  -WorkingDirectory $workerDir

$trigger30 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew `
  -Hidden

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-PPI" `
  -Action $actionPPI `
  -Trigger $trigger30 `
  -Settings $settings `
  -RunLevel Highest `
  -Force | Out-Null

Write-Host "PPI task registered: runs every 30 minutes."

# Inbound shipments once per hour (with --inbound flag)
$actionInbound = New-ScheduledTaskAction `
  -Execute $nodeExe `
  -Argument "$script --inbound 2>&1" `
  -WorkingDirectory $workerDir

$trigger60 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 60) -Once -At (Get-Date)

Register-ScheduledTask `
  -TaskName "DropX-DarkStore-Inbound" `
  -Action $actionInbound `
  -Trigger $trigger60 `
  -Settings $settings `
  -RunLevel Highest `
  -Force | Out-Null

Write-Host "Inbound task registered: runs every 60 minutes."
Write-Host "Done. To run immediately: Start-ScheduledTask 'DropX-DarkStore-PPI'"
