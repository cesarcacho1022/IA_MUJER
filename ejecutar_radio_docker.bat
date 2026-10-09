@echo off
setlocal
chcp 65001 >nul
title Qhaway - Radio en vivo (Docker)
cd /d "%~dp0"

echo ============================================================
echo  Radio en vivo (RPP + Exitosa) dentro de Docker
echo ============================================================
echo.

where docker >nul 2>&1
if errorlevel 1 goto sin_docker
docker info >nul 2>&1
if errorlevel 1 goto docker_apagado

echo Preparando la imagen. La primera vez tarda unos minutos...
docker build -t qhaway-radio "%~dp0audio-ingest"
if errorlevel 1 goto error_build

docker rm -f qhaway-radio >nul 2>&1
echo.
echo Iniciando la captura. La primera vez tambien descarga el modelo de transcripcion.
echo Para detenerla, cierra esta ventana o presiona Ctrl+C.
echo.
docker run --rm --name qhaway-radio -e BACKEND_URL=http://host.docker.internal:3000 -v qhaway_whisper:/root/.cache/huggingface qhaway-radio

echo.
echo La captura se detuvo.
pause
exit /b 0

:sin_docker
echo ERROR: Docker no esta instalado. Descargalo en https://www.docker.com/products/docker-desktop
pause
exit /b 1

:docker_apagado
echo ERROR: Docker Desktop esta apagado. Abrelo, espera a que diga "Engine running" y vuelve a ejecutar este archivo.
pause
exit /b 1

:error_build
echo ERROR: no se pudo preparar la imagen de la radio. Revisa el mensaje de arriba.
pause
exit /b 1
