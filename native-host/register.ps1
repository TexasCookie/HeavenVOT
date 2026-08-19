$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $here "com.lvt.host.json"
$cmd = Join-Path $here "lvt_host.cmd"
$doc = Get-Content $manifest -Raw | ConvertFrom-Json
# Native host path must be absolute on some Edge builds; keep relative in repo and expand at register time.
$runtime = @{
  name = $doc.name
  description = $doc.description
  path = $cmd
  type = $doc.type
  allowed_origins = $doc.allowed_origins
}
$installed = Join-Path $here "com.lvt.host.installed.json"
$runtime | ConvertTo-Json -Depth 5 | Set-Content -Path $installed -Encoding UTF8
$reg = "HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.lvt.host"
New-Item -Path $reg -Force | Out-Null
Set-ItemProperty -Path $reg -Name "(default)" -Value $installed
Write-Output "registered $installed"
