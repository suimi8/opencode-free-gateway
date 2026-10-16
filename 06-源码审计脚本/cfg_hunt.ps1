# 1) full /config from the engine  2) hunt for custom provider config files  3) grep bundle for /provider connected
$src = Get-Content "$PSScriptRoot\..\05-引擎与运行时探针\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"

Write-Output "===== /config (full) ====="
$cfg = Invoke-WebRequest -Uri "$base/config" -Headers $hdr -TimeoutSec 30
Write-Output ("len = " + $cfg.Content.Length)
$cfg.Content

Write-Output "`n===== candidate config files ====="
# 不写死用户名：全部从环境变量推导
$cands = @(
  "$env:USERPROFILE\.config\opencode\opencode.json",
  "$env:USERPROFILE\.config\opencode\opencode.jsonc",
  "$env:USERPROFILE\.config\opencode\config.json",
  "$env:USERPROFILE\opencode.json",
  "$env:USERPROFILE\opencode.jsonc",
  "$env:SystemDrive\opencode.json",
  "$env:SystemDrive\opencode.jsonc",
  "$env:APPDATA\ai.opencode.desktop\opencode.json"
)
foreach ($p in $cands) {
  if (Test-Path $p) { Write-Output ("FOUND " + $p + "  (" + (Get-Item $p).Length + " B)"); Write-Output ((Get-Content $p -Raw).Substring(0,[Math]::Min(1500,(Get-Content $p -Raw).Length))) }
  else { Write-Output ("absent " + $p) }
}
Write-Output "--- .config\opencode dir ---"
Get-ChildItem "$env:USERPROFILE\.config\opencode" -Recurse -Force | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize | Out-String -Width 200
