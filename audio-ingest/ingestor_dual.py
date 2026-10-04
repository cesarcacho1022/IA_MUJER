#!/usr/bin/env python3
"""
ingestor_dual.py - Ingesta Simultánea de Dos Radios (RPP + Exitosa) en Tiempo Real
Captura fragmentos rápidos (5 segundos) para alimentar el ticker de streaming en vivo
y acumula fragmentos para auditoría legal con Llama 3 según la Ley 30364.
"""

import os
import sys
import time
import threading
import subprocess
import requests
import numpy as np
from faster_whisper import WhisperModel

if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Configuración de emisoras
STATIONS = [
    {
        "id": "rpp",
        "nombre": "Radio RPP Noticias",
        "url": "https://mdstrm.com/audio/5fab3416b5f9ef165cfab6e9/icecast.audio",
    },
    {
        "id": "exitosa",
        "nombre": "Radio Exitosa 95.5 FM",
        "url": "https://neptuno-2-audio.mediaserver.digital/79525baf-b0f5-4013-a8bd-3c5c293c6561",
    }
]

API_BASE = os.environ.get("BACKEND_URL", "http://localhost:3000")
TICKER_INTERVAL = 5       # Segundos por cada fragmento rápido
AUDIT_ACCUMULATE_SECS = 45 # Cada cuántos segundos de texto acumulado se audita con Llama 3

def encontrar_ffmpeg():
    import shutil
    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin:
        return ffmpeg_bin
    rutas = [
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"),
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"
    ]
    for r in rutas:
        if os.path.exists(r):
            return r
    return "ffmpeg"

def capturar_pcm_rapido(stream_url, duracion_segundos):
    ffmpeg_cmd = encontrar_ffmpeg()
    cmd = [
        ffmpeg_cmd, "-nostdin", "-threads", "0",
        "-i", stream_url,
        "-t", str(duracion_segundos),
        "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=duracion_segundos + 15)
        if proc.returncode != 0 or len(proc.stdout) < 16000:
            return None
        return np.frombuffer(proc.stdout, np.int16).flatten().astype(np.float32) / 32768.0
    except Exception:
        return None

def worker_estacion(station, model, lock):
    nombre = station["nombre"]
    stream_url = station["url"]
    print(f"[*] Hilo iniciado para: {nombre}")

    buffer_texto = []
    tiempo_ultimo_analisis = time.time()

    while True:
        try:
            # 1. Capturar 5 segundos de audio
            audio = capturar_pcm_rapido(stream_url, TICKER_INTERVAL)
            if audio is None:
                time.sleep(2)
                continue

            # 2. Transcripción con Whisper (protegida con lock si comparten modelo en CPU)
            with lock:
                segments, _ = model.transcribe(audio, language="es", beam_size=1)
                textos = [s.text.strip() for s in segments if s.text]
                chunk_texto = " ".join(textos).strip()

            if chunk_texto:
                print(f"[{nombre}] 🎙️: {chunk_texto}")
                buffer_texto.append(chunk_texto)

                # 3. Enviar fragmento rápido al Ticker en vivo (latencia ultra baja)
                try:
                    requests.post(
                        f"{API_BASE}/api/ticker",
                        json={"fuente": nombre, "fragmento": chunk_texto},
                        timeout=2
                    )
                except Exception:
                    pass

            # 4. Auditoría Legal periódica con Llama 3 (acumulado de ~45s)
            tiempo_transcurrido = time.time() - tiempo_ultimo_analisis
            if tiempo_transcurrido >= AUDIT_ACCUMULATE_SECS and buffer_texto:
                texto_acumulado = " ".join(buffer_texto).strip()
                buffer_texto = []
                tiempo_ultimo_analisis = time.time()

                if len(texto_acumulado) > 40:
                    print(f"\n[⚖️ AUDITORÍA LEY 30364] Enviando bloque de {nombre} a Llama 3...")
                    try:
                        requests.post(
                            f"{API_BASE}/api/analizar",
                            json={"fuente": nombre, "texto": texto_acumulado},
                            timeout=60
                        )
                    except Exception as e:
                        print(f"[!] Error al enviar análisis: {e}")

        except Exception as e:
            print(f"[!] Error en bucle de {nombre}: {e}")
            time.sleep(3)

def main():
    print("=" * 65)
    print("📻 INGESTOR DUAL EN TIEMPO REAL (RPP + EXITOSA)")
    print("=" * 65)
    print("🧠 Cargando faster-whisper (base, CPU int8)...")

    # Cargamos Whisper en CPU optimizado con cuantización int8
    model = WhisperModel("base", device="cpu", compute_type="int8")
    model_lock = threading.Lock()

    hilos = []
    for st in STATIONS:
        t = threading.Thread(target=worker_estacion, args=(st, model, model_lock), daemon=True)
        t.start()
        hilos.append(t)

    print("[OK] Dos hilos de monitoreo radial en vivo activos.")
    print("[*] Presiona Ctrl+C para detener.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[!] Deteniendo monitoreo dual.")

if __name__ == "__main__":
    main()
