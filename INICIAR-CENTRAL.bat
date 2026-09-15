@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
echo CENTRAL DE CERTIDOES v2.9.3.11
echo Encerrando uma instancia antiga, se existir...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3030" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>nul
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
echo Acesse http://localhost:3030 no mesmo navegador usado anteriormente.
call npm start
pause
