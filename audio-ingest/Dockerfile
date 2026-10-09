FROM python:3.11-slim

# FFmpeg lo usa el ingestor para leer el stream de radio
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    BACKEND_URL=http://host.docker.internal:3000

CMD ["python", "ingestor_dual.py"]
