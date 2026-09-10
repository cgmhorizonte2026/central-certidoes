$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$centralNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $centralNode)) { $centralNode = (Get-Command node -ErrorAction Stop).Source }
$centralUser = Read-Host 'Nome do primeiro administrador'
$centralPassword = Read-Host 'Senha (minimo 12 caracteres)' -AsSecureString
$centralPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($centralPassword)
try {
    $centralPayload = @{ username = $centralUser; password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($centralPtr) }
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $centralPayload | ConvertTo-Json -Compress | & $centralNode (Join-Path $PSScriptRoot 'scripts\create-admin.js')
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($centralPtr)
    $centralPayload = $null
}
Read-Host 'Pressione Enter para fechar'
