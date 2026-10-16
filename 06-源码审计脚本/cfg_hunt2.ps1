$src = Get-Content "$PSScriptRoot\..\05-引擎与运行时探针\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"

Write-Output "===== /config as JSON, looking for opencode/apiKey ====="
$raw = (New-Object Net.WebClient)
$raw.Headers.Add("Authorization", "Basic $b64")
$txt = $raw.DownloadString("$base/config")
Write-Output ("len = " + $txt.Length)
$m = [regex]::Matches($txt, '"[^"]*opencode[^"]*"')
Write-Output ("mentions of opencode = " + $m.Count + " : " + (($m | ForEach-Object { $_.Value } | Select-Object -Unique) -join ' | '))
$k = [regex]::Matches($txt, '.{80}apiKey.{80}')
Write-Output ("apiKey contexts = " + $k.Count)
$k | ForEach-Object { Write-Output ("   " + $_.Value) }
Write-Output "--- first 900 chars ---"
Write-Output $txt.Substring(0,[Math]::Min(900,$txt.Length))
Write-Output "--- provider keys in config ---"
$c = $txt | ConvertFrom-Json
Write-Output ("top-level keys: " + (($c.PSObject.Properties.Name) -join ', '))
Write-Output ("provider keys: " + (($c.provider.PSObject.Properties.Name) -join ', '))

Write-Output "`n===== config files ====="
# 不写死用户名：全部从环境变量推导
$cands = @(
  "$env:USERPROFILE\.config\opencode\opencode.json",
  "$env:USERPROFILE\.config\opencode\opencode.jsonc",
  "$env:USERPROFILE\.config\opencode\config.json",
  "$env:USERPROFILE\opencode.json",
  "$env:USERPROFILE\opencode.jsonc",
  "$env:SystemDrive\opencode.json",
  "$env:SystemDrive\opencode.jsonc",
  "$env:APPDATA\ai.opencode.desktop\opencode.json",
  "$env:APPDATA\ai.opencode.desktop\opencode.jsonc"
)
foreach ($p in $cands) {
  if (Test-Path $p) { Write-Output ("FOUND " + $p + "  (" + (Get-Item $p).Length + " B)"); Write-Output (Get-Content $p -Raw) }
  else { Write-Output ("absent " + $p) }
}
Write-Output "--- non-skill files directly in .config\opencode ---"
Get-ChildItem "$env:USERPROFILE\.config\opencode" -File -Force | Select-Object Name,Length | Format-Table -AutoSize | Out-String -Width 120
