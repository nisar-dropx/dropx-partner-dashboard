# DropX WorkSpaces Scheduled Tasks Setup
# Run once as Administrator to register both tasks.
#
# Usage:
#   Right-click PowerShell → "Run as Administrator"
#   cd C:\keepalive
#   Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
#   .\setup-tasks.ps1

$scriptDir = $PSScriptRoot

Write-Host ""
Write-Host "DropX WorkSpaces Task Setup" -ForegroundColor Cyan
Write-Host "=============================" -ForegroundColor Cyan

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host ""
  Write-Host "ERROR: Run this script as Administrator (right-click PowerShell > Run as Administrator)" -ForegroundColor Red
  exit 1
}

Write-Host ""
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

  # Remove old task if exists
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""

  # Trigger: at logon + repeat every N minutes indefinitely
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

  $principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

  $task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $Description

  Register-ScheduledTask -TaskName $Name -InputObject $task -Force | Out-Null

  # Set repetition via XML — most reliable in PS 5.1
  $xml = (schtasks /query /tn $Name /xml ONE 2>$null) -join "`n"
  if ($xml) {
    $xmlDoc = [xml]$xml
    $ns = "http://schemas.microsoft.com/windows/2004/02/mit/task"

    # Find the Triggers node and add repetition to existing trigger
    $triggersNode = $xmlDoc.Task.Triggers
    if ($triggersNode -and $triggersNode.HasChildNodes) {
      $firstTrigger = $triggersNode.FirstChild
      # Build Repetition element
      $rep = $xmlDoc.CreateElement("Repetition", $ns)
      $rep.InnerXml = "<Interval xmlns=`"$ns`">PT${IntervalMinutes}M</Interval><Duration xmlns=`"$ns`">P1D</Duration><StopAtDurationEnd xmlns=`"$ns`">false</StopAtDurationEnd>"
      $firstTrigger.AppendChild($rep) | Out-Null

      $tmpXml = Join-Path $env:TEMP "dropx_task_$Name.xml"
      $xmlDoc.Save($tmpXml)
      schtasks /create /tn $Name /xml $tmpXml /f 2>&1 | Out-Null
      Remove-Item $tmpXml -ErrorAction SilentlyContinue
    }
  }

  Write-Host "  Registered: $Name (every ${IntervalMinutes} min)" -ForegroundColor Green
}

Write-Host "Registering tasks..."

Register-DropXTask `
  -Name "DropX-WorkSpaces-KeepAlive" `
  -Script $keepAliveScript `
  -IntervalMinutes 3 `
  -Description "DropX: Keeps Amazon WorkSpaces session alive by tapping F15 every 3 minutes"

Register-DropXTask `
  -Name "DropX-WorkSpaces-LockAlert" `
  -Script $lockAlertScript `
  -IntervalMinutes 5 `
  -Description "DropX: Sends WhatsApp alert if WorkSpaces VM becomes locked"

Write-Host ""
Write-Host "Done! Both tasks registered." -ForegroundColor Green
Write-Host ""
Write-Host "IMPORTANT: Before the lock alert works, edit lock-alert.ps1 and" -ForegroundColor Yellow
Write-Host "           fill in your WA_TOKEN (same value as config.local.js)." -ForegroundColor Yellow
Write-Host ""
Write-Host "To verify:" -ForegroundColor Cyan
Write-Host "  schtasks /query /tn DropX-WorkSpaces-KeepAlive"
Write-Host "  schtasks /query /tn DropX-WorkSpaces-LockAlert"
Write-Host ""
Write-Host "To run immediately for testing:"
Write-Host "  schtasks /run /tn DropX-WorkSpaces-KeepAlive"
Write-Host "  schtasks /run /tn DropX-WorkSpaces-LockAlert"
