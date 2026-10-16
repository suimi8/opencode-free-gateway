$src = Get-Content "$PSScriptRoot\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"

$sess = Invoke-RestMethod -Uri "$base/session" -Method Post -Headers $hdr -ContentType "application/json" -Body '{"title":"ocfree-engine-shell-probe"}' -TimeoutSec 30
$sid = $sess.id
Write-Output ("session = " + $sid)

$cmd = "& '$env:USERPROFILE\.openagents\nodejs\node.exe' '$PSScriptRoot\engine_side_probe.js' deepseek-v4.1-flash-free"
$body = @{ agent = 'build'; command = $cmd } | ConvertTo-Json -Depth 6
Write-Output "=== POST /session/{id}/shell (runs INSIDE the engine's process tree) ==="
try {
  $res = Invoke-RestMethod -Uri "$base/session/$sid/shell" -Method Post -Headers $hdr -ContentType "application/json" -Body $body -TimeoutSec 240
  $j = $res | ConvertTo-Json -Depth 12
  Write-Output $j
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output ("details: " + $_.ErrorDetails.Message) }
}

Write-Output "`n=== cleanup ==="
try { Invoke-RestMethod -Uri "$base/session/$sid" -Method Delete -Headers $hdr -TimeoutSec 30 | Out-Null; Write-Output "deleted" } catch { Write-Output ("delete failed: " + $_.Exception.Message) }
