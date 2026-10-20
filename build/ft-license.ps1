# FlashTap install-time license check (run by the NSIS installer).
# Usage: powershell -File ft-license.ps1 <license-url> [key-from-cmdline]
# Exit codes: 0 valid | 2 cancelled | 3 invalid | 4 revoked | 5 unreachable | 6 error
param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$url = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { 'https://tiny.tail5f36c9.ts.net|http://192.168.110.8:3211' }
$fromSwitch = if ($args.Count -ge 2) { [string]$args[1] } else { '' }
$urls = $url.Split('|') | Where-Object { $_ }

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
    try {
      $resp = Invoke-RestMethod -Method Post -Uri ($u.TrimEnd('/') + '/v1/install-check') `
        -ContentType 'application/json' -Body $body -TimeoutSec 15 -UseBasicParsing
      break
    } catch { $resp = $null }                       # next candidate
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
