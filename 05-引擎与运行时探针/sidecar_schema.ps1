# Inspect engine API schemas and provider list, then create a throwaway session.
$src = Get-Content "$PSScriptRoot\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"
function Get-Json($p) { try { return Invoke-RestMethod -Uri "$base$p" -Headers $hdr -TimeoutSec 25 } catch { return "ERR: $($_.Exception.Message)" } }

Write-Output "===== /provider top-level ====="
$prov = Get-Json "/provider"
if ($prov -is [string]) { Write-Output $prov } else {
  Write-Output ("keys: " + ($prov.PSObject.Properties.Name -join ', '))
  if ($prov.all) { Write-Output ("all providers: " + ($prov.all.PSObject.Properties.Name -join ', ')) }
}

Write-Output "`n===== /config/providers ====="
$cp = Get-Json "/config/providers"
if ($cp -is [string]) { Write-Output $cp } else { Write-Output ("keys: " + ($cp.PSObject.Properties.Name -join ', ')) }

Write-Output "`n===== /api/provider (opencode search) ====="
$ap = Get-Json "/api/provider"
if ($ap -is [string]) { Write-Output $ap } else {
  $json = $ap | ConvertTo-Json -Depth 6 -Compress
  Write-Output ("len=" + $json.Length)
  $m = [regex]::Matches($json, '"opencode"')
  Write-Output ("occurrences of the opencode key: " + $m.Count)
  Write-Output ($json.Substring(0, [Math]::Min(700, $json.Length)))
}

Write-Output "`n===== schemas ====="
$doc = Get-Json "/doc"
foreach ($p in @('/session','/session/{sessionID}/message','/session/{sessionID}/shell','/api/session/{sessionID}/prompt')) {
  if ($doc -is [string]) { Write-Output $doc; break }
  $item = $doc.paths.$p
  if (-not $item) { Write-Output "--- $p : NOT FOUND"; continue }
  foreach ($verb in $item.PSObject.Properties.Name) {
    $op = $item.$verb
    $rb = $op.requestBody
    if ($rb) {
      $schema = $rb.content.'application/json'.schema
      Write-Output ("--- $verb $p  required=" + ($schema.required -join ',') + " props=" + (($schema.properties.PSObject.Properties.Name) -join ','))
      foreach ($pr in $schema.properties.PSObject.Properties) {
        $d = $pr.Value
        $t = if ($d.type) { $d.type } elseif ($d.'$ref') { $d.'$ref' } else { '?' }
        Write-Output ("      {0}: {1} {2}" -f $pr.Name, $t, ($d.enum -join '|'))
      }
    } else { Write-Output ("--- $verb $p  (no body)") }
  }
}
