param([switch]$CreateShortcut,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$runtime=Join-Path $root '.runtime'
function Show-Message([string]$text){Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show($text,'Central de Certidoes Horizonte') | Out-Null}
function Get-Health {try {$r=Invoke-RestMethod 'http://localhost:3030/api/health' -TimeoutSec 2;if($r.ok -and $r.version){return $r}}catch{};return $null}
$mutex=$null;$locked=$false
try {
 if($env:USERNAME -like 'CodexSandbox*'){throw 'Abra o atalho da Central pelo seu usuario normal do Windows. O ambiente restrito do Codex nao pode gravar os dados da aplicacao.'}
 if($CreateShortcut){
  $desktop=[Environment]::GetFolderPath('Desktop')
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut((Join-Path $desktop 'Central de Certidoes Horizonte.lnk'))
  $shortcut.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe'
  $shortcut.Arguments='"'+(Join-Path $root 'ABRIR-CENTRAL.vbs')+'"'
  $shortcut.WorkingDirectory=$root
  $shortcut.Description='Abrir a Central de Certidoes Horizonte'
  $shortcut.Save()
  Show-Message 'Atalho criado na area de trabalho. Mantenha esta pasta no mesmo local. Abra o atalho para iniciar a Central.'
  exit 0
 }
 $mutex=New-Object System.Threading.Mutex($false,'Local\CentralCertidoesHorizonteLauncher')
 try {$locked=$mutex.WaitOne(120000)}catch [System.Threading.AbandonedMutexException]{$locked=$true}
 if(!$locked){throw 'A Central ainda esta iniciando. Aguarde e tente novamente.'}
 $node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
 if(!$node){throw 'Instale o Node.js LTS (https://nodejs.org/) e tente novamente.'}
 $expected=& $node (Join-Path $root 'lib\runtime-identity.js') | ConvertFrom-Json
 if($LASTEXITCODE -ne 0 -or !$expected.buildId){throw 'Nao foi possivel identificar esta instalacao. Extraia o pacote completo novamente.'}
 $health=Get-Health
 if($health -and ($health.appId -ne $expected.appId -or $health.buildId -ne $expected.buildId -or $health.installationId -ne $expected.installationId)){
  throw 'Existe uma Central antiga ou de outra pasta em execucao. Finalize as consultas, reinicie o Windows e abra o atalho desta pasta. Atualizar a aba nao atualiza o servidor.'
 }
 if(!$health){
  $listener=Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
  if($listener){throw 'A porta 3030 esta ocupada por outro servico. Nenhum processo foi encerrado.'}
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  $missing=$false
  foreach($dependency in @('express','playwright','pdf-parse')){if(!(Test-Path -LiteralPath (Join-Path $root "node_modules\$dependency\package.json"))){$missing=$true}}
  if($missing){
   $npm=Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
   if(!(Test-Path -LiteralPath $npm)){throw 'npm nao encontrado junto ao Node.js. Reinstale o Node.js com npm.'}
   $setup=Start-Process -FilePath $node -ArgumentList @(('"'+$npm+'"'),'ci','--no-fund') -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $runtime 'install.stdout.log') -RedirectStandardError (Join-Path $runtime 'install.stderr.log')
   if($setup.ExitCode -ne 0){throw "Falha na instalacao das dependencias. Confira sua conexao. Detalhes em $runtime\install.stderr.log"}
  }
  $server=Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.stdout.log') -RedirectStandardError (Join-Path $runtime 'server.stderr.log')
  $deadline=(Get-Date).AddSeconds(30)
  while(!(Get-Health)){
   $server.Refresh()
   if($server.HasExited){throw "O servidor nao iniciou. Detalhes em $runtime\server.stderr.log"}
   if((Get-Date) -gt $deadline){throw "A Central demorou para responder. Detalhes em $runtime\server.stderr.log"}
   Start-Sleep -Milliseconds 300
  }
 }
 if(!$NoBrowser){Start-Process 'http://localhost:3030'}
}catch{if($NoBrowser){Write-Error $_}else{Show-Message $_.Exception.Message};exit 1}
finally{if($locked){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
