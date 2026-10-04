#!/usr/bin/env python3
"""
inyectar_caso.py - Script de Inyeccion para Demostracion en Hackathon ("Momento WOW")
Transcribe un audio local pregrabado (caso Liceo Naval donde se expone la identidad de una menor)
usando FFmpeg + faster-whisper y lo envia al Backend para forzar una alerta roja por la Ley 30364.
"""

import os
import sys
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

# Configuracion
API_URL = os.environ.get("BACKEND_URL", "http://localhost:3000/api/analizar")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAMPLE_PATH = os.path.join(BASE_DIR, "audio_samples", "caso_liceo_naval.mp3")

if not os.path.exists(SAMPLE_PATH):
    SAMPLE_PATH = os.path.join(BASE_DIR, "audio_samples", "caso_liceo_naval.wav")

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

def decodificar_audio_con_ffmpeg(archivo_audio):
    """
    Decodifica el audio usando FFmpeg directamente a PCM 16kHz mono (float32).
    """
    ffmpeg_cmd = encontrar_ffmpeg()
    cmd = [
        ffmpeg_cmd, "-nostdin", "-threads", "0",
        "-i", archivo_audio,
        "-f", "s16le", "-ac", "1", "-ar", "16000", "-"
    ]
    proceso = subprocess.run(cmd, capture_output=True)
    if proceso.returncode != 0:
        raise RuntimeError(f"Error en FFmpeg al decodificar audio: {proceso.stderr.decode('utf-8', errors='ignore')}")
    
    return np.frombuffer(proceso.stdout, np.int16).flatten().astype(np.float32) / 32768.0

def main():
    print("=" * 65)
    print("[*] INYECTOR DE CASO MEDIATICO - DEMO JURADO HACKATHON")
    print("=" * 65)

    if not os.path.exists(SAMPLE_PATH):
        print(f"[-] Error: Archivo de audio no encontrado en: {SAMPLE_PATH}")
        sys.exit(1)

    print(f"[+] Cargando audio de prueba: {SAMPLE_PATH}")
    print("[+] Decodificando audio con FFmpeg a 16kHz mono...")
    audio_data = decodificar_audio_con_ffmpeg(SAMPLE_PATH)
    print(f"[OK] Audio decodificado ({len(audio_data)} muestras, {len(audio_data)/16000:.1f} seg)")

    print("[+] Cargando modelo faster-whisper (base, CPU int8)...")
    model = WhisperModel("base", device="cpu", compute_type="int8")

    print("[+] Transcribiendo audio en tiempo real...")
    segments, info = model.transcribe(audio_data, language="es", beam_size=5)

    textos = [s.text.strip() for s in segments if s.text]
    transcripcion = " ".join(textos).strip()

    print("\n[+] Transcripcion Detectada:")
    print(f'   "{transcripcion}"\n')
    print("-" * 65)

    payload = {
        "fuente": "Inyeccion - Caso Liceo Naval (Audio Local)",
        "texto": transcripcion
    }

    print(f"[+] Enviando payload al Backend Orquestador ({API_URL})...")
    try:
        res = requests.post(API_URL, json=payload, timeout=120)
        res.raise_for_status()
        data = res.json()
        alerta = data.get("alerta", {})

        print("\n[!] RESPUESTA DEL ORQUESTADOR CON LA LEY 30364:")
        print(f"   * ID Base de Datos: {alerta.get('id')}")
        print(f"   * Vulneracion Detectada: {alerta.get('vulneracion_detectada')}")
        print(f"   * Tipo de Violencia: {alerta.get('tipo_violencia')}")
        print(f"   * Cita Textual: {alerta.get('cita_exacta')}")
        print(f"   * Justificacion Juridica:\n     {alerta.get('justificacion_legal')}")
        print("=" * 65)
        print("[*] Demostracion inyectada exitosamente.")

    except Exception as e:
        print(f"[-] Error al enviar al backend: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
