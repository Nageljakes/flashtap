# FlashTap install-time license check (run by the NSIS installer, headless).
# Usage: powershell -File ft-license.ps1 <license-url-list> [key-from-cmdline]
# Exit codes: 0 valid | 3 invalid | 4 revoked | 5 unreachable | 6 error
#
# No UI here on purpose — in interactive installs the key is typed on a real
# NSIS wizard page (installer.nsh); in silent installs /KEY= is passed in.
# The HTTP check runs in a background job with a HARD timeout — PS 5.1's
# -TimeoutSec does not reliably cover a stalled TLS handshake.
param()
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$log = Join-Path $env:TEMP 'FlashTap-Setup.log'
function Log([string]$m) {
  try { Add-Content -Path $log -Value ("ft-license: " + $m) -ErrorAction SilentlyContinue } catch {}
}

Log ("start urls='" + $args[0] + "' keySwitch=" + ($(if ($args.Count -ge 2 -and $args[1]) { 'yes' } else { 'no' })))

$url = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { 'https://tiny.tail5f36c9.ts.net|http://192.168.110.8:3211' }
$fromSwitch = if ($args.Count -ge 2) { [string]$args[1] } else { '' }
$urls = $url.Split('|') | Where-Object { $_ }

function Test-LicenseServer([string]$u, [string]$bodyJson) {
  # Returns the parsed response on success, $null on hard-timeout or HTTP error.
  $job = Start-Job -ScriptBlock {
    param($uu, $bb)
    Invoke-RestMethod -Method Post -Uri ($uu.TrimEnd('/') + '/v1/install-check') `
      -ContentType 'application/json' -Body $bb -TimeoutSec 12 -UseBasicParsing
  } -ArgumentList $u, $bodyJson
  # NOTE: a failed job (timeout / refused / TLS error) makes Receive-Job
  # RETHROW the job's error — guard it or the whole check dies with exit 6.
  if (Wait-Job $job -Timeout 15) {
    $r = $null
    try { $r = Receive-Job $job } catch { Log ("job error from " + $u + ": " + $_.Exception.Message) }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    if ($null -ne $r) { return $r }
    return $null
  }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  Log ("timeout contacting " + $u)
  return $null
}

try {
  $key = ''
  if ($fromSwitch) { $key = $fromSwitch.Trim().ToUpper() }

  if (-not $key) { Log 'no key provided'; exit 3 }
  if ($key -notmatch '^FT-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$') {
    Log ("key failed format check: " + $key)
    exit 3
  }

  $body = @{ key = $key } | ConvertTo-Json -Compress
  $resp = $null
  foreach ($u in $urls) {
    Log ("trying " + $u)
    $resp = Test-LicenseServer $u $body
    if ($null -ne $resp) { Log ("responded: " + ($resp | ConvertTo-Json -Compress)); break }
  }
  if ($null -eq $resp) { Log 'no server reachable'; exit 5 }   # no server reachable

  if ($resp.ok -eq $true) {
    if (-not (Test-Path 'HKCU:\Software\FlashTap')) { New-Item -Path 'HKCU:\Software\FlashTap' -Force | Out-Null }
    New-ItemProperty -Path 'HKCU:\Software\FlashTap' -Name LicenseKey -Value $key -PropertyType String -Force | Out-Null
    Log 'key valid - saved to HKCU'
    exit 0
  }
  if ($resp.reason -eq 'revoked') { Log 'key revoked'; exit 4 }
  Log ("key rejected: " + $resp.reason)
  exit 3                                            # unknown / malformed / anything else
} catch {
  Log ("exception: " + $_.Exception.Message)
  exit 6
}
