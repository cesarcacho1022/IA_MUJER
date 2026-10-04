#!/usr/bin/env python3
"""
ingestor_vivo.py - Monitoreo de Transmision de Radio en Tiempo Real
Captura un stream HLS/Icecast (ej. Radio RPP) en fragmentos periodicos usando FFmpeg,
los transcribe localmente con faster-whisper y envia el texto al Backend Orquestador
para su analisis automatizado con la Ley 30364.
"""

import os
import sys
import time
import argparse
import subprocess
import requests
import numpy as np
from faster_whisper import WhisperModel

# Asegurar compatibilidad de consola en Windows sin depender de codificaciones complejas
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# URL por defecto: Streaming oficial en vivo de Radio RPP Noticias (Icecast / AAC)
DEFAULT_STREAM_URL = os.environ.get(
    "RADIO_STREAM_URL", 
    "https://mdstrm.com/audio/5fab3416b5f9ef165cfab6e9/icecast.audio"
)
DEFAULT_BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:3000/api/analizar")
DEFAULT_CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "120"))

def encontrar_ffmpeg():
    """Busca el ejecutable de ffmpeg en PATH o ubicaciones estandar de Windows."""
    import shutil
    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin:
        return ffmpeg_bin
    
    rutas_posibles = [
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"),
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"
    ]
    for r in rutas_posibles:
        if os.path.exists(r):
            return r
    return "ffmpeg"

def capturar_audio_stream(stream_url, duracion_segundos):
    """
    Captura audio en vivo durante N segundos usando FFmpeg y lo convierte
    directamente en memoria a formato PCM 16kHz mono (float32).
    """
    ffmpeg_cmd = encontrar_ffmpeg()
    cmd = [
        ffmpeg_cmd, "-nostdin", "-threads", "0",
        "-i", stream_url,
        "-t", str(duracion_segundos),
        "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"
    ]

    try:
        proceso = subprocess.run(cmd, capture_output=True, timeout=duracion_segundos + 30)
        if proceso.returncode != 0 and len(proceso.stdout) == 0:
            err_msg = proceso.stderr.decode('utf-8', errors='ignore')
            print(f"[!] Advertencia FFmpeg: {err_msg[:200]}")
            return None
        
        audio = np.frombuffer(proceso.stdout, np.int16).flatten().astype(np.float32) / 32768.0
        return audio
    except subprocess.TimeoutExpired:
        print("[!] Tiempo de espera agotado al conectar con el stream radial.")
        return None
    except Exception as e:
        print(f"[!] Error al capturar stream con FFmpeg: {e}")
        return None

def main():
    parser = argparse.ArgumentParser(description="Ingestor de Radio en Vivo + Faster-Whisper")
    parser.add_argument("--stream", default=DEFAULT_STREAM_URL, help="URL del stream m3u8 o icecast")
    parser.add_argument("--duracion", type=int, default=DEFAULT_CHUNK_SECONDS, help="Duracion del fragmento en segundos (por defecto 120)")
    parser.add_argument("--backend", default=DEFAULT_BACKEND_URL, help="Endpoint del backend orquestador")
    parser.add_argument("--fuente", default="Radio RPP - En Vivo", help="Nombre de la fuente informativa")
    parser.add_argument("--una-vez", action="store_true", help="Capturar solo un fragmento y salir")
    args = parser.parse_args()

    print("=" * 65)
    print("[*] MONITOREO DE RADIO EN VIVO (STT + LEY 30364)")
    print("=" * 65)
    print(f"[*] Stream Objetivo: {args.stream}")
    print(f"[*] Intervalo de Captura: {args.duracion} segundos por ciclo")
    print(f"[*] Backend API: {args.backend}")
    print("[+] Inicializando modelo faster-whisper (base, CPU int8)...")

    model = WhisperModel("base", device="cpu", compute_type="int8")
    print("[OK] Modelo cargado en memoria. Iniciando bucle de escucha continua...\n")

    ciclo = 1
    try:
        while True:
            print(f"--- [Ciclo #{ciclo}] {time.strftime('%H:%M:%S')} ---")
            print(f"[+] Grabando {args.duracion}s de la transmision radial...")

            audio_data = capturar_audio_stream(args.stream, args.duracion)

            if audio_data is None or len(audio_data) < 16000:
                print("[!] No se obtuvieron datos de audio suficientes. Reintentando en 5 segundos...")
                time.sleep(5)
                continue

            print(f"[+] Audio capturado: {len(audio_data)/16000:.1f}s. Transcribiendo con faster-whisper...")
            segments, info = model.transcribe(audio_data, language="es", beam_size=5)

            textos = [s.text.strip() for s in segments if s.text]
            transcripcion = " ".join(textos).strip()

            if not transcripcion:
                print("[i] Audio capturado con silencio o sin contenido verbal.")
            else:
                print(f"[+] Transcripcion obtenida ({len(transcripcion)} caracteres):")
                print(f'   "{transcripcion[:180]}..."\n' if len(transcripcion) > 180 else f'   "{transcripcion}"\n')

                payload = {
                    "fuente": args.fuente,
                    "texto": transcripcion
                }

                print("[+] Enviando transcripcion al Backend Orquestador...")
                try:
                    res = requests.post(args.backend, json=payload, timeout=90)
                    if res.ok:
                        alerta = res.json().get("alerta", {})
                        vuln = alerta.get("vulneracion_detectada")
                        print(f"[!] Resultado LLM: {'ALERTA: VULNERACION' if vuln else 'NORMAL (Sin vulneracion)'}")
                    else:
                        print(f"[!] Error en respuesta del backend: {res.status_code}")
                except Exception as e:
                    print(f"[!] Error al conectar con el backend: {e}")

            if args.una_vez:
                print("\n[*] Modo '--una-vez' completado. Finalizando ejecucion.")
                break

            ciclo += 1
            print(f"[*] Esperando siguiente ciclo...\n")

    except KeyboardInterrupt:
        print("\n[!] Monitoreo detenido por el usuario.")

if __name__ == "__main__":
    main()
