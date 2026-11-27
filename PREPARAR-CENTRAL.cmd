@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Instale o Node.js LTS antes de continuar.
 pause
 exit /b 1
)
call npm ci --ignore-scripts --no-fund --no-audit
if errorlevel 1 (
 echo Nao foi possivel preparar as dependencias.
 pause
 exit /b 1
)
"%SystemRoot%\System32\wscript.exe" "%~dp0Criar-Atalho.vbs"
