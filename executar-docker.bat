@echo off
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo ERRO: Docker nao foi encontrado. Instale e inicie o Docker Desktop.
  pause
  exit /b 1
)

docker compose up --build -d
if errorlevel 1 (
  echo ERRO: nao foi possivel iniciar a aplicacao.
  pause
  exit /b 1
)

echo.
echo Aplicacao iniciada em http://localhost:8787
start "" "http://localhost:8787"
endlocal
