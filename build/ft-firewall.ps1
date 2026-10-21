# FlashTap firewall rule helper (run by the NSIS installer, best effort).
# Usage: powershell -File ft-firewall.ps1 <install-dir>
# Adds ONE inbound allow rule for FlashTap.exe (all profiles) so phones on the
# venue Wi-Fi can reach the game server. Needs one UAC consent (none when the
# caller is already elevated). Exit codes:
# 0 rule added (or already correct) | 1 declined / failed
param([string]$InstallDir = '')

$log = Join-Path $env:TEMP 'FlashTap-Setup.log'
function Log([string]$m) {
  try { Add-Content -Path $log -Value ("ft-firewall: " + $m) -ErrorAction SilentlyContinue } catch {}
}

$exe = if ($InstallDir) { Join-Path $InstallDir 'FlashTap.exe' } else { Join-Path $PSScriptRoot 'FlashTap.exe' }
Log ("start exe=" + $exe)

if (-not (Test-Path $exe)) { Log 'exe not found - skipping'; exit 1 }

function Get-RulePrograms {
  # Program paths of all existing rules named "FlashTap" (may be several
  # after upgrades), or @() when none exist. Reading needs no elevation.
  # NOTE: the Program field only appears with `verbose` — plain `show rule`
  # omits it entirely, which made every lookup look empty.
  $out = netsh advfirewall firewall show rule name="FlashTap" verbose 2>$null
  if ($LASTEXITCODE -ne 0) { return @() }
  @($out | Where-Object { $_ -match '^\s*Program:\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() })
}

$existing = Get-RulePrograms
$stale = @($existing | Where-Object { $_ -ine $exe })
if ($existing.Count -gt 0 -and $stale.Count -eq 0) {
  Log 'rule already exists for this exe'
  exit 0
}
if ($stale.Count -gt 0) {
  # Stale rule from a previous install location (e.g. per-user AppData ->
  # Program Files upgrade): replace it, otherwise it only allows the OLD exe.
  Log ("stale rule(s) for " + ($stale -join ', ') + " - replacing")
}

# NOTE: Start-Process -ArgumentList joins array items with spaces and does
# NOT quote them — the program path MUST carry embedded quotes or paths with
# spaces ("C:\Program Files\...") get split and the rule points at C:\Program.
$addArgs = @(
  'advfirewall', 'firewall', 'add', 'rule',
  'name=FlashTap',
  'dir=in',
  'action=allow',
  'enable=yes',
  'profile=any',
  ('program="' + $exe + '"')
)

try {
  # Hidden so no console flashes behind the UAC consent dialog.
  if ($existing.Count -gt 0) {
    Start-Process -FilePath 'netsh' -ArgumentList @('advfirewall', 'firewall', 'delete', 'rule', 'name=FlashTap') `
      -Verb RunAs -Wait -WindowStyle Hidden | Out-Null
  }
  $p = Start-Process -FilePath 'netsh' -ArgumentList $addArgs -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  Log ("netsh elevated exit=" + $p.ExitCode)
  if ($p.ExitCode -ne 0) { exit 1 }
} catch {
  Log ("elevation declined or failed: " + $_.Exception.Message)
  exit 1
}

# verify (unelevated read) — rule must exist AND point at our exe
$now = Get-RulePrograms
if ($now | Where-Object { $_ -ieq $exe }) { Log 'rule verified'; exit 0 }
Log 'rule missing or wrong program after add'
exit 1
