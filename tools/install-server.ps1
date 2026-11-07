<#
.SYNOPSIS
    把合并版仓库里的 server/（Node 插件）装进 SillyTavern 的 plugins/ 目录，并打开 config.yaml 的开关。

.DESCRIPTION
    只有「桌面/自建 ST」需要这一步；TT酒馆（TauriTavern）没有 Node 服务端，
    前端 local/ 已经接管全部接口，不需要也不执行本脚本。

.EXAMPLE
    pwsh ./tools/install-server.ps1 -StPath "D:\SillyTavern" -Link
    pwsh ./tools/install-server.ps1 -StPath "D:\SillyTavern" -Uninstall
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StPath,
    [switch]$Link,
    [switch]$Uninstall,
    [switch]$SkipConfig
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $repoRoot 'server'
$stRoot = (Resolve-Path -LiteralPath $StPath).Path
$pluginsDir = Join-Path $stRoot 'plugins'
$targetDir = Join-Path $pluginsDir 'rp-hub-compat'
$configPath = Join-Path $stRoot 'config.yaml'

if (-not (Test-Path -LiteralPath (Join-Path $stRoot 'server.js'))) {
    throw "这不是 SillyTavern 根目录（找不到 server.js）：$stRoot"
}

function Remove-Target {
    if (Test-Path -LiteralPath $targetDir) {
        $item = Get-Item -LiteralPath $targetDir -Force
        if ($item.LinkType) {
            # 目录联接/符号链接：删链接本身，不动源
            (Get-Item -LiteralPath $targetDir -Force).Delete()
        } else {
            Remove-Item -LiteralPath $targetDir -Recurse -Force
        }
        Write-Host "已移除旧安装：$targetDir"
    }
}

if ($Uninstall) {
    Remove-Target
    Write-Host '卸载完成。config.yaml 的 enableServerPlugins 未改动（可能还有其它插件在用）。'
    exit 0
}

if (-not (Test-Path -LiteralPath $sourceDir)) { throw "合并仓库缺少 server/ 目录：$sourceDir" }
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
Remove-Target

if ($Link) {
    cmd /c mklink /J "$targetDir" "$sourceDir" | Out-Null
    Write-Host "已建立目录联接：$targetDir -> $sourceDir（改 server/ 立即生效，重启 ST 后加载）"
} else {
    Copy-Item -LiteralPath $sourceDir -Destination $targetDir -Recurse -Force
    Write-Host "已复制插件：$targetDir"
}

if (-not $SkipConfig) {
    if (Test-Path -LiteralPath $configPath) {
        Copy-Item -LiteralPath $configPath -Destination "$configPath.bak" -Force
        $lines = Get-Content -LiteralPath $configPath -Encoding UTF8
        $found = $false
        $updated = foreach ($line in $lines) {
            if ($line -match '^\s*enableServerPlugins\s*:') {
                $found = $true
                if ($line -match 'true') { $line } else { 'enableServerPlugins: true' }
            } else { $line }
        }
        if (-not $found) { $updated = @($updated) + 'enableServerPlugins: true' }
        Set-Content -LiteralPath $configPath -Encoding UTF8 -Value $updated
        Write-Host "config.yaml 已确保 enableServerPlugins: true（备份：$configPath.bak）"
    } else {
        Write-Warning "未找到 config.yaml，请手动加一行：enableServerPlugins: true"
    }
}

Write-Host ''
Write-Host '下一步：重启 SillyTavern（node server.js），然后验证：'
Write-Host "  GET http://127.0.0.1:8000/api/plugins/rp-hub-compat/v1/status"
Write-Host ''
Write-Host '注意：前端 local/ 是 auto 模式——插件在就用插件（服务器库，跨设备），'
Write-Host '      插件不在就自动落回浏览器 IndexedDB，两边接口完全一致。'
