# FlashTap install-time license check (run by the NSIS installer).
# Usage: powershell -File ft-license.ps1 <license-url-list> [key-from-cmdline]
# Exit codes: 0 valid | 2 cancelled | 3 invalid | 4 revoked | 5 unreachable | 6 error
# The HTTP check runs in a background job with a HARD timeout — PS 5.1's
# -TimeoutSec does not reliably cover a stalled TLS handshake, which would
# otherwise hang unattended installs forever.
param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$url = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { 'https://tiny.tail5f36c9.ts.net|http://192.168.110.8:3211' }
$fromSwitch = if ($args.Count -ge 2) { [string]$args[1] } else { '' }
$urls = $url.Split('|') | Where-Object { $_ }

function Test-LicenseServer([string]$u, [string]$bodyJson) {
  # Returns $resultHash on success, $null on hard-timeout or HTTP error.
  $job = Start-Job -ScriptBlock {
    param($uu, $bb)
    Invoke-RestMethod -Method Post -Uri ($uu.TrimEnd('/') + '/v1/install-check') `
      -ContentType 'application/json' -Body $bb -TimeoutSec 15 -UseBasicParsing
  } -ArgumentList $u, $bodyJson
  if (Wait-Job $job -Timeout 25) {
    $r = Receive-Job $job
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    return $r
  }
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  return $null
}

try {
  $reg = $null
  try { $reg = Get-ItemProperty -Path 'HKCU:\Software\FlashTap' -ErrorAction SilentlyContinue } catch {}

  $key = ''
  if ($fromSwitch) { $key = $fromSwitch.Trim().ToUpper() }
  if (-not $key) {
    $prefill = $null
    if ($reg -and $reg.LicenseKey) { $prefill = [string]$reg.LicenseKey }
    Add-Type -AssemblyName Microsoft.VisualBasic
    $input = [Microsoft.VisualBasic.Interaction]::InputBox(
      "Enter your FlashTap license key.`nFormat: FT-XXXXX-XXXXX-XXXXX`n`n(An internet connection is needed once to verify.)",
      'FlashTap Setup — License', $prefill)
    if ($null -eq $input) { exit 2 }               # user pressed Cancel
    $key = $input.Trim().ToUpper()
    if (-not $key) { exit 2 }                       # user pressed OK with nothing
  }

  $body = @{ key = $key } | ConvertTo-Json -Compress
  $resp = $null
  foreach ($u in $urls) {
    $resp = Test-LicenseServer $u $body
    if ($null -ne $resp) { break }
  }
  if ($null -eq $resp) { exit 5 }                   # no server reachable

  if ($resp.ok -and $resp.ok -eq $true) {
    if (-not (Test-Path 'HKCU:\Software\FlashTap')) { New-Item -Path 'HKCU:\Software\FlashTap' -Force | Out-Null }
    New-ItemProperty -Path 'HKCU:\Software\FlashTap' -Name LicenseKey -Value $key -PropertyType String -Force | Out-Null
    exit 0
  }
  if ($resp.reason -eq 'revoked') { exit 4 }
  exit 3                                            # unknown / malformed / anything else
} catch {
  exit 6
}
