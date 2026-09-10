$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$robotRuntime = Join-Path $PSScriptRoot '.runtime'
$robotZip = Join-Path $robotRuntime 'buster-3.4.0.zip'
$robotExtension = Join-Path $robotRuntime 'buster-3.4.0'
New-Item -ItemType Directory -Path $robotRuntime -Force | Out-Null
Write-Host 'Baixando Buster 3.4.0 do projeto oficial...'
Invoke-WebRequest -Uri 'https://github.com/dessant/buster/releases/download/v3.4.0/buster_captcha_solver_for_humans-3.4.0-chrome.zip' -OutFile $robotZip
$robotDigest = (Get-FileHash -LiteralPath $robotZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($robotDigest -ne '26749705f1bb57ef3e4cda9aa73aa66cc71a8d9df2906c9600eaed98f0d54129') { throw 'SHA-256 divergente. A extensão não será instalada.' }
if (-not (Test-Path -LiteralPath $robotExtension)) { Expand-Archive -LiteralPath $robotZip -DestinationPath $robotExtension }
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $robotRuntime 'browsers'
node node_modules/playwright/cli.js install chromium
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível instalar Chromium.' }
Write-Host 'Navegador dedicado e Buster instalados. Reinicie a Central.'
