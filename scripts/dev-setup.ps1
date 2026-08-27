#Requires -Version 5.1
<#
.SYNOPSIS
  Developer checkout setup for JAM (Jira Agent MCP) source contributors.

.DESCRIPTION
  Not the installation path. Someone who wants to use JAM runs
  `npx --yes @jam-mcp/bootstrap@1.2.0 init` and never clones this repository.

  This is for working on JAM itself: it checks the Node version, installs
  dependencies, builds, then runs doctor so the result is a verdict rather than
  a pile of build output.

  Credentials are read from the environment and are never written to disk by
  this script.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host '== JAM setup ==' -ForegroundColor Cyan

# Node 20+
$nodeVersion = (& node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    Write-Host "[FAIL] Node $nodeVersion found, need >= 20" -ForegroundColor Red
    exit 1
}
Write-Host "[OK]   Node $nodeVersion"

# Install
if (Test-Path 'package-lock.json') {
    npm ci
} else {
    npm install
}
if ($LASTEXITCODE -ne 0) { Write-Host '[FAIL] npm install' -ForegroundColor Red; exit 1 }
Write-Host '[OK]   Dependencies installed'

# Build
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host '[FAIL] build' -ForegroundColor Red; exit 1 }
Write-Host '[OK]   Build'

# Credentials presence (values are never printed)
$missing = @('JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN') |
    Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) {
    Write-Host "[FAIL] Missing environment variables: $($missing -join ', ')" -ForegroundColor Red
    Write-Host '       Set them, then re-run this script (or run: node packages/server/dist/index.js doctor)'
    exit 1
}
Write-Host '[OK]   Credentials present'

Write-Host ''
Write-Host '== jam doctor ==' -ForegroundColor Cyan
node packages/server/dist/index.js doctor
exit $LASTEXITCODE
