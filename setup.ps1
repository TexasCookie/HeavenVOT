$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$py = "C:\Users\Daniil\AppData\Local\Programs\Python\Python312\python.exe"
if (-not (Test-Path .\.venv\Scripts\python.exe)) {
  & $py -m venv .venv
}
$pip = ".\.venv\Scripts\python.exe"
& $pip -m pip install --upgrade pip
& $pip -m pip install -r requirements.txt
& $pip native-host\download_models.py
& $pip native-host\download_asr.py
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-host\register.ps1
Write-Output "setup complete"
