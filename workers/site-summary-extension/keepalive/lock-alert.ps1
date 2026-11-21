# DropX WorkSpaces Lock Alert
# Runs every 5 minutes via Windows Task Scheduler.
# If the WorkSpaces window is gone or shows a lock/sign-in screen,
# sends a WhatsApp text alert to the ops lead so someone can unlock remotely.
#
# Task Scheduler action:
#   powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\DropX\keepalive\lock-alert.ps1"
#
# CONFIGURE: paste your WA_TOKEN below (copy from config.local.js)

$WA_URL       = "https://dropx-report-bot.onrender.com"
$WA_TOKEN     = ""   # <-- paste your token here (same as config.local.js WA_TOKEN)
$ALERT_TO     = "919645881397@s.whatsapp.net"
$COOLDOWN_MIN = 15
$WINDOW_TITLE = "Amazon WorkSpaces"

$stateFile = Join-Path $PSScriptRoot "lock-alert-state.json"
$logFile   = Join-Path $PSScriptRoot "lock-alert.log"

function Write-Log([string]$msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8
}

# Trim log
try {
  if (Test-Path $logFile) {
    $lines = Get-Content $logFile
    if ($lines.Count -gt 300) { $lines | Select-Object -Last 200 | Set-Content $logFile -Encoding UTF8 }
  }
} catch {}

if (-not $WA_TOKEN) {
  Write-Log "ERROR: WA_TOKEN not set — edit lock-alert.ps1 and add your token"
  exit 1
}

# ── Cooldown check ───────────────────────────────────────────────────────────
$lastAlertAt = [DateTime]::MinValue
try {
  if (Test-Path $stateFile) {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    if ($state.lastAlertAt) { $lastAlertAt = [DateTime]::Parse($state.lastAlertAt) }
  }
} catch {}

$minutesSinceLast = ([DateTime]::UtcNow - $lastAlertAt).TotalMinutes
if ($minutesSinceLast -lt $COOLDOWN_MIN) {
  Write-Log ("Cooldown active ({0:F1} min since last alert) — skipping" -f $minutesSinceLast)
  exit 0
}

# ── Check WorkSpaces window ──────────────────────────────────────────────────
$wsProcs = Get-Process | Where-Object {
  ($_.MainWindowTitle -like "*$WINDOW_TITLE*" -or $_.ProcessName -like "*workspaces*") -and
  $_.MainWindowHandle -ne [IntPtr]::Zero
}

$locked = $false
$reason = ""

if (-not $wsProcs) {
  $locked = $true
  $reason = "WorkSpaces process not found (crashed or closed)"
} else {
  foreach ($p in $wsProcs) {
    $title = $p.MainWindowTitle
    if ($title -match "(?i)(sign.?in|locked|lock screen|reconnect|disconnected|session expired)") {
      $locked = $true
      $reason = "WorkSpaces showing lock/sign-in screen: '$title'"
      break
    }
  }
}

if (-not $locked) {
  Write-Log "WorkSpaces OK — no alert needed"
  exit 0
}

# ── Send WhatsApp alert ──────────────────────────────────────────────────────
Write-Log "LOCKED — sending alert: $reason"

$nowIST  = (Get-Date).ToUniversalTime().AddHours(5.5)
$timeStr = $nowIST.ToString("HH:mm") + " IST"
$text    = "WorkSpaces VM appears locked at $timeStr`n$reason`nPlease unlock or reconnect."

$clientRef = "wslock_" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$body = @{
  client_ref = $clientRef
  to         = $ALERT_TO
  text       = $text
} | ConvertTo-Json

try {
  $headers = @{ "Authorization" = "Bearer $WA_TOKEN"; "Content-Type" = "application/json" }
  $resp = Invoke-RestMethod -Uri "$WA_URL/send" -Method POST -Headers $headers -Body $body -ErrorAction Stop
  Write-Log ("Alert sent OK — {0}" -f ($resp | ConvertTo-Json -Compress))

  @{ lastAlertAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content $stateFile -Encoding UTF8
} catch {
  Write-Log "ERROR sending alert: $_"
}
