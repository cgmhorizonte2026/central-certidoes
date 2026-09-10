@echo off
setlocal
cd /d "%~dp0"
set "CENTRAL_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%CENTRAL_NODE%" goto run
set "CENTRAL_NODE=node"
:run
echo Central de Certidoes - abra http://127.0.0.1:3030
echo Mantenha esta janela aberta. Para encerrar, pressione Ctrl+C.
"%CENTRAL_NODE%" server.js
pause
