# Arquitectura de Qhaway Medios (IA_MUJER)

Sistema que monitorea radio en vivo y prensa digital, detecta posibles vulneraciones a la **Ley 30364** (violencia contra la mujer) con un LLM local y las presenta en un panel web con revisión humana.

## Diagrama general

```mermaid
flowchart LR
    subgraph FUENTES["Fuentes externas"]
        RPP["Radio RPP<br/>(stream Icecast)"]
        EXI["Radio Exitosa<br/>(stream)"]
        RSS["Infobae<br/>(feed RSS)"]
        MP3["Audio de demo<br/>caso_liceo_naval.mp3"]
    end

    subgraph INGESTA["Ingesta (Python 3.11)"]
        DUAL["ingestor_dual.py<br/>FFmpeg + faster-whisper (base, CPU)<br/>1 hilo por emisora<br/>[Docker: audio-ingest]"]
        VIVO["ingestor_vivo.py<br/>(versión de una emisora)"]
        INY["inyectar_caso.py<br/>(demo)"]
        PRENSA["scraper_infobae.py<br/>requests + XML ElementTree<br/>consulta cada 60 s"]
    end

    subgraph BACK["Backend (Node.js + Express, :3000)"]
        API["server.js<br/>REST + estáticos"]
        AUTH["auth.js<br/>scrypt, sesión por cookie HttpOnly"]
        TICK["Ticker en memoria<br/>(texto en vivo)"]
    end

    OLLAMA["Ollama (local :11434)<br/>modelo llama3.2:3b"]
    DB[("PostgreSQL 16<br/>Docker :5433")]
    WEB["Frontend SPA<br/>index.html (HTML/CSS/JS)<br/>servido por Express"]
    USER(["Analista / revisor"])

    RPP --> DUAL
    EXI --> DUAL
    RPP -.-> VIVO
    MP3 --> INY
    RSS --> PRENSA

    DUAL -- "POST /api/ticker (fragmentos cada 3-5 s)" --> API
    DUAL -- "POST /api/analizar (texto acumulado)" --> API
    VIVO -- "POST /api/analizar" --> API
    INY -- "POST /api/analizar" --> API
    PRENSA -- "POST /api/analizar" --> API

    API --- TICK
    API -- "prompt + texto → JSON" --> OLLAMA
    API -- "pg: INSERT alertas, eventos" --> DB
    AUTH --- API
    API -- "usuarios, sesiones" --> DB

    USER --> WEB
    WEB -- "login/logout, GET alertas, resumen, eventos<br/>GET ticker (cada 1,5 s)<br/>POST eventos (decisión humana)" --> API
```

## Flujo de una alerta (secuencia)

```mermaid
sequenceDiagram
    participant F as Fuente (radio / RSS)
    participant I as Ingestor Python
    participant B as Backend Express
    participant O as Ollama (llama3.2:3b)
    participant D as PostgreSQL
    participant W as Panel web
    F->>I: audio en streaming / noticias
    I->>I: FFmpeg → PCM → Whisper → texto
    I->>B: POST /api/ticker (texto rápido, sin LLM)
    I->>B: POST /api/analizar (texto)
    B->>O: prompt Ley 30364
    O-->>B: JSON {vulneracion, tipo, cita, justificación}
    B->>D: INSERT en alertas
    W->>B: GET /api/alertas, /api/resumen (con sesión)
    B->>D: SELECT
    W->>B: POST /api/eventos (confirmar / descartar / corregir / exportar)
    B->>D: INSERT en eventos_caso
```

## Componentes y tecnologías

| Componente | Carpeta / archivo | Tecnología | Rol |
|---|---|---|---|
| Ingesta de radio | `audio-ingest/ingestor_dual.py` | Python, FFmpeg, faster-whisper, numpy, requests | Captura el stream de RPP y Exitosa, transcribe en CPU y envía el texto al backend. Corre en Docker (`audio-ingest/Dockerfile`, `python:3.11-slim`) o en local |
| Ingesta de una emisora / demo | `ingestor_vivo.py`, `inyectar_caso.py` | Igual que arriba | Captura de una sola emisora y reproducción de un caso pregrabado para demostraciones |
| Ingesta de prensa | `prensa-ingest/scraper_infobae.py` | Python, requests, XML (RSS) | Lee el RSS de Infobae cada 60 s, evita duplicados por URL y envía cada noticia a analizar |
| Backend | `backend/server.js`, `auth.js`, `crear_usuario.js` | Node.js, Express 4, cors, pg | API REST, orquestación del análisis, sesiones y sirve el frontend |
| Análisis con IA | Ollama (externo al repo) | LLM `llama3.2:3b` (configurable por `OLLAMA_MODEL`/`OLLAMA_URL`) | Clasifica el texto según la Ley 30364 y devuelve JSON |
| Base de datos | `docker/docker-compose.yml`, `init.sql` | PostgreSQL 16 (Alpine) en Docker, volumen `postgres_data` | Tablas `alertas`, `usuarios`, `sesiones`, `eventos_caso` |
| Frontend | `backend/public/index.html` | HTML + CSS + JavaScript sin framework (fetch + `setInterval`) | Login, monitoreo en vivo, detalle de casos, observatorio y revisión humana |
| Orquestación local | `iniciar_qhaway.bat` y `ejecutar_*.bat` | Scripts de Windows | Levantan Docker/Postgres, Ollama, backend y la captura de radio |

## Cómo interactúan

1. **Ingesta → Backend (HTTP/JSON).** Los ingestores no tocan la base ni el LLM; solo hacen `POST` al backend (`BACKEND_URL`, por defecto `localhost:3000`; desde Docker usa `host.docker.internal:3000`).
   - `/api/ticker`: fragmentos cortos para mostrar texto en vivo sin esperar al LLM (se guarda en memoria).
   - `/api/analizar`: texto completo para clasificar.
2. **Backend → Ollama (HTTP).** `/api/analizar` envía un prompt a `OLLAMA_URL` y espera una respuesta JSON; si no es JSON válido, extrae el objeto con una expresión regular.
3. **Backend → PostgreSQL (`pg`).** Cada resultado se inserta en `alertas`. Al iniciar, el backend crea las tablas que falten y reintenta cada 5 s si la base aún no está lista.
4. **Frontend → Backend (HTTP + cookie).** La SPA la sirve el mismo Express. Consulta el ticker cada 1,5 s y sincroniza alertas cada 3 s (polling, sin WebSockets). Las rutas `/api/alertas`, `/api/resumen` y `/api/eventos` exigen sesión.
5. **Seguridad.** Contraseñas con `scrypt` y sal; la sesión es un token aleatorio en cookie `HttpOnly; SameSite=Strict` que se guarda hasheado (SHA-256) en `sesiones` y expira a las 12 h. Hay límite de 5 intentos fallidos por minuto.
6. **Revisión humana.** El analista confirma, descarta o corrige cada alerta, o la exporta; el backend lo registra en `eventos_caso` con revisor, modelo y comentario, para tener trazabilidad.

## Endpoints del backend

| Método | Ruta | Sesión | Uso |
|---|---|---|---|
| POST | `/api/login`, `/api/logout` | no | Iniciar y cerrar sesión |
| GET | `/api/sesion` | no | Estado de la sesión |
| POST/GET | `/api/ticker` | no | Texto en vivo (ingesta escribe, panel lee) |
| POST | `/api/analizar` | no | Análisis con IA y guardado |
| GET | `/api/alertas` | sí | Listado con filtros y paginación |
| GET | `/api/resumen` | sí | Indicadores del observatorio |
| GET/POST | `/api/eventos` | sí | Decisiones y exportaciones |

## Puertos y despliegue

- `:3000` backend y frontend · `:5433` PostgreSQL (contenedor `ia_mujer_postgres`) · `:11434` Ollama.
- Todo corre en la máquina local; ningún texto sale a servicios de IA en la nube. Los únicos accesos externos son los streams de radio y el RSS de Infobae.
