# POSITIVE TEST: make the user's own local OpenCode engine perform a free-tier model call.
# Creates one throwaway session, sends one short prompt with a free model, then deletes the session.
$src = Get-Content "$PSScriptRoot\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"

Write-Output "=== 1) create throwaway session ==="
$sess = Invoke-RestMethod -Uri "$base/session" -Method Post -Headers $hdr -ContentType "application/json" -Body '{"title":"ocfree-positive-probe"}' -TimeoutSec 30
$sid = $sess.id
Write-Output ("session id = " + $sid)

Write-Output "`n=== 2) free-model prompt through the engine (opencode/deepseek-v4.1-flash-free) ==="
$body = @{
  model = @{ providerID = 'opencode'; modelID = 'deepseek-v4.1-flash-free' }
  agent = 'build'
  parts = @(@{ type = 'text'; text = 'Reply with exactly one word: PONG' })
} | ConvertTo-Json -Depth 8
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $res = Invoke-RestMethod -Uri "$base/session/$sid/message" -Method Post -Headers $hdr -ContentType "application/json" -Body $body -TimeoutSec 180
  $sw.Stop()
  Write-Output ("elapsed = " + $sw.Elapsed.TotalSeconds.ToString('F2') + " s")
  $json = $res | ConvertTo-Json -Depth 10 -Compress
  Write-Output ("response len = " + $json.Length)
  Write-Output ($json.Substring(0, [Math]::Min(1200, $json.Length)))
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output ("details: " + $_.ErrorDetails.Message) }
}

Write-Output "`n=== 3) cleanup: delete throwaway session ==="
try { Invoke-RestMethod -Uri "$base/session/$sid" -Method Delete -Headers $hdr -TimeoutSec 30 | Out-Null; Write-Output "deleted" } catch { Write-Output ("delete failed: " + $_.Exception.Message) }
