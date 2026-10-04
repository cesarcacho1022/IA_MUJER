#!/usr/bin/env python3
"""
scraper_infobae.py - Ingestor de Prensa Digital (Infobae) vía RSS
Monitorea el feed RSS de Infobae cada 60 segundos, memoriza las URLs ya procesadas,
filtra únicamente las noticias del día en curso y las envía directamente al backend
Node.js para auditoría legal con Llama 3.2 en GPU (sin usar Whisper).
"""

import os
import sys
import time
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

# Asegurar salida segura en consola Windows
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Configuración
RSS_URL = os.environ.get("INFOBAE_RSS_URL", "https://www.infobae.com/arc/outboundfeeds/rss/")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:3000/api/analizar")
INTERVALO_SEGUNDOS = 60

# Memoria de URLs procesadas (evita duplicados)
urls_procesadas = set()

def obtener_noticias_del_dia():
    """
    Descarga y parsea el feed RSS de Infobae.
    Retorna lista de diccionarios con noticias nuevas del día en curso.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VigilaPeru-Bot/1.0"
    }

    try:
        response = requests.get(RSS_URL, headers=headers, timeout=20)
        response.raise_for_status()
    except Exception as e:
        print(f"[!] Error al descargar feed RSS de Infobae: {e}")
        return []

    try:
        root = ET.fromstring(response.content)
    except Exception as e:
        print(f"[!] Error al parsear XML de Infobae: {e}")
        return []

    channel = root.find("channel")
    if channel is None:
        return []

    items = channel.findall("item")
    fecha_hoy = datetime.now(timezone.utc).date()
    noticias_nuevas = []

    for item in items:
        link_elem = item.find("link")
        title_elem = item.find("title")
        desc_elem = item.find("description")
        pubdate_elem = item.find("pubDate")

        if link_elem is None or not link_elem.text:
            continue

        url = link_elem.text.strip()

        # 1. Comprobar si ya fue procesada en memoria
        if url in urls_procesadas:
            continue

        # 2. Filtrar por fecha del día en curso
        if pubdate_elem is not None and pubdate_elem.text:
            try:
                dt_pub = parsedate_to_datetime(pubdate_elem.text)
                if dt_pub.date() != fecha_hoy:
                    continue # Noticia de un día anterior
            except Exception:
                pass

        titulo = title_elem.text.strip() if title_elem is not None and title_elem.text else ""
        descripcion = desc_elem.text.strip() if desc_elem is not None and desc_elem.text else ""

        if not titulo:
            continue

        # Determinamos si es edición Perú o general
        fuente_nombre = "Infobae Perú (Prensa Digital)" if "/peru/" in url else "Infobae (Prensa Digital)"

        texto_completo = f"{titulo}. {descripcion}".strip()

        noticias_nuevas.append({
            "url": url,
            "fuente": fuente_nombre,
            "titulo": titulo,
            "texto": texto_completo
        })

    return noticias_nuevas

def procesar_noticia(noticia):
    """
    Envía el texto de la noticia directamente al backend Express para inferencia LLM.
    """
    payload = {
        "fuente": noticia["fuente"],
        "texto": noticia["texto"]
    }

    print(f"\n[+] Analizando noticia: \"{noticia['titulo'][:80]}...\"")
    print(f"    URL: {noticia['url']}")

    try:
        res = requests.post(BACKEND_URL, json=payload, timeout=60)
        if res.ok:
            data = res.json().get("alerta", {})
            es_vuln = data.get("vulneracion_detectada")
            if es_vuln:
                print(f"    [🚨 ALERTA ROJA] Infracción Ley 30364 detectada en prensa digital!")
                print(f"    Tipo: {data.get('tipo_violencia')}")
                print(f"    Cita: \"{data.get('cita_exacta')}\"")
            else:
                print(f"    [OK] Noticia regular (Sin vulneración)")
        else:
            print(f"    [!] Error en backend HTTP: {res.status_code}")
    except Exception as e:
        print(f"    [!] Error al conectar con backend: {e}")

    # Guardar en memoria para no repetir
    urls_procesadas.add(noticia["url"])

def main():
    print("=" * 65)
    print("📰 INGESTOR DE PRENSA DIGITAL - INFOBAE (RSS FEED)")
    print("=" * 65)
    print(f"[*] Feed RSS: {RSS_URL}")
    print(f"[*] Intervalo de Consulta: cada {INTERVALO_SEGUNDOS} segundos")
    print(f"[*] Destino Backend: {BACKEND_URL}")
    print("[*] Iniciando ciclo de monitoreo continuo...\n")

    ciclo = 1
    while True:
        hora_actual = time.strftime('%H:%M:%S')
        print(f"--- [Ciclo #{ciclo}] {hora_actual} - Consultando Infobae ---")

        nuevas = obtener_noticias_del_dia()
        print(f"[*] Noticias nuevas detectadas del día: {len(nuevas)} (Total memoria: {len(urls_procesadas)})")

        for n in nuevas:
            procesar_noticia(n)
            # Pequeña pausa entre noticias para balancear la GPU
            time.sleep(1)

        ciclo += 1
        print(f"\n[*] Esperando {INTERVALO_SEGUNDOS} segundos para la siguiente consulta...\n")
        time.sleep(INTERVALO_SEGUNDOS)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[!] Ingestor de Infobae detenido por el usuario.")
