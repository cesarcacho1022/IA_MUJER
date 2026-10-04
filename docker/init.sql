CREATE TABLE IF NOT EXISTS alertas (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fuente VARCHAR(100) NOT NULL,
    texto_analizado TEXT NOT NULL,
    vulneracion_detectada BOOLEAN NOT NULL DEFAULT FALSE,
    tipo_violencia VARCHAR(150),
    cita_exacta TEXT,
    justificacion_legal TEXT
);

-- Índice para optimizar consultas recientes en el dashboard
CREATE INDEX IF NOT EXISTS idx_alertas_timestamp ON alertas(timestamp DESC);
