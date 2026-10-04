@echo off
title Inyeccion Caso Liceo Naval (Momento WOW)
echo ============================================================
echo  Inyectando Caso de Demostracion (Liceo Naval)
echo ============================================================
cd /d "%~dp0audio-ingest"
python inyectar_caso.py
pause
