const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a PostgreSQL en Docker (puerto 5433)
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgrespassword',
  database: process.env.DB_NAME || 'ia_mujer_db',
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Error al conectar a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conexión exitosa a PostgreSQL en Docker a las:', res.rows[0].now);
  }
});

// Buffer en memoria para streaming de transcripción fluida (bloques de 3-5 segundos)
const tickerState = {
  rpp: { texto: 'Esperando señal de transmisión...', timestamp: Date.now() },
  exitosa: { texto: 'Esperando señal de transmisión...', timestamp: Date.now() },
  ultimo_bloque: { fuente: 'Sistema', texto: 'Iniciando ingestores de radio...', timestamp: Date.now() }
};

/**
 * Endpoint para recibir fragmentos rápidos de texto en vivo (cada 3-5 segundos)
 * para alimentar el panel de streaming en el frontend sin latencia de LLM.
 */
app.post('/api/ticker', (req, res) => {
  const { fuente, fragmento } = req.body;
  if (!fragmento) return res.status(400).json({ error: 'fragmento requerido' });

  const fLower = (fuente || '').toLowerCase();
  const obj = { texto: fragmento.trim(), timestamp: Date.now() };

  if (fLower.includes('exitosa')) {
    tickerState.exitosa = obj;
  } else {
    tickerState.rpp = obj;
  }
  tickerState.ultimo_bloque = { fuente: fuente || 'Radio', texto: fragmento.trim(), timestamp: Date.now() };

  res.json({ ok: true });
});

// Endpoint para que el Frontend consulte el estado del streaming en vivo
app.get('/api/ticker', (req, res) => {
  res.json(tickerState);
});

/**
 * SYSTEM PROMPT ESPECIALIZADO:
 * Basado en la Ley Peruana N° 30364 y Código de los Niños y Adolescentes.
 */
const SYSTEM_PROMPT = `Eres un auditor legal y ético especializado en el marco normativo peruano de protección a la mujer y la niñez, principalmente:
1. Ley N° 30364 (Ley para prevenir, sancionar y erradicar la violencia contra las mujeres y los integrantes del grupo familiar):
   - Prohíbe la violencia mediática, estigmatización y la revictimización en medios de comunicación.
   - Prohíbe culpabilizar, exponer o emitir juicios de valor humillantes sobre la víctima o denunciante.
2. Código de los Niños y Adolescentes (Ley N° 27337, Art. 6) y Principio del Interés Superior del Niño:
   - Prohibición estricta e inexcusable de divulgar nombres, apellidos, imágenes, parentesco o datos que permitan individualizar o identificar a niños, niñas o adolescentes víctimas o testigos de delitos de violencia.

Tu tarea es analizar transcripciones radiales/mediáticas y determinar si existe vulneración a estas leyes.

Debes responder ÚNICAMENTE con un objeto JSON válido con la siguiente estructura:
{
  "vulneracion_detectada": true o false,
  "tipo_violencia": "Violencia Mediática / Revictimización" | "Exposición de Identidad de Menor" | "Culpabilización de la Víctima" | "Ninguna",
  "cita_exacta": "fragmento literal donde se comete la falta, o null si no hay",
  "justificacion_legal": "Explicación jurídica concisa citando el artículo o norma vulnerada, o null si no hay"
}

EJEMPLOS FEW-SHOT:

Ejemplo 1 (Noticia habitual - Sin vulneración):
Texto: "El Ministerio de Salud inició hoy la campaña de vacunación en los colegios de Lima Metropolitana. Se pide a los padres firmar el consentimiento."
Respuesta:
{
  "vulneracion_detectada": false,
  "tipo_violencia": "Ninguna",
  "cita_exacta": null,
  "justificacion_legal": null
}

Ejemplo 2 (Violación grave / Caso mediático Liceo Naval - Con vulneración):
Texto: "Estamos en vivo desde el Liceo Naval. Revelamos la identidad de la alumna de 14 años de iniciales M.P. o María Pérez, quien denunció tocamientos indebidos por parte del instructor."
Respuesta:
{
  "vulneracion_detectada": true,
  "tipo_violencia": "Exposición de Identidad de Menor y Revictimización",
  "cita_exacta": "Revelamos la identidad de la alumna de 14 años de iniciales M.P. o María Pérez",
  "justificacion_legal": "Vulnera el Art. 6 del Código de los Niños y Adolescentes (prohibición de publicar identidad de menores víctimas) y los Arts. 6 y 8 de la Ley 30364 al generar revictimización y violencia mediática pública."
}
`;

/**
 * Endpoint POST /api/analizar
 */
app.post('/api/analizar', async (req, res) => {
  const { fuente, texto } = req.body;

  if (!texto || typeof texto !== 'string' || texto.trim().length === 0) {
    return res.status(400).json({ error: 'El campo "texto" es obligatorio.' });
  }

  const fuenteFinal = fuente ? fuente.trim() : 'Transmisión Radial';

  // Actualizar también el ticker
  const fLower = fuenteFinal.toLowerCase();
  const tickObj = { texto: texto.trim(), timestamp: Date.now() };
  if (fLower.includes('exitosa')) tickerState.exitosa = tickObj;
  else tickerState.rpp = tickObj;
  tickerState.ultimo_bloque = { fuente: fuenteFinal, texto: texto.trim(), timestamp: Date.now() };

  console.log('\n======================================================');
  console.log(`[POST /api/analizar] Procesando audio de: ${fuenteFinal}`);
  console.log(`📝 Texto recibido (${texto.length} chars): "${texto.substring(0, 100)}..."`);
  console.log('🤖 Enviando prompt a Ollama local...');

  try {
    const promptUsuario = `Analiza la siguiente transcripción mediática y clasifícala según la Ley 30364 y normas conexas:\n\n"${texto}"`;

    const ollamaResponse = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: SYSTEM_PROMPT,
        prompt: promptUsuario,
        stream: false,
        format: 'json',
        options: {
          temperature: 0.1,
          num_ctx: 2048
        }
      })
    });

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text();
      throw new Error(`Ollama API error (${ollamaResponse.status}): ${errorText}`);
    }

    const ollamaData = await ollamaResponse.json();
    let analisisIA;

    try {
      analisisIA = JSON.parse(ollamaData.response);
    } catch (parseError) {
      const jsonMatch = ollamaData.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analisisIA = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Respuesta de IA no parseable: ${ollamaData.response}`);
      }
    }

    const vulneracion = Boolean(analisisIA.vulneracion_detectada);
    const tipoViolencia = vulneracion ? (analisisIA.tipo_violencia || 'Violencia Mediática') : 'Ninguna';
    const citaExacta = vulneracion ? (analisisIA.cita_exacta || null) : null;
    const justificacionLegal = vulneracion ? (analisisIA.justificacion_legal || null) : null;

    console.log(`⚖️ Resultado del análisis: ${vulneracion ? '🚨 VULNERACIÓN DETECTADA' : '✅ SIN VULNERACIÓN'}`);

    // Insertar en base de datos PostgreSQL
    const insertQuery = `
      INSERT INTO alertas (fuente, texto_analizado, vulneracion_detectada, tipo_violencia, cita_exacta, justificacion_legal)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, timestamp, fuente, texto_analizado, vulneracion_detectada, tipo_violencia, cita_exacta, justificacion_legal;
    `;

    const dbResult = await pool.query(insertQuery, [
      fuenteFinal,
      texto,
      vulneracion,
      tipoViolencia,
      citaExacta,
      justificacionLegal
    ]);

    const registroGuardado = dbResult.rows[0];
    console.log(`💾 Guardado en PostgreSQL ID: ${registroGuardado.id}`);
    console.log('======================================================\n');

    return res.status(201).json({
      status: 'exito',
      alerta: registroGuardado
    });

  } catch (error) {
    console.error('❌ Error durante el análisis con IA o almacenamiento:', error.message);
    return res.status(500).json({
      error: 'Error al procesar la transcripción con el LLM o guardar en base de datos',
      detalle: error.message
    });
  }
});

// Endpoint GET /api/alertas: Obtiene alertas almacenadas
app.get('/api/alertas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, timestamp, fuente, texto_analizado, vulneracion_detectada, tipo_violencia, cita_exacta, justificacion_legal FROM alertas ORDER BY timestamp DESC LIMIT 60'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar alertas:', error.message);
    res.status(500).json({ error: 'Error interno al consultar la base de datos' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend Orquestador escuchando en http://localhost:${PORT}`);
  console.log(`🤖 Modelo LLM: ${OLLAMA_MODEL} en ${OLLAMA_URL}`);
});
