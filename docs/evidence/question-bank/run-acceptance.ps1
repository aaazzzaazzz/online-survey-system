<#
  题库功能浏览器验收脚本一键运行器（第 18 轮，独立可复现）

  用法（PowerShell）：
    cd docs\evidence\question-bank
    npm ci                                      # 仅首次：安装已验证版本的 puppeteer-core（25.14.0，见 package-lock.json）
    .\run-acceptance.ps1 -Script after-fix       # 重跑修复后回归（当前代码）
    .\run-acceptance.ps1 -Script before-fix      # 重跑第 15 轮旧脚本（当前代码上的新结果，不等于复现历史缺陷）

  说明：
    - 结果写入 runs\<时间戳>\（含截图与 results.json），不覆盖 before-fix / after-fix 中的历史证据；
    - 数据库保护：-DbName 必须匹配 survey_system_accept*，否则拒绝执行（survey_system /
      survey_system_test 等一律拒绝）；仅清理指定的验收库；
    - 清理顺序：先清空验收库，再启动验收服务（服务启动时自动重建全部索引），不出现索引缺失状态；
    - 只停止本脚本启动的验收服务进程（端口由 -Port 指定），不触碰其他服务；
    - 浏览器默认使用标准 Edge 安装路径，可用 -EdgePath 覆盖；地址可用 -BaseUrl 覆盖。
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('before-fix', 'after-fix')]
  [string]$Script,

  [string]$DbName = 'survey_system_accept',
  [int]$Port = 3999,
  [string]$EdgePath = '',
  [string]$BaseUrl = '',
  [switch]$NoReset
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$serverDir = Join-Path $repoRoot 'server'
$scriptFile = if ($Script -eq 'before-fix') { 'acceptance.js' } else { 'fix-regression.js' }
$scriptPath = Join-Path $PSScriptRoot ($(if ($Script -eq 'before-fix') { 'before-fix' } else { 'after-fix' }) + '\' + $scriptFile)

# —— 数据库名保护：只允许明确的验收库 ——
if ($DbName -notmatch '^survey_system_accept') {
  Write-Error "数据库保护：-DbName 只允许 survey_system_accept* 形式的独立验收库（收到: $DbName）。拒绝执行。"
  exit 2
}
Write-Host "目标验收库: $DbName（已通过库名保护）；端口: $Port"

# —— 依赖：使用已验证版本（package.json 锁定 25.14.0，lockfile 固定解析） ——
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules\puppeteer-core'))) {
  Write-Host '未检测到 puppeteer-core，执行 npm ci（按 package-lock.json 安装已验证版本）...'
  Push-Location $PSScriptRoot
  npm ci | Out-Null
  Pop-Location
}

# —— 清空验收库（在服务启动之前，服务启动时重建索引） ——
if (-not $NoReset) {
  Write-Host "清空验收库 $DbName（dropDatabase，仅在启动服务前执行）..."
  $eval = "db.getSiblingDB('$DbName').dropDatabase()"
  & mongosh --quiet --eval $eval 'mongodb://127.0.0.1:27017' | Out-Null
}

# —— 启动验收服务（仅本脚本启动的进程，稍后只停止它） ——
$env:MONGODB_DB = $DbName
$env:PORT = [string]$Port
$proc = Start-Process -FilePath 'node' -ArgumentList 'src/app.js' -WorkingDirectory $serverDir -PassThru -WindowStyle Hidden
Remove-Item Env:MONGODB_DB -ErrorAction SilentlyContinue
Remove-Item Env:PORT -ErrorAction SilentlyContinue
$base = if ($BaseUrl) { $BaseUrl } else { "http://127.0.0.1:$Port" }
Write-Host "验收服务已启动（PID $($proc.Id)，数据库 $DbName）"

# —— 等待端口就绪 ——
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $ok = curl.exe -s -o NUL -w '%{http_code}' "$base/login.html" 2>$null
  if ($ok -eq '200') { $ready = $true; break }
}
if (-not $ready) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Error "验收服务在 $base 未就绪，已停止本次启动的进程。"
  exit 3
}

# —— 运行目录：runs\<时间戳>\（不覆盖历史证据） ——
$runDir = Join-Path $PSScriptRoot ("runs\" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Script)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
Copy-Item $scriptPath (Join-Path $runDir $scriptFile)
Write-Host "本次运行目录: $runDir（新的执行结果，历史证据目录未被覆盖）"

# —— 执行脚本（cwd = 运行目录，依赖从上级 node_modules 解析） ——
$env:BASE_URL = $base
if ($EdgePath) { $env:EDGE_PATH = $EdgePath }
Push-Location $runDir
try {
  node $scriptFile
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:EDGE_PATH -ErrorAction SilentlyContinue
}

# —— 只停止本脚本启动的验收服务 ——
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Host "已停止本次启动的验收服务（PID $($proc.Id)）。"
Write-Host "结果与截图: $runDir"
exit $code
