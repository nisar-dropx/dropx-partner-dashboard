# Run this ONCE (no admin needed) to set up the Windows Task Scheduler jobs.
# Node.js must be installed and in PATH.
#
# BEFORE RUNNING: set $workerDir below to the folder where you put the files.
# On tabgafoo that is often C:\ppi-worker or D:\ppi-worker.

$workerDir = "C:\ppi-worker"
$null = Get-Command node -ErrorAction Stop
$script    = Join-Path $workerDir "fetch.mjs"
$monitor   = Join-Path $workerDir "site-summary-monitor.mjs"
$hiddenVbs = Join-Path $workerDir "run-hidden.vbs"
$logFile   = Join-Path $workerDir "run.log"
$siteLog   = Join-Path $workerDir "site-summary.log"
$wscript   = Join-Path $env:SystemRoot "System32\wscript.exe"

if (-not (Test-Path $script)) {
  throw "Missing $script - set workerDir correctly."
}
if (-not (Test-Path $monitor)) {
  throw "Missing $monitor - copy site-summary-monitor.mjs into $workerDir first."
}

# Hidden launcher - Scheduled Task runs wscript so no cmd window pops up every minute.
@'
' Run a cmd line with no console window.
' Usage: wscript //B //Nologo run-hidden.vbs "cmd /c ..."
If WScript.Arguments.Count < 1 Then WScript.Quit 1
CreateObject("WScript.Shell").Run WScript.Arguments.Item(0), 0, True
'@ | Set-Content -Path $hiddenVbs -Encoding ASCII

# Current-user tasks only - no admin / AtLogOn elevation needed on WorkSpaces.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -Hidden

function New-HiddenCmdAction {
  param([Parameter(Mandatory = $true)][string]$CmdLine)
  # Quote the whole cmd line as a single wscript argument.
  $arg = "//B //Nologo `"$hiddenVbs`" `"$CmdLine`""
  return (New-ScheduledTaskAction -Execute $wscript -Argument $arg -WorkingDirectory $workerDir)
}

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

# PPI every 30 minutes (hidden)
$actionPPI = New-HiddenCmdAction -CmdLine "cmd /c node `"$script`" >> `"$logFile`" 2>&1"
$trigger30 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)
Register-DropXTask -TaskName "DropX-DarkStore-PPI" -Action $actionPPI -Trigger $trigger30 -Settings $settings | Out-Null
Write-Host "  Log: $logFile"

# Inbound every 60 minutes (hidden)
$actionInbound = New-HiddenCmdAction -CmdLine "cmd /c node `"$script`" --inbound >> `"$logFile`" 2>&1"
$trigger60 = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 60) -Once -At (Get-Date)
Register-DropXTask -TaskName "DropX-DarkStore-Inbound" -Action $actionInbound -Trigger $trigger60 -Settings $settings | Out-Null

# Site Summary: --once every 1 minute, hidden (no console flash)
$actionSite = New-HiddenCmdAction -CmdLine "cmd /c node `"$monitor`" --once >> `"$siteLog`" 2>&1"
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
  Write-Host "Started DropX-DarkStore-SiteSummary (hidden). Recent log:"
  if (Test-Path $siteLog) {
    Get-Content $siteLog -Tail 20
  } else {
    Write-Host "(log not written yet - wait one minute and run: Get-Content '$siteLog' -Tail 40)"
  }
} else {
  Write-Host "Site Summary task was NOT registered."
}

Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Start-ScheduledTask 'DropX-DarkStore-SiteSummary'"
Write-Host "  Get-ScheduledTask 'DropX-DarkStore-SiteSummary' | Get-ScheduledTaskInfo"
Write-Host "  Get-Content '$siteLog' -Tail 40"
Write-Host "  Stop-ScheduledTask 'DropX-DarkStore-SiteSummary'"
