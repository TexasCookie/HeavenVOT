#Requires -Version 5.1
<#
.SYNOPSIS
  Install AetherVox local-gateway Native Messaging host + Windows Startup autostart.

.PARAMETER ExtensionId
  Chrome/Edge unpacked extension ID (32 lowercase a-p letters).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-native-host.ps1 -ExtensionId hahmikdmlljponehehlenndplbkjnalh
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  [switch]$NoStartup
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostPy = Join-Path $Root 'native_host.py'
$AutoCmd = Join-Path $Root 'autostart.cmd'
$HostName = 'com.aethervox.local_gateway'
$ManifestPath = Join-Path $Root "$HostName.json"

if (-not (Test-Path $HostPy)) { throw "native_host.py missing: $HostPy" }

function Resolve-AetherVoxPython {
  $candidates = @(
    (Join-Path $Root '.venv\Scripts\python.exe'),
    (Join-Path $env:USERPROFILE '.venv\aethervox-gw\Scripts\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  foreach ($name in @('python', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $src = $cmd.Source
    if ($src -and ($src -notmatch 'WindowsApps') -and (Test-Path $src)) { return $src }
  }
  throw 'Python not found (install Python 3.12 or create tools/local-voice-gateway/.venv)'
}

$Python = Resolve-AetherVoxPython
Write-Host "Using Python: $Python"

$LauncherBat = Join-Path $Root 'native_host_launcher.bat'
$bat = "@echo off`r`n`"$Python`" `"$HostPy`" %*`r`n"
[System.IO.File]::WriteAllText($LauncherBat, $bat)

$pathJson = $LauncherBat.Replace('\', '\\')
$json = @"
{
  "name": "$HostName",
  "description": "AetherVox local voice gateway controller",
  "path": "$pathJson",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@
[System.IO.File]::WriteAllText($ManifestPath, $json)

function Set-NmKey([string]$RegPath) {
  New-Item -Path $RegPath -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name '(default)' -Value $ManifestPath -PropertyType String -Force | Out-Null
}

Set-NmKey "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
Set-NmKey "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
Set-NmKey "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"

Write-Host "Native host installed: $HostName"
Write-Host "  manifest: $ManifestPath"
Write-Host "  extension: chrome-extension://$ExtensionId/"

if (-not $NoStartup) {
  $Startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $Link = Join-Path $Startup 'AetherVox Local Gateway.lnk'
  $w = New-Object -ComObject WScript.Shell
  $sc = $w.CreateShortcut($Link)
  $sc.TargetPath = $AutoCmd
  $sc.WorkingDirectory = $Root
  $sc.WindowStyle = 7
  $sc.Description = 'AetherVox local voice gateway autostart'
  $sc.Save()
  Write-Host "Startup shortcut: $Link"
}

& cmd /c "`"$AutoCmd`""
Write-Host 'Done. Reload the extension, then press Check Local.'
