@echo off
title Ingestor Prensa Digital - Infobae RSS (Ley 30364)
echo ============================================================
echo  Iniciando Scraper RSS Infobae en Tiempo Real
echo ============================================================
cd /d "%~dp0prensa-ingest"
python scraper_infobae.py
pause
