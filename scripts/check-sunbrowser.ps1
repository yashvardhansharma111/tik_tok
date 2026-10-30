# Checks whether the AdsPower browser kernel (SunBrowser) is downloaded and ready.
# Run this on any machine (RDP included) that has AdsPower installed.
#   powershell -ExecutionPolicy Bypass -File scripts\check-sunbrowser.ps1

$Base = if ($env:ADSPOWER_API_URL) { $env:ADSPOWER_API_URL.TrimEnd('/') } else { "http://local.adspower.net:50325" }

function Fail($m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

# 1. Is the Local API up? (AdsPower desktop must be open and logged in)
try { $s = Invoke-RestMethod -Uri "$Base/status" -TimeoutSec 10 }
catch { Fail "AdsPower Local API unreachable at $Base. Open the AdsPower app and sign in." }
if ($s.code -ne 0) { Fail "Local API returned: $($s.msg)" }
Write-Host "OK  : Local API reachable at $Base" -ForegroundColor Green

# 2. Grab a profile to probe with.
Start-Sleep -Milliseconds 1200   # Local API allows ~1 request/sec
$list = Invoke-RestMethod -Uri "$Base/api/v1/user/list?page=1&page_size=1" -TimeoutSec 20
if ($list.code -ne 0) { Fail "user/list failed: $($list.msg)" }
if (-not $list.data.list -or $list.data.list.Count -eq 0) { Fail "No profiles exist on this machine." }
$p = $list.data.list[0]
Write-Host "OK  : $($list.data.list.Count)+ profile(s) found; probing '$($p.name)'"

# 3. Probe. This is the exact call the upload automation makes, so it is authoritative.
Start-Sleep -Milliseconds 1200
$r = Invoke-RestMethod -Uri "$Base/api/v1/browser/start?user_id=$($p.user_id)" -TimeoutSec 120

if ($r.code -eq 0) {
    Write-Host "OK  : SunBrowser kernel is DOWNLOADED AND READY." -ForegroundColor Green
    Write-Host "      debug_port=$($r.data.debug_port)"
    Start-Sleep -Milliseconds 1200
    Invoke-RestMethod -Uri "$Base/api/v1/browser/stop?user_id=$($p.user_id)" -TimeoutSec 30 | Out-Null
    Write-Host "      (test browser closed)"
    exit 0
}

# Not ready: AdsPower reports progress in data.percent while downloading.
$pct = $r.data.percent
if ($null -ne $pct) {
    Write-Host "WAIT: kernel still downloading - $pct% complete." -ForegroundColor Yellow
} else {
    Write-Host "WAIT: kernel NOT ready." -ForegroundColor Yellow
}
Write-Host "      msg: $($r.msg)"
Write-Host "      Fix: open AdsPower -> Profiles -> click Open on any profile."
Write-Host "           That resumes the kernel download and shows progress."
exit 2
