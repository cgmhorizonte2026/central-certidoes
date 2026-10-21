@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
echo CENTRAL DE CERTIDOES v2.9.3.11
where node >nul 2>nul
if errorlevel 1 (
 echo Instale o Node.js para executar a Central.
 pause
 exit /b 1
)
if not exist node_modules\express (
 call npm install
 if errorlevel 1 (
  echo Nao foi possivel instalar as dependencias.
  pause
  exit /b 1
 )
)
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.runtime\browsers"
if not exist "%PLAYWRIGHT_BROWSERS_PATH%" mkdir "%PLAYWRIGHT_BROWSERS_PATH%"
node -e "const fs=require('fs'),p=require('playwright').chromium.executablePath();process.exit(fs.existsSync(p)?0:1)"
if errorlevel 1 (
 echo Preparando navegador da automacao. Isso acontece apenas na primeira instalacao...
 node node_modules\playwright\cli.js install chromium
 if errorlevel 1 (
  echo Nao foi possivel instalar o navegador Chromium. Verifique a internet e tente novamente.
  pause
  exit /b 1
 )
)
set "PORT=3031"
echo Acesse http://127.0.0.1:3031 no mesmo navegador usado anteriormente.
echo Para encerrar a Central, pressione Ctrl+C nesta janela.
call npm start
pause
