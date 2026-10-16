<#
  OpenCode 免费层逆向与网关 —— 全量可用性自检
  ================================================================
  一键验证归集后的整个目录是否仍然可用：
    1. 目录结构完整性
    2. 全部 .mjs / .js 语法检查（node --check）
    3. 全部 .ps1 语法检查
    4. 失效绝对路径扫描（应 0 处）
    5. 管理面板自检（含真实上游端到端调用）
    6. 直连客户端真实调用

  用法：
    powershell -ExecutionPolicy Bypass -File .\自检全部.ps1
    powershell -ExecutionPolicy Bypass -File .\自检全部.ps1 -SkipUpstream   # 跳过需要联网的两项
#>
[CmdletBinding()]
param(
  [switch]$SkipUpstream
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

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

$script:pass = 0; $script:fail = 0; $script:warn = 0
function Ok  ([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green;  $script:pass++ }
function Bad ([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:fail++ }
function Wrn ([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:warn++ }
function Sec ([string]$m) { Write-Host ""; Write-Host "── $m " -ForegroundColor Cyan -NoNewline; Write-Host ("─" * [Math]::Max(0, 58 - $m.Length)) -ForegroundColor DarkGray }

Write-Host ""
Write-Host "OpenCode 免费层逆向与网关 · 全量自检" -ForegroundColor White
Write-Host "根目录: $root" -ForegroundColor DarkGray
Write-Host ("时间  : " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ── 1. 目录结构 ────────────────────────────────────────────────
Sec '1/6 目录结构'
$expect = @(
  '01-管理面板', '02-直连客户端', '03-分析报告', '04-门禁判别实验',
  '05-引擎与运行时探针', '06-源码审计脚本', '07-原始证据', '09-服务端部署', '10-代理节点管理'
)
# 这两个是**第三方内容**，公开仓库里刻意不含（见 README「本仓库不包含什么」）
#   08-上游源码快照/          —— 上游自己的仓库，重复分发无意义
#   99-解包产物与运行时残留/   —— 第三方专有程序，不可再分发
$optional = @('08-上游源码快照', '99-解包产物与运行时残留')
foreach ($d in $expect) {
  $p = Join-Path $root $d
  if (Test-Path -LiteralPath $p -PathType Container) {
    $n = (Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue).Count
    Ok ("{0,-28} {1,6} 文件" -f $d, $n)
  } else { Bad "缺少目录: $d" }
}
foreach ($d in $optional) {
  $p = Join-Path $root $d
  if (Test-Path -LiteralPath $p -PathType Container) {
    $n = (Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue).Count
    Ok ("{0,-28} {1,6} 文件（第三方，可选）" -f $d, $n)
  } else {
    Ok ("{0,-28} 未包含（第三方内容，公开仓库刻意排除）" -f $d)
  }
}
$req = @(
  '01-管理面板\server.mjs', '01-管理面板\db.mjs', '01-管理面板\upstream.mjs',
  '01-管理面板\body_template.json', '01-管理面板\public\index.html',
  '01-管理面板\启动面板.cmd', '01-管理面板\停止面板.cmd',
  '02-直连客户端\ocfree_client.mjs', '02-直连客户端\body_template.json',
  '02-直连客户端\proxies.txt',
  '03-分析报告\00-SYNTHESIS.md', '03-分析报告\10-POSITIVE-RESULT.md',
  '04-门禁判别实验\captured_body.json',
  '07-原始证据\data\opencode-models.txt'
)
$missing = @($req | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
if ($missing.Count -eq 0) { Ok "关键文件齐备 ($($req.Count) 项)" }
else { Bad ("关键文件缺失: " + ($missing -join ', ')) }

# ── 2. JS 语法 ────────────────────────────────────────────────
Sec '2/6 JavaScript 语法检查'
$skipRe = '^\\(08-上游源码快照|99-解包产物与运行时残留)\\'
$js = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.Extension -eq '.mjs' -or $_.Extension -eq '.js') -and
        ($_.FullName.Substring($root.Length) -notmatch $skipRe)
      }
$jsBad = @()
foreach ($f in $js) {
  $out = & $node --check $f.FullName 2>&1
  if ($LASTEXITCODE -ne 0) { $jsBad += "$($f.Name): $($out -join ' ')" }
}
if ($jsBad.Count -eq 0) { Ok "$($js.Count)/$($js.Count) 个 JS 文件语法通过" }
else { Bad "$($jsBad.Count)/$($js.Count) 个文件语法失败"; $jsBad | ForEach-Object { Write-Host "         $_" -ForegroundColor Red } }

# 2b. 工作目录无关性：禁止裸相对路径读写文件（换 cwd 就会崩）
$cwdPat = "(readFileSync|writeFileSync|appendFileSync|readFile|createReadStream)\(\s*'[^'./\\]"
$cwdBad = @()
foreach ($f in $js) {
  $m = @(Select-String -LiteralPath $f.FullName -Pattern $cwdPat -ErrorAction SilentlyContinue)
  foreach ($x in $m) { $cwdBad += ("{0}:{1}  {2}" -f $f.Name, $x.LineNumber, $x.Line.Trim()) }
}
if ($cwdBad.Count -eq 0) { Ok "全部 JS 脚本均与工作目录无关（无裸相对路径）" }
else { Bad "发现 $($cwdBad.Count) 处依赖 cwd 的裸相对路径:"; $cwdBad | ForEach-Object { Write-Host "         $_" -ForegroundColor Red } }

# ── 3. PS1 语法 ───────────────────────────────────────────────
Sec '3/6 PowerShell 语法检查'
$ps1 = Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.ps1 -ErrorAction SilentlyContinue |
       Where-Object { $_.FullName.Substring($root.Length) -notmatch $skipRe }
$psBad = @()
foreach ($f in $ps1) {
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs) | Out-Null
  if ($errs -and $errs.Count) { $psBad += "$($f.Name): $($errs[0].Message)" }
}
if ($psBad.Count -eq 0) { Ok "$($ps1.Count)/$($ps1.Count) 个 PS1 文件语法通过" }
else { Bad "$($psBad.Count)/$($ps1.Count) 个文件语法失败"; $psBad | ForEach-Object { Write-Host "         $_" -ForegroundColor Red } }

# ── 4. 失效路径扫描 ───────────────────────────────────────────
Sec '4/6 失效绝对路径扫描'
# 08 / 99 是第三方快照与解包产物，内部路径不是我们的
$skipScan = @('08-上游源码快照', '99-解包产物与运行时残留')
# 根 README 的「路径迁移对照表」、各目录 README 的迁移说明、以及本脚本自身，必然包含旧路径字符串
$allowScan = @(
  (Join-Path $root 'README.md'),
  (Join-Path $root '自检全部.ps1'),
  (Join-Path $root '03-分析报告\README.md'),
  (Join-Path $root '07-原始证据\README.md'),
  (Join-Path $root '99-解包产物与运行时残留\README.md')
)
$scanFiles = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\')
    $top = ($rel -split '\\')[0]
    ($skipScan -notcontains $top) -and
    ($allowScan -notcontains $_.FullName) -and
    ($_.Extension -in '.mjs', '.js', '.ps1', '.cmd', '.json', '.md', '.txt')
  }
# 只匹配「带路径形状」的旧位置签名，避免把 enginestate / ocfree-client 这类普通词误判
$pat = '%TEMP%\\ocfree|%TEMP%\\ocdesk|AppData\\Local\\Temp\\ocfree|AppData\\Local\\Temp\\ocdesk|[^\\]+\\ocfree-panel|[^\\]+\\ocfree-client|ocfree[\\/]enginestate'
try { [void][regex]::new($pat) } catch { Bad "扫描正则无效: $($_.Exception.Message)"; $pat = $null }
$hits = @()
if ($pat) {
  foreach ($f in $scanFiles) {
    try { $m = @(Select-String -LiteralPath $f.FullName -Pattern $pat -ErrorAction Stop) }
    catch { Bad "无法扫描 $($f.Name): $($_.Exception.Message)"; continue }
    if ($m.Count) { $hits += ("{0} ({1} 处)" -f $f.Name, $m.Count) }
  }
}
if ($pat -and $hits.Count -eq 0) { Ok "扫描 $($scanFiles.Count) 个文件，0 处失效路径残留" }
elseif ($hits.Count) { Bad "发现 $($hits.Count) 个文件含旧路径:"; $hits | ForEach-Object { Write-Host "         $_" -ForegroundColor Red } }

# 4b. 硬编码绝对路径守卫
#     操作性文件（脚本/配置/页面）必须 0 处；文档只提示（里面可能引用取证原文）
$allowAbs = @(
  (Join-Path $root '04-门禁判别实验\captured_body.json'),            # 逐字取证原件，刻意保持原样（含当时的真实路径）
  (Join-Path $root '01-管理面板\body_template.json'),                # 已脱敏：用户名替换为中性占位值
  (Join-Path $root '02-直连客户端\body_template.json'),
  (Join-Path $root '01-管理面板\body_template_responses.json')       # 同上（Responses 格式版本）
)
# 前面加「非单词字符」守卫，避免把 Env:\PANEL_PORT、active:\s* 这类误判成盘符路径
$absPat  = '(^|[^A-Za-z0-9_])[A-Za-z]:\\'
$opExt   = @('.mjs', '.js', '.ps1', '.cmd', '.html', '.json')
$docExt  = @('.md', '.txt')
$opHits = @(); $docHits = @()
foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FullName.Substring($root.Length) -notmatch $skipRe -and
      $allowAbs -notcontains $_.FullName
    })) {
  $ext = $f.Extension.ToLower()
  if (($opExt -notcontains $ext) -and ($docExt -notcontains $ext)) { continue }
  try { $m = @(Select-String -LiteralPath $f.FullName -Pattern $absPat -ErrorAction Stop) } catch { continue }
  if (-not $m.Count) { continue }
  $rel  = $f.FullName.Substring($root.Length).TrimStart('\')
  $line = ("{0} ({1} 处，例: {2})" -f $rel, $m.Count, $m[0].Line.Trim())
  if ($opExt -contains $ext) { $opHits += $line } else { $docHits += $line }
}
if ($opHits.Count -eq 0) { Ok "操作性文件 0 处硬编码绝对路径" }
else { Bad "操作性文件含硬编码绝对路径:"; $opHits | ForEach-Object { Write-Host "         $_" -ForegroundColor Red } }

# 文档命中里，迁移对照表与取证原文引用属预期；其余才提示
# 注意：$docHits 的元素形如 "rel (N 处，例: ...)"，所以只能锚在文件名后面的 " ("，不能用行尾锚
$docAllow = 'README\.md \(|03-runtime-evidence\.md \(|07-local-server-path\.md \(|08-upstream-auth\.md \('
$docReal  = @($docHits | Where-Object { $_ -notmatch $docAllow })
if ($docReal.Count -eq 0) { Ok "文档 0 处非预期绝对路径（迁移表/取证引用已豁免）" }
else { Wrn "文档含 $($docReal.Count) 处绝对路径（请确认是否为取证原文引用）"; $docReal | ForEach-Object { Write-Host "         $_" -ForegroundColor Yellow } }

# 4c. 生产模板脱敏：三个模板都不得含真实用户名，且结构完整
#     chat 模板两份（01/02 各一，都是 38,763 字符）+ Responses 模板一份
$tmpl = @(
  @{ p = '01-管理面板\body_template.json';           len = 38763; kind = 'chat' },
  @{ p = '02-直连客户端\body_template.json';         len = 38763; kind = 'chat' },
  @{ p = '01-管理面板\body_template_responses.json'; len = 38594; kind = 'responses' }
)
foreach ($t in $tmpl) {
  $bt = Join-Path $root $t.p
  if (-not (Test-Path -LiteralPath $bt)) { Bad "缺少 $($t.p)"; continue }
  # 必须显式按 UTF-8 读，否则 Windows PowerShell 5.1 会按 ANSI 解码，中文字符数算错
  $raw = [System.IO.File]::ReadAllText($bt, [System.Text.Encoding]::UTF8)
  $bad = @()
  if ($env:USERNAME -and $raw -match [regex]::Escape($env:USERNAME)) { $bad += '仍含真实用户名' }
  if ($raw.Length -ne $t.len) { $bad += "字符数 $($raw.Length) ≠ $($t.len)" }
  try {
    $o = $raw | ConvertFrom-Json
    # 结构断言：门禁要的 agent 骨架必须在
    if ($t.kind -eq 'chat') {
      if (-not ($o.messages | Where-Object { $_.role -eq 'system' })) { $bad += '缺 system 消息' }
      if (($o.tools | Measure-Object).Count -lt 12) { $bad += 'tools 少于 12 个' }
      if ($o.stream -ne $true) { $bad += 'stream 非 true' }
    } else {
      if (-not $o.instructions -or $o.instructions.Length -lt 12000) { $bad += 'instructions 过短（门禁要完整 system prompt）' }
      if (($o.tools | Measure-Object).Count -lt 12) { $bad += 'tools 少于 12 个' }
      if ($o.stream -ne $true) { $bad += 'stream 非 true' }
      if ($null -ne $o.max_tokens) { $bad += '含 max_tokens（Responses API 会拒）' }
    }
  } catch { $bad += 'JSON 不可解析' }
  if ($bad.Count -eq 0) { Ok ("{0}: 脱敏 + 结构 OK ({1} 字符)" -f (Split-Path $bt -Leaf), $raw.Length) }
  else { Bad ("{0}: {1}" -f (Split-Path $bt -Leaf), ($bad -join '; ')) }
}


# ── 5. 管理面板 ───────────────────────────────────────────────
Sec '5/6 管理面板自检'
$panelTest = Join-Path $root '01-管理面板\自检.ps1'
if (-not (Test-Path -LiteralPath $panelTest)) { Bad "缺少 01-管理面板\自检.ps1" }
else {
  & powershell -ExecutionPolicy Bypass -File $panelTest -Port 8799
  if ($LASTEXITCODE -eq 0) { Ok "管理面板 11 项子检查全部通过（含真实上游 200）" }
  else { Bad "管理面板自检未通过（退出码 $LASTEXITCODE）" }
}

# ── 6. 直连客户端 ─────────────────────────────────────────────
Sec '6/6 直连客户端'
if ($SkipUpstream) { Wrn "已跳过（-SkipUpstream）" }
else {
  Push-Location (Join-Path $root '02-直连客户端')
  try {
    $out = & $node ocfree_client.mjs --once --prompt 'Reply with exactly: PONG' `
             -m deepseek-v4.1-flash-free --timeout 90000 2>&1
    $txt = ($out | Out-String)
    if ($txt -match 'PONG') { Ok "直连调用成功 -> PONG" } else { Bad "直连调用异常: $($txt.Trim())" }
  } finally { Pop-Location }
}

# ── 汇总 ──────────────────────────────────────────────────────
Write-Host ""
Write-Host ("═" * 62) -ForegroundColor DarkGray
$color = if ($fail -eq 0) { 'Green' } else { 'Red' }
Write-Host ("  通过 $pass   失败 $fail   警告 $warn") -ForegroundColor $color
if ($fail -eq 0) {
  Write-Host "  目录已归集完成，所有组件可用 ✅" -ForegroundColor Green
} else {
  Write-Host "  存在失败项，请按上面 [FAIL] 逐项处理 ❌" -ForegroundColor Red
}
Write-Host ("═" * 62) -ForegroundColor DarkGray
exit ([int]($fail -gt 0))
