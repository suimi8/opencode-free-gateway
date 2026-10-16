$src = Get-Content "$PSScriptRoot\read_env.ps1" -Raw
$typeDef = [regex]::Match($src, '(?s)\$src = @''(.*?)''@').Groups[1].Value
Add-Type -TypeDefinition $typeDef -ErrorAction Stop
$pid2 = (Get-CimInstance Win32_Process -Filter "Name like '%opencode%'" | Where-Object { $_.CommandLine -like '*NodeService*' }).ProcessId
$blob = [ProcEnv]::Get($pid2)
$pass = ($blob -split "`0" | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pass"))
$hdr = @{ Authorization = "Basic $b64" }
$base = "http://127.0.0.1:55434"

$sess = Invoke-RestMethod -Uri "$base/session" -Method Post -Headers $hdr -ContentType "application/json" -Body '{"title":"ocfree-engine-shell-probe2"}' -TimeoutSec 30
$sid = $sess.id
Write-Output ("session = " + $sid)

# 解析 node.exe：优先 $env:NODE_EXE → PATH → 常见安装位置。不写死单一绝对路径。
$node = $env:NODE_EXE
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  foreach ($c in @(
      "$env:ProgramFiles\nodejs\node.exe",
      "${env:ProgramFiles(x86)}\nodejs\node.exe",
      "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
      "$env:USERPROFILE\.openagents\nodejs\node.exe"
    )) { if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break } }
}
if (-not $node) { throw '找不到 node.exe。请安装 Node.js 并加入 PATH，或设置环境变量 NODE_EXE 指向 node.exe。' }

$cmd = "& '$node' '$PSScriptRoot\engine_side_probe.js' deepseek-v4.1-flash-free"
$body = @{ agent = 'build'; command = $cmd } | ConvertTo-Json -Depth 6
Write-Output ("command sent = " + $cmd)
try {
  $res = Invoke-RestMethod -Uri "$base/session/$sid/shell" -Method Post -Headers $hdr -ContentType "application/json" -Body $body -TimeoutSec 240
  $part = $res.parts | Where-Object { $_.type -eq 'tool' } | Select-Object -First 1
  Write-Output ("status = " + $part.state.status)
  Write-Output "----- OUTPUT -----"
  Write-Output $part.state.output
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output ("details: " + $_.ErrorDetails.Message) }
}
try { Invoke-RestMethod -Uri "$base/session/$sid" -Method Delete -Headers $hdr -TimeoutSec 30 | Out-Null; Write-Output "`n(deleted)" } catch { }
