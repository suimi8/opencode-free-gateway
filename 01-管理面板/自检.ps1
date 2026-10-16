<#
  管理面板自检脚本（归集后可用性验证）
  用法：  powershell -ExecutionPolicy Bypass -File .\自检.ps1
  行为： 临时启动 server.mjs（独立端口），逐项验证 API，结束后自动关闭。
         不会影响已在 8790 上运行的面板实例。
#>
[CmdletBinding()]
param(
  [int]$Port = 8799,
  [string]$Password = 'admin123',
  [string]$Token = $env:PANEL_TEST_TOKEN,   # 不内置任何令牌；为空时下面会自动创建一个
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

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

$logOut = Join-Path $env:TEMP 'ocpanel-selftest.out.log'
$logErr = Join-Path $env:TEMP 'ocpanel-selftest.err.log'
$pass = 0; $fail = 0

function Check([string]$name, [scriptblock]$body) {
  try {
    $r = & $body
    Write-Host ("  [OK]   {0}  ->  {1}" -f $name, $r) -ForegroundColor Green
    $script:pass++
  } catch {
    Write-Host ("  [FAIL] {0}  ->  {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
    $script:fail++
  }
}

Write-Host "=== 管理面板自检 ===" -ForegroundColor Cyan
Write-Host "目录 : $here"
Write-Host "端口 : $Port"
Write-Host ""

foreach ($f in 'server.mjs','db.mjs','upstream.mjs','body_template.json','public\index.html') {
  if (-not (Test-Path -LiteralPath (Join-Path $here $f))) { throw "缺少文件: $f" }
}
Write-Host "  [OK]   必需文件齐备 (server.mjs / db.mjs / upstream.mjs / body_template.json / public\index.html)" -ForegroundColor Green
$pass++

# 语法检查
$syntax = & $node --check (Join-Path $here 'server.mjs') 2>&1
if ($LASTEXITCODE -ne 0) { throw "server.mjs 语法错误: $syntax" }
Write-Host "  [OK]   node --check server.mjs" -ForegroundColor Green
$pass++

$env:PANEL_PORT = "$Port"
$proc = Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $here `
  -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru -WindowStyle Hidden

try {
  $base = "http://127.0.0.1:$Port"
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if ($proc.HasExited) { break }
    try { Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch {}
  }
  if (-not $up) {
    Write-Host "  [FAIL] 服务未在 20s 内监听 $Port" -ForegroundColor Red
    if (Test-Path $logErr) { Get-Content $logErr -Tail 30 | Write-Host }
    $fail++
  } else {
    Write-Host "  [OK]   服务已监听 $base" -ForegroundColor Green; $pass++

    $sess = $null
    Check 'GET /  (管理面板 HTML)' {
      $r = Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 5
      "HTTP $($r.StatusCode), $($r.Content.Length) 字节"
    }
    Check 'POST /api/login' {
      $body = @{ password = $Password } | ConvertTo-Json -Compress
      $r = Invoke-RestMethod -Uri "$base/api/login" -Method Post -Body $body `
           -ContentType 'application/json' -SessionVariable s -TimeoutSec 5
      $script:sess = $s
      if (-not $r.ok) { throw "ok=false" }
      '{"ok":true}'
    }
    # 测试令牌：优先参数 / $env:PANEL_TEST_TOKEN；都没有就现场建一个（公开仓库不内置任何凭据）
    Check 'GET|POST /api/tokens (取得测试令牌)' {
      if (-not $Token) {
        $tk = Invoke-RestMethod -Uri "$base/api/tokens" -WebSession $script:sess -TimeoutSec 5
        $first = @($tk.rows | Where-Object { $_.status -eq 1 }) | Select-Object -First 1
        if (-not $first) {
          $nb = @{ name = 'selftest'; unlimited = $true } | ConvertTo-Json -Compress
          $first = Invoke-RestMethod -Uri "$base/api/tokens" -Method Post -Body $nb `
                   -ContentType 'application/json' -WebSession $script:sess -TimeoutSec 5
        }
        if (-not $first -or -not $first.key) { throw '无法取得测试令牌' }
        $script:Token = $first.key
      }
      $Token.Substring(0, 8) + '…'
    }
    Check 'GET /api/channels' {
      $r = Invoke-RestMethod -Uri "$base/api/channels" -WebSession $sess -TimeoutSec 5
      "$($r.rows.Count) 个渠道"
    }
    Check 'GET /api/tokens' {
      $r = Invoke-RestMethod -Uri "$base/api/tokens" -WebSession $sess -TimeoutSec 5
      "$($r.rows.Count) 个令牌"
    }
    Check 'GET /api/stats' {
      $r = Invoke-RestMethod -Uri "$base/api/stats" -WebSession $sess -TimeoutSec 5
      "统计正常"
    }
    Check 'GET /v1/models  (OpenAI 兼容)' {
      $r = Invoke-RestMethod -Uri "$base/v1/models" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 10
      "$($r.data.Count) 个模型"
    }
    Check 'POST /v1/chat/completions  (端到端真实上游调用)' {
      $body = @{
        model    = 'deepseek-v4.1-flash-free'
        stream   = $false
        messages = @(@{ role = 'user'; content = 'Reply with exactly: PONG' })
      } | ConvertTo-Json -Depth 6 -Compress
      $r = Invoke-RestMethod -Uri "$base/v1/chat/completions" -Method Post -Body $body `
           -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 90
      $c = $r.choices[0].message.content
      if ($c -notmatch 'PONG') { throw "内容异常: $c" }
      "HTTP 200 model=$($r.model) content=`"$($c.Trim())`" usage=$($r.usage.prompt_tokens)/$($r.usage.completion_tokens)/$($r.usage.total_tokens)"
    }
    Check 'POST /v1/chat/completions  (流式)' {
      $body = @{
        model    = 'deepseek-v4.1-flash-free'
        stream   = $true
        messages = @(@{ role = 'user'; content = 'Reply with exactly: PONG' })
      } | ConvertTo-Json -Depth 6 -Compress
      $r = Invoke-WebRequest -Uri "$base/v1/chat/completions" -Method Post -Body $body `
           -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 90 -UseBasicParsing
      $chunks = ([regex]::Matches($r.Content, 'data: ')).Count
      if ($chunks -lt 2) { throw "SSE 分片过少: $chunks" }
      "HTTP $($r.StatusCode), $chunks 个 SSE 分片"
    }
    # read 守卫：门禁要求 tools 里有 name === "read"，面板无条件补上。
    # 调用方清空 tools、或发与模板同名的工具（重名会让上游 400），都必须仍然 200。
    Check 'POST /v1/chat/completions  (read 守卫 + 同名工具去重)' {
      $dup = @{ type = 'function'; function = @{ name = 'bash'; description = 'run'; parameters = @{ type = 'object'; properties = @{} } } } | ConvertTo-Json -Depth 8 -Compress
      $body = "{`"model`":`"deepseek-v4.1-flash-free`",`"stream`":true,`"messages`":[{`"role`":`"user`",`"content`":`"Reply with exactly: PONG`"}],`"tools`":[$dup]}"
      $r = Invoke-WebRequest -Uri "$base/v1/chat/completions" -Method Post -Body $body `
           -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 90 -UseBasicParsing
      if ($r.StatusCode -ne 200) { throw "HTTP $($r.StatusCode)" }
      if ($r.Content -notmatch 'PONG') { throw '回复里没有 PONG' }
      'HTTP 200（tools 被补上 read；同名 bash 已去重，不再触发上游 400）'
    }
    # /v1/responses：Codex 用的协议。muse-spark-1.3-contributor-free 只支持这个协议，
    # 且门禁要求 tools 里有 read（Responses 格式是扁平的 name 字段）。
    Check 'POST /v1/responses  (Codex 协议 + muse-spark 端到端)' {
      $body = @{
        model    = 'muse-spark-1.3-contributor-free'
        stream   = $true
        store    = $false
        input    = @(@{ type = 'message'; role = 'user'; content = @(@{ type = 'input_text'; text = 'Reply with exactly: PONG' }) })
        tools    = @(@{ type = 'function'; name = 'shell'; description = 'run a shell command'
                        parameters = @{ type = 'object'; properties = @{ command = @{ type = 'string' } }; required = @('command') } })
        tool_choice = 'auto'
        instructions = 'You are a coding agent.'
      } | ConvertTo-Json -Depth 10 -Compress
      $r = Invoke-WebRequest -Uri "$base/v1/responses" -Method Post -Body $body `
           -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 120 -UseBasicParsing
      $ev = ([regex]::Matches($r.Content, 'event: ')).Count
      if ($ev -lt 2) { throw "SSE 事件过少: $ev" }
      if ($r.Content -notmatch 'response\.completed') { throw '未见 response.completed 事件' }
      "HTTP $($r.StatusCode), $ev 个 SSE 事件, 含 response.completed"
    }
    # 桥接：客户端协议与模型原生协议不一致时，由 bridge.mjs 互转 —— 两种协议都能用所有模型
    Check 'POST /v1/responses  (桥接：chat 原生模型也能用)' {
      $body = @{
        model  = 'deepseek-v4.1-flash-free'
        stream = $true
        input  = @(@{ type = 'message'; role = 'user'; content = @(@{ type = 'input_text'; text = 'Reply with exactly: PONG' }) })
      } | ConvertTo-Json -Depth 10 -Compress
      $r = Invoke-WebRequest -Uri "$base/v1/responses" -Method Post -Body $body `
           -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 120 -UseBasicParsing
      if ($r.StatusCode -ne 200) { throw "HTTP $($r.StatusCode)" }
      if ($r.Content -notmatch 'response\.completed') { throw '未见 response.completed' }
      'HTTP 200（responses 客户端 → chat 原生模型，bridge 已互转）'
    }
    Check 'POST /v1/chat/completions  (桥接：responses 原生模型也能用)' {
      $body = @{
        model    = 'muse-spark-1.3-contributor-free'
        stream   = $false
        messages = @(@{ role = 'user'; content = 'Reply with exactly: PONG' })
      } | ConvertTo-Json -Depth 6 -Compress
      $r = Invoke-RestMethod -Uri "$base/v1/chat/completions" -Method Post -Body $body `
           -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 120
      $c = $r.choices[0].message.content
      if ($c -notmatch 'PONG') { throw "内容异常: $c" }
      "HTTP 200（chat 客户端 → responses 原生模型，bridge 已互转）content=`"$($c.Trim())`""
    }
  }
} finally {
  if (-not $KeepRunning -and $proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "已关闭临时实例 (PID $($proc.Id))" -ForegroundColor DarkGray
  }
  Remove-Item Env:\PANEL_PORT -ErrorAction SilentlyContinue
}

Write-Host ""
if ($fail -eq 0) {
  Write-Host "自检结果: $pass 项全部通过 ✅" -ForegroundColor Green
  exit 0
} else {
  Write-Host "自检结果: $pass 项通过 / $fail 项失败 ❌" -ForegroundColor Red
  Write-Host "错误日志: $logErr" -ForegroundColor DarkGray
  exit 1
}
