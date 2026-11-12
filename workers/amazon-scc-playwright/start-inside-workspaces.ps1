param(
  [switch]$InstallOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $Root "../..")
$EnvFile = Join-Path $Root ".env.station-summary"

Write-Host ""
Write-Host "Site Summary monitor must run INSIDE Amazon WorkSpaces."
Write-Host "1) Open Amazon WorkSpaces desktop app and log in"
Write-Host "2) Copy this folder into the WorkSpace (Desktop/USB/shared drive)"
Write-Host "3) Run this script from a PowerShell window inside the WorkSpace"
Write-Host "Firefox will open on the WorkSpaces desktop for Site Summary only."
Write-Host ""

if (-not (Test-Path $EnvFile)) {
  Copy-Item (Join-Path $Root ".env.station-summary.example") $EnvFile
  Write-Host "Created $EnvFile — fill secrets, then re-run."
  exit 1
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $eq = $line.IndexOf("=")
  if ($eq -lt 1) { return }
  $key = $line.Substring(0, $eq).Trim()
  $value = $line.Substring($eq + 1).Trim()
  Set-Item -Path "Env:$key" -Value $value
}

$env:HEADLESS = "false"
$env:AMAZON_CAPTURE_MODE = "dom"
$env:AMAZON_STATION_SUMMARY_BROWSER = "firefox"
if (-not $env:PORT) { $env:PORT = "8091" }
if (-not $env:AMAZON_WORKER_URL) { $env:AMAZON_WORKER_URL = "http://127.0.0.1:$($env:PORT)" }

Push-Location $Root
try {
  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    npm install
  }
  Write-Host "Installing Playwright Firefox (Site Summary only)..."
  npx playwright install firefox

  if ($InstallOnly) {
    Write-Host "Install complete."
    return
  }

  Write-Host "Starting Firefox Site Summary worker on $($env:AMAZON_WORKER_URL) ..."
  $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
  if (-not $npmCmd) { $npmCmd = (Get-Command npm).Source }
  Start-Process -FilePath $npmCmd -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Normal
  Start-Sleep -Seconds 4

  Write-Host "Starting monitor. Complete Amazon login once in the Firefox window."
  node (Join-Path $RepoRoot "scripts/run-amazon-station-summary.mjs")
}
finally {
  Pop-Location
}
