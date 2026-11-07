<#
.SYNOPSIS
    用一次 PAT（或已登录的 gh）把合并仓库建到 GitHub 并推两个分支：main（标准版）+ tt（TT 变体）。

.DESCRIPTION
    为什么需要令牌：创建仓库与推送都属于“代表你”的操作，本机默认没有任何 GitHub 凭据。
    令牌只在本进程内使用，不写入 .git/config、不打印。

    用法（推荐：令牌放文件，避免进 shell 历史）：
        1) 在 GitHub → Settings → Developer settings → Personal access tokens 建一个
           classic token，勾选 `repo`（要私有仓库勾 `repo`，公开仓库同样勾 `repo`）；
        2) 存到  <workspace>\.pat  （单行文本，只有令牌本身）；
        3) pwsh ./tools/setup-github.ps1 -TokenFile ..\.pat

    完成后脚本会打印两个安装 URL 与 TT 的填法。
#>
[CmdletBinding()]
param(
    [string]$RepoName = 'SillyTavern-RP-Hub',
    [string]$Owner = '',
    [string]$TokenFile = '',
    [ValidateSet('public', 'private')][string]$Visibility = 'public',
    [string]$Description = 'RP-Hub 三合一：正则引擎 + 浏览器本地后端 + RP助手面板桥（SillyTavern / TauriTavern）',
    [switch]$SkipTTBranch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiBase = 'https://api.github.com'

function Read-Token {
    if ($TokenFile) {
        $p = (Resolve-Path -LiteralPath $TokenFile).Path
        $t = (Get-Content -LiteralPath $p -Raw).Trim()
        if (-not $t) { throw "令牌文件为空：$p" }
        return $t
    }
    if ($env:GH_TOKEN) { return $env:GH_TOKEN.Trim() }
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN.Trim() }
    throw '没有令牌：请用 -TokenFile <文件>，或先设置 $env:GH_TOKEN'
}

function Invoke-GitHub {
    param([string]$Method, [string]$Path, $Body, [string]$Token)
    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'rphub-setup'
    }
    $params = @{ Uri = "$apiBase$Path"; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 6)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    try { return Invoke-RestMethod @params }
    catch {
        $detail = $_.ErrorDetails.Message
        throw "GitHub API $Method $Path 失败：$($_.Exception.Message) $detail"
    }
}

$token = Read-Token
Write-Host '[1/6] 校验令牌…'
$me = Invoke-GitHub -Method GET -Path '/user' -Token $token
$login = $me.login
$ownerToUse = if ($Owner) { $Owner } else { $login }
Write-Host "      登录为 $login（仓库将建在 $ownerToUse 下）"

Write-Host '[2/6] 创建仓库（已存在则复用）…'
$repoUrl = "https://github.com/$ownerToUse/$RepoName"
try {
    Invoke-GitHub -Method GET -Path "/repos/$ownerToUse/$RepoName" -Token $token | Out-Null
    Write-Host "      已存在：$repoUrl"
} catch {
    if ($ownerToUse -eq $login) {
        Invoke-GitHub -Method POST -Path '/user/repos' -Token $token -Body @{
            name = $RepoName; description = $Description; private = ($Visibility -eq 'private'); has_wiki = $false; has_projects = $false
        } | Out-Null
    } else {
        Invoke-GitHub -Method POST -Path "/orgs/$ownerToUse/repos" -Token $token -Body @{
            name = $RepoName; description = $Description; private = ($Visibility -eq 'private'); has_wiki = $false; has_projects = $false
        } | Out-Null
    }
    Write-Host "      已创建：$repoUrl（$Visibility）"
}

Write-Host '[3/6] 本地提交…'
Push-Location $repoRoot
try {
    if (-not (Test-Path '.git')) { git init -b main -q }
    if (-not (git config --get user.name)) {
        if ($me.name) { git config user.name $me.name } else { git config user.name $login }
    }
    if (-not (git config --get user.email)) {
        git config user.email "$($me.id)+$login@users.noreply.github.com"
    }
    git add -A
    $hasCommit = $false
    git rev-parse HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $hasCommit = $true }
    if (-not $hasCommit) {
        git commit -q -m 'feat: RP-Hub 三合一（正则引擎 + 浏览器本地后端 + RP助手面板桥）'
        Write-Host '      已创建首个提交'
    } else {
        $dirty = (git status --porcelain | Measure-Object).Count
        if ($dirty -gt 0) { git commit -q -m 'chore: 同步合并版改动' ; Write-Host "      已追加提交（$dirty 个文件变更）" }
        else { Write-Host '      工作区已干净，无需提交' }
    }

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    Write-Host "[4/6] 推送 $branch（使用令牌，且不写入 .git/config）…"
    $pushUrl = "https://x-access-token:$token@github.com/$ownerToUse/$RepoName.git"
    git push --force $pushUrl "HEAD:refs/heads/$branch"
    if ($LASTEXITCODE -ne 0) { throw '推送 main 失败' }

    if (git remote get-url origin 2>$null) { git remote set-url origin $repoUrl }
    else { git remote add origin $repoUrl }
    Write-Host "      origin = $repoUrl（干净 URL，无令牌）"
}
finally {
    Pop-Location
}

if (-not $SkipTTBranch) {
    Write-Host '[5/6] 发布 TT 分支（构建 dist/tt → 孤儿分支 tt）…'
    $pushUrlForTt = "https://x-access-token:$token@github.com/$ownerToUse/$RepoName.git"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'publish-tt-branch.ps1') -RepoUrl $pushUrlForTt
    if ($LASTEXITCODE -ne 0) { throw 'TT 分支发布失败（main 已推送，可稍后重跑本步骤）' }
} else {
    Write-Host '[5/6] 跳过 TT 分支（-SkipTTBranch）'
}

Write-Host ''
Write-Host '[6/6] 完成。安装地址：'
Write-Host "  标准版（宿主有 /script.js）：$repoUrl"
Write-Host "  TT 版（宿主无 /script.js）：$repoUrl   分支填 tt"
Write-Host ''
Write-Host '安全提醒：令牌用完后请到 GitHub → Settings → Developer settings 删除。'
Write-Host '本脚本没有把令牌写进 .git/config、没有打印令牌明文。'
