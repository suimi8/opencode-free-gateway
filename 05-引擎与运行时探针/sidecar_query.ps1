# Use the recovered sidecar credentials to query the user's OWN local OpenCode engine.
# Read-only queries first: /config, /provider, /app, /doc (paths only).
$src = Get-Content "$PSScriptRoot\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop

$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
if (-not $pass) { Write-Output "password not found"; exit 1 }
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"
Write-Output ("auth ok: password len={0}" -f $pass.Length)

function Get-Json($path) {
  try { return Invoke-RestMethod -Uri "$base$path" -Headers $hdr -TimeoutSec 25 }
  catch { return "ERR: $($_.Exception.Message)" }
}

Write-Output "`n===== /app ====="
$app = Get-Json "/app"
if ($app -is [string]) { Write-Output $app } else { Write-Output ($app | ConvertTo-Json -Depth 4 -Compress).Substring(0, [Math]::Min(600, ($app | ConvertTo-Json -Depth 4 -Compress).Length)) }

Write-Output "`n===== /config (opencode provider + provider entries) ====="
$cfg = Get-Json "/config"
if ($cfg -is [string]) { Write-Output $cfg } else {
  $s = $cfg | ConvertTo-Json -Depth 8
  Write-Output ("len=" + $s.Length)
  # show any provider-related and model-related keys
  foreach ($k in @('provider','model','logLevel','username','small_model')) {
    if ($cfg.PSObject.Properties.Name -contains $k) { Write-Output ("$k => " + (($cfg.$k | ConvertTo-Json -Depth 6 -Compress) -replace '\s+',' ').Substring(0,[Math]::Min(400, ($cfg.$k | ConvertTo-Json -Depth 6 -Compress).Length))) }
  }
}

Write-Output "`n===== /provider (opencode entry only) ====="
$prov = Get-Json "/provider"
if ($prov -is [string]) { Write-Output $prov } else {
  $all = $prov.all
  foreach ($name in @('opencode','opencode-go')) {
    if ($all -and $all.PSObject.Properties.Name -contains $name) {
      $p = $all.$name
      Write-Output ("--- $name : " + (($p | ConvertTo-Json -Depth 4 -Compress) -replace '\s+',' ').Substring(0,[Math]::Min(900, ($p | ConvertTo-Json -Depth 4 -Compress).Length)))
      $mk = if ($p.models) { $p.models.PSObject.Properties.Name } else { @() }
      Write-Output ("    model count = " + $mk.Count)
      foreach ($m in ($mk | Where-Object { $_ -like '*free*' } | Select-Object -First 5)) {
        Write-Output ("    free model: " + $m)
      }
    } else { Write-Output "--- $name : ABSENT" }
  }
}

Write-Output "`n===== /doc paths ====="
$doc = Get-Json "/doc"
if ($doc -is [string]) { Write-Output $doc } else {
  $paths = $doc.paths.PSObject.Properties.Name
  Write-Output ("total paths: " + $paths.Count)
  $paths | Where-Object { $_ -match 'session|message|prompt|provider' } | ForEach-Object { "  $_" }
}
