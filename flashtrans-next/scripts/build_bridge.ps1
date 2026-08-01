﻿# 构建独立 CT2 翻译桥接 flashtrans-bridge.exe（用户免装 Python）
# 前提：仓库根 .venv 已安装 requirements-bridge.txt 与 pyinstaller
#   ..\.venv\Scripts\pip install -r requirements-bridge.txt pyinstaller
# 输出：flashtrans-next\installer\bridge-dist\flashtrans-bridge\
$ErrorActionPreference = "Stop"

$appRoot = Split-Path $PSScriptRoot -Parent           # flashtrans-next\
$venvPy = Join-Path $appRoot "..\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Error "找不到 $venvPy —— 请先在仓库根目录创建 .venv 并安装 requirements-bridge.txt"
}

& $venvPy -m PyInstaller --noconfirm `
    --distpath (Join-Path $appRoot "installer\bridge-dist") `
    --workpath (Join-Path $appRoot "installer\bridge-work") `
    (Join-Path $appRoot "installer\bridge.spec")

if ($LASTEXITCODE -ne 0) { Write-Error "PyInstaller 构建失败（exit $LASTEXITCODE）" }

$exe = Join-Path $appRoot "installer\bridge-dist\flashtrans-bridge\flashtrans-bridge.exe"
if (Test-Path $exe) {
    Write-Host "OK: $exe" -ForegroundColor Green
    Write-Host "冒烟测试：echo {""op"":""ping""} | & '$exe' serve"
} else {
    Write-Error "构建产物缺失：$exe"
}
