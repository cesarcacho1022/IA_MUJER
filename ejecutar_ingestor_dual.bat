@echo off
title Monitoreo Dual en Vivo (RPP + Exitosa) - Ley 30364
echo ============================================================
echo  Iniciando Ingesta Dual (RPP + Exitosa) en Tiempo Real
echo ============================================================
cd /d "%~dp0audio-ingest"
python ingestor_dual.py
pause
