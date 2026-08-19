$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $PSScriptRoot "..\..\native-host"))) {
  $root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
}
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$py = Join-Path $root ".venv\Scripts\python.exe"
$env:PYTHONPATH = Join-Path $root "native-host"
$harness = Start-Process -FilePath $py -ArgumentList @((Join-Path $PSScriptRoot "harness.py")) -PassThru -WindowStyle Hidden
try {
  $ok = $false
  foreach ($i in 1..25) {
    Start-Sleep -Milliseconds 200
    try {
      $null = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:18766/watch" -TimeoutSec 1
      $ok = $true
      break
    } catch {}
  }
  if (-not $ok) { throw "harness did not start" }
  $click = Join-Path $PSScriptRoot "click.mjs"
  node $click
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($harness -and -not $harness.HasExited) { Stop-Process -Id $harness.Id -Force -ErrorAction SilentlyContinue }
}
