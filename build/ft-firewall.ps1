# FlashTap firewall rule helper (run by the NSIS installer, best effort).
# Usage: powershell -File ft-firewall.ps1 <install-dir>
# Adds ONE inbound allow rule for FlashTap.exe (all profiles) so phones on the
# venue Wi-Fi can reach the game server. Needs one UAC consent; exit codes:
# 0 rule added (or already present) | 1 declined / failed
param([string]$InstallDir = '')

$log = Join-Path $env:TEMP 'FlashTap-Setup.log'
function Log([string]$m) {
  try { Add-Content -Path $log -Value ("ft-firewall: " + $m) -ErrorAction SilentlyContinue } catch {}
}

$exe = if ($InstallDir) { Join-Path $InstallDir 'FlashTap.exe' } else { Join-Path $PSScriptRoot 'FlashTap.exe' }
Log ("start exe=" + $exe)

if (-not (Test-Path $exe)) { Log 'exe not found - skipping'; exit 1 }

# Already there? (reading rules needs no elevation)
$existing = netsh advfirewall firewall show rule name="FlashTap" 2>$null
if ($LASTEXITCODE -eq 0 -and ($existing -join ' ') -match 'FlashTap') {
  Log 'rule already exists'
  exit 0
}

$args = @(
  'advfirewall', 'firewall', 'add', 'rule',
  'name=FlashTap',
  'dir=in',
  'action=allow',
  'enable=yes',
  'profile=any',
  "program=$exe"
)

try {
  # One UAC prompt; Hidden so no console flashes behind the consent dialog.
  $p = Start-Process -FilePath 'netsh' -ArgumentList $args -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  Log ("netsh elevated exit=" + $p.ExitCode)
  if ($p.ExitCode -ne 0) { exit 1 }
} catch {
  Log ("elevation declined or failed: " + $_.Exception.Message)
  exit 1
}

# verify (unelevated read)
$check = netsh advfirewall firewall show rule name="FlashTap" 2>$null
if ($LASTEXITCODE -eq 0) { Log 'rule verified'; exit 0 }
Log 'rule missing after add'
exit 1
