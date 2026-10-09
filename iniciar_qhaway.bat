@echo off
setlocal
title Qhaway Medios - Arranque
cd /d "%~dp0"

echo ============================================================
echo  Qhaway Medios - arranque local
echo ============================================================
echo.

rem ---------- 1. Docker y base de datos ----------
where docker >nul 2>&1
if errorlevel 1 goto sin_docker
docker info >nul 2>&1
if errorlevel 1 goto docker_apagado
echo [1/4] Levantando Postgres en Docker...
docker compose -f "%~dp0docker\docker-compose.yml" up -d
if errorlevel 1 goto error_db

rem ---------- 2. Ollama y modelo ----------
where ollama >nul 2>&1
if errorlevel 1 goto sin_ollama
echo [2/4] Revisando Ollama y el modelo llama3.2:3b...
ollama list >nul 2>&1
if errorlevel 1 (
  echo     Ollama no responde. Iniciandolo...
  start "Ollama" /min ollama serve
  timeout /t 6 /nobreak >nul
)
ollama list | findstr /i "llama3.2:3b" >nul
if errorlevel 1 (
  echo     Descargando llama3.2:3b. Puede tardar varios minutos...
  ollama pull llama3.2:3b
  if errorlevel 1 goto error_modelo
)

rem ---------- 3. Backend y pagina ----------
where npm >nul 2>&1
if errorlevel 1 goto sin_node
echo [3/4] Iniciando el backend...
if not exist "%~dp0backend\node_modules" (
  echo     Instalando dependencias de Node...
  pushd "%~dp0backend"
  call npm install
  popd
)
start "Qhaway - Backend" /d "%~dp0backend" cmd /k npm start
timeout /t 4 /nobreak >nul
start "" http://localhost:3000

rem ---------- 4. Radio en vivo (opcional) ----------
echo.
choice /c SN /m "[4/4] Iniciar la captura de radio en vivo (RPP + Exitosa)"
if errorlevel 2 goto fin

start "Qhaway - Radio en vivo" "%~dp0ejecutar_radio_docker.bat"

:fin
echo.
echo Listo. La pagina esta en http://localhost:3000
echo Para detener todo: cierra las ventanas "Qhaway" y ejecuta
echo   docker compose -f docker\docker-compose.yml stop
echo.
pause
exit /b 0

:sin_docker
echo ERROR: Docker no esta instalado. Descargalo en https://www.docker.com/products/docker-desktop
pause
exit /b 1

:docker_apagado
echo ERROR: Docker Desktop esta instalado pero apagado. Abrelo, espera a que diga "running" y vuelve a ejecutar este archivo.
pause
exit /b 1

:error_db
echo ERROR: no se pudo levantar Postgres. Revisa el mensaje de arriba.
pause
exit /b 1

:sin_ollama
echo ERROR: Ollama no esta instalado. Descargalo en https://ollama.com y vuelve a ejecutar este archivo.
pause
exit /b 1

:error_modelo
echo ERROR: no se pudo descargar el modelo llama3.2:3b. Revisa tu conexion y vuelve a intentar.
pause
exit /b 1

:sin_node
echo ERROR: Node.js no esta instalado. Descargalo en https://nodejs.org y vuelve a ejecutar este archivo.
pause
exit /b 1
