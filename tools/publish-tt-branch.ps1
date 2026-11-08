<#
.SYNOPSIS
    把 TT 变体发布成一个独立分支，让 TT 酒馆也能「贴 git URL 一次装好」。

.DESCRIPTION
    TT 的扩展安装支持匿名 http(s) Git + 指定分支/标签，但不支持 ZIP、submodule、LFS。
    默认分支（main）放的是标准版（st-bridge 依赖酒馆内部 /script.js）；把 dist/tt 的产物
    推成一个孤儿分支 `tt` 后，TT 用户安装时填：

        https://github.com/<owner>/<repo>
        分支：tt

    本脚本只做「构建 + 在临时目录建孤儿提交 + push 到 tt 分支」，不碰当前工作区与默认分支。

.EXAMPLE
    pwsh ./tools/publish-tt-branch.ps1 -RepoUrl https://github.com/you/rp-hub-unified -DryRun
    pwsh ./tools/publish-tt-branch.ps1 -RepoUrl https://github.com/you/rp-hub-unified
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [string]$Branch = 'tt',
    [string]$CommitMessage = 'chore(tt): publish TT variant build',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host '[1/4] 构建 TT 变体…'
& node (Join-Path $repoRoot 'tools\build-variant.mjs') --target tt
if ($LASTEXITCODE -ne 0) { throw 'build-variant 失败（先修构建，再发布）' }

$dist = Join-Path $repoRoot 'dist\tt'
if (-not (Test-Path (Join-Path $dist 'manifest.json'))) { throw "产物缺少 manifest.json：$dist" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rphub-tt-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host '[2/4] 在临时目录准备孤儿提交…'
    Get-ChildItem -LiteralPath $dist -Force | Copy-Item -Destination $tmp -Recurse -Force

    Push-Location $tmp
    try {
        git init -q
        git checkout -q -b $Branch
        git add -A
        git -c user.name='rphub-build' -c user.email='rphub-build@local' commit -q -m $CommitMessage
        $count = (git rev-list --count HEAD)
        Write-Host "      提交完成：1 个孤儿提交，含 $count 个历史点"

        Write-Host '[3/4] 校验 BUILD.json（build-variant 已做跨目录 import 扫描，这里只读结论）'
        $buildJsonPath = Join-Path $tmp 'BUILD.json'
        if (-not (Test-Path $buildJsonPath)) { throw '产物缺少 BUILD.json' }
        $buildInfo = Get-Content $buildJsonPath -Raw | ConvertFrom-Json
        if ($buildInfo.variant -ne 'tt') { throw "BUILD.json 变体不是 tt：$($buildInfo.variant)" }
        if ($buildInfo.externalImports -ne 0) { throw "仍存在 $($buildInfo.externalImports) 处跨目录 import" }
        Write-Host '      OK（externalImports = 0）'

        Write-Host "[4/4] 推送到 $RepoUrl 的 $Branch 分支…"
        if ($DryRun) {
            Write-Host "      [DryRun] git push --force $RepoUrl ${Branch}:${Branch}"
            Write-Host "      [DryRun] 完成（未实际推送）"
        } else {
            git push --force $RepoUrl "${Branch}:${Branch}"
            Write-Host "      已推送。TT 安装时填：$RepoUrl ，分支：$Branch"
        }
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '下一步：'
Write-Host "  · TT 酒馆 → 扩展 → Install extension → URL: $RepoUrl ，Branch: $Branch"
Write-Host '  · 装完刷新，控制台应出现「[rphub] 已装载 TT 变体 st-bridge（tt-ctx）」'
