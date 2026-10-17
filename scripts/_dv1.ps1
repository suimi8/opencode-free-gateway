$ErrorActionPreference = 'Continue'
$RepoRoot = 'D:\source code\opencode-free-gateway'
$bashExe  = 'C:\Program Files\msys64\usr\bin\bash.exe'
$Port     = 18795
$BaseUrl  = "http://127.0.0.1:$Port"

docker rm -f ocgw-cifix 2>&1 | Out-Null
docker volume rm ocgw-cifix-data 2>&1 | Out-Null
Write-Host '=== build image ==='
docker build -f "$RepoRoot\09-*.tmp" -t x . 2>&1 | Out-Null

$dockerfile = Join-Path $RepoRoot '09-*'
$df = Get-ChildItem -LiteralPath (Join-Path $RepoRoot '09-*') -ErrorAction SilentlyContinue
$dfPath = Join-Path $RepoRoot '09-*-*-*\Dockerfile'
Write-Host '=== docker build ==='
docker build -f (Get-ChildItem -Recurse -Path $RepoRoot -Filter Dockerfile -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*09-*' } | Select-Object -First 1).FullName -t ocgw-cifix:test $RepoRoot 2>&1 | Select-Object -Last 1 | Out-Null
