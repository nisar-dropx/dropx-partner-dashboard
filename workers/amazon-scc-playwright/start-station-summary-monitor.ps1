param(
  [switch]$WorkerOnly,
  [switch]$RunnerOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $Root "../..")
$EnvFile = Join-Path $Root ".env.station-summary"
$Example = Join-Path $Root ".env.station-summary.example"

if (-not (Test-Path $EnvFile)) {
  if (Test-Path $Example) {
    Copy-Item $Example $EnvFile
    Write-Host "Created $EnvFile — fill in secrets, then re-run this script."
    exit 1
  }
  throw "Missing $EnvFile"
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $eq = $line.IndexOf("=")
  if ($eq -lt 1) { return }
  $key = $line.Substring(0, $eq).Trim()
  $value = $line.Substring($eq + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  Set-Item -Path "Env:$key" -Value $value
}

if (-not $env:HEADLESS) { $env:HEADLESS = "false" }
if (-not $env:AMAZON_WORKER_URL) { $env:AMAZON_WORKER_URL = "http://127.0.0.1:8080" }
if (-not $env:AMAZON_CHECK_INTERVAL_MINUTES) { $env:AMAZON_CHECK_INTERVAL_MINUTES = "1" }

Push-Location $Root
try {
  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    npm install
  }

  if (-not $RunnerOnly) {
    Write-Host "Starting Amazon Site Summary worker on $($env:AMAZON_WORKER_URL) ..."
    $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
    if (-not $npmCmd) { $npmCmd = (Get-Command npm).Source }
    Start-Process -FilePath $npmCmd -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Normal
    Start-Sleep -Seconds 4
  }

  if ($WorkerOnly) {
    Write-Host "Worker started. Complete Amazon login in the browser window, then run without -WorkerOnly."
    return
  }

  Write-Host "Starting Site Summary monitor runner..."
  node (Join-Path $RepoRoot "scripts/run-amazon-station-summary.mjs")
}
finally {
  Pop-Location
}
