# Ground truth: dump the engine's live `opencode` provider entry exactly as the engine holds it.
$src = Get-Content "$PSScriptRoot\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"

Write-Output "===== /provider: connected + default ====="
$p = Invoke-RestMethod -Uri "$base/provider" -Headers $hdr -TimeoutSec 30
Write-Output ("default = " + ($p.default | ConvertTo-Json -Depth 4 -Compress))
Write-Output ("connected = " + ($p.connected | ConvertTo-Json -Depth 4 -Compress))
Write-Output ("all count = " + ($p.all | Measure-Object).Count)
$oc = $p.all | Where-Object { $_.id -eq 'opencode' }
if ($oc) {
  Write-Output "`n--- live opencode provider (from /provider) ---"
  Write-Output (($oc | ConvertTo-Json -Depth 6 -Compress) -replace '\s+',' ').Substring(0, [Math]::Min(1500, (($oc | ConvertTo-Json -Depth 6 -Compress) -replace '\s+',' ').Length))
} else { Write-Output "opencode provider NOT in /provider.all (ids: " + (($p.all | ForEach-Object { $_.id }) -join ', ') + ")" }

Write-Output "`n===== /api/provider: full opencode entry ====="
$ap = Invoke-RestMethod -Uri "$base/api/provider" -Headers $hdr -TimeoutSec 60
$entry = $ap.data | Where-Object { $_.id -eq 'opencode' }
if ($entry) {
  $j = $entry | ConvertTo-Json -Depth 8
  Write-Output ("entry length = " + $j.Length)
  # print everything except the huge models map
  $clone = $entry | Select-Object * -ExcludeProperty models
  Write-Output (($clone | ConvertTo-Json -Depth 8) )
  Write-Output ("model count = " + (($entry.models | Measure-Object).Count))
  $free = $entry.models | Where-Object { $_.id -like '*free*' } | Select-Object -First 3
  foreach ($f in $free) { Write-Output ("  free model entry: " + (($f | ConvertTo-Json -Depth 6 -Compress) -replace '\s+',' ')) }
} else {
  Write-Output ("opencode NOT found. ids: " + (($ap.data | ForEach-Object { $_.id }) -join ', '))
}
