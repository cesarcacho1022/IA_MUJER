@echo off
setlocal
title Qhaway Medios - Crear o actualizar un usuario
cd /d "%~dp0backend"

where node >nul 2>&1
if errorlevel 1 goto sin_node
if not exist "%~dp0backend\node_modules" goto sin_modulos

echo ============================================================
echo  Qhaway Medios - crear o actualizar un usuario
echo  La base de datos debe estar encendida (iniciar_qhaway.bat).
echo  Si el usuario ya existe, se le cambian el nombre y la clave.
echo ============================================================
echo.
node crear_usuario.js
echo.
pause
exit /b 0

:sin_node
echo ERROR: Node.js no esta instalado. Descargalo en https://nodejs.org y vuelve a ejecutar este archivo.
pause
exit /b 1

:sin_modulos
echo ERROR: faltan las dependencias del backend. Ejecuta primero iniciar_qhaway.bat.
pause
exit /b 1
