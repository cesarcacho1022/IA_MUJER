@echo off
title Monitoreo de Radio en Vivo - Ley 30364
echo ============================================================
echo  Iniciando Ingesta y Transcripcion de Radio en Vivo
echo ============================================================
cd /d "%~dp0audio-ingest"
python ingestor_vivo.py
pause
