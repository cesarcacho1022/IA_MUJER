const express = require('express');
const cors = require('cors');
const { Pool, types: pgTypes } = require('pg');
const path = require('path');
const { hashClave, verificarClave, sha256, nuevoToken } = require('./auth');

// La columna alertas.timestamp es TIMESTAMP sin zona y la base la escribe en UTC.
// Se lee como UTC para que las horas no se corran según la zona del equipo.
pgTypes.setTypeParser(1114, valor => new Date(valor.replace(' ', 'T') + 'Z'));

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
  options: '-c TimeZone=UTC',
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Error al conectar a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conexión exitosa a PostgreSQL en Docker a las:', res.rows[0].now);
  }
});


/* ======================================================================
 * Esquema adicional: usuarios, sesiones y decisiones de la revisión humana.
 * Se crea solo si no existe, así que no hace falta tocar la base a mano.
 * ====================================================================== */
const SESION_HORAS = parseInt(process.env.SESION_HORAS || '12', 10);

async function crearEsquema() {
  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_alertas_timestamp ON alertas(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_alertas_senales ON alertas(id DESC) WHERE vulneracion_detectada;

    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario VARCHAR(60) UNIQUE NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      clave_hash TEXT NOT NULL,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sesiones (
      token_hash CHAR(64) PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      creada TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expira TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eventos_caso (
      id SERIAL PRIMARY KEY,
      alerta_id INTEGER NOT NULL REFERENCES alertas(id) ON DELETE CASCADE,
      tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('validacion', 'exportacion')),
      decision VARCHAR(20) CHECK (decision IN ('confirmada', 'descartada', 'corregida')),
      tipo_final VARCHAR(60),
      comentario TEXT,
      norma JSONB,
      modelo VARCHAR(120),
      archivo VARCHAR(200),
      usuario_id INTEGER REFERENCES usuarios(id),
      revisor VARCHAR(120) NOT NULL,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_alerta ON eventos_caso(alerta_id);
  `);
}
// La base de datos puede tardar en levantar: se reintenta hasta lograrlo.
(function iniciarEsquema() {
  crearEsquema().then(
    async () => {
      console.log('✅ Tablas de usuarios, sesiones y decisiones listas');
      const hay = await pool.query('SELECT 1 FROM usuarios WHERE activo LIMIT 1');
      if (!hay.rowCount) console.log('⚠️  Aún no hay usuarios para iniciar sesión. Ejecuta crear_usuario.bat (o: node crear_usuario.js).');
    },
    err => { console.error('⏳ Esquema pendiente (' + err.message + '). Reintentando en 5 s...'); setTimeout(iniciarEsquema, 5000); }
  );
})();

function leerCookie(req, nombre) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) { try { return decodeURIComponent(parte.slice(i + 1).trim()); } catch (e) { return null; } }
  }
  return null;
}
async function usuarioDeSesion(req) {
  const token = leerCookie(req, 'qhaway_sesion');
  if (!token) return null;
  const r = await pool.query(
    `SELECT u.id, u.usuario, u.nombre FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = $1 AND s.expira > NOW() AND u.activo`, [sha256(token)]);
  return r.rows[0] || null;
}
async function requiereSesion(req, res, next) {
  try {
    const u = await usuarioDeSesion(req);
    if (!u) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    req.usuario = u;
    next();
  } catch (error) {
    console.error('Error al validar la sesión:', error.message);
    res.status(500).json({ error: 'Error interno al validar la sesión' });
  }
}
const cookieSesion = (valor, segundos) => 'qhaway_sesion=' + valor + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + segundos;

// Máximo de 5 intentos fallidos por usuario y equipo cada minuto.
const intentosFallidos = new Map();

app.get('/api/sesion', async (req, res) => {
  try {
    const usuario = await usuarioDeSesion(req);
    const hay = await pool.query('SELECT 1 FROM usuarios WHERE activo LIMIT 1');
    res.json({ usuario, hay_usuarios: hay.rowCount > 0 });
  } catch (error) {
    console.error('Error al consultar la sesión:', error.message);
    res.status(500).json({ error: 'Error interno al consultar la sesión' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const usuario = String((req.body && req.body.usuario) || '').trim().toLowerCase();
    const clave = String((req.body && req.body.clave) || '');
    const llave = req.ip + '|' + usuario;
    const previo = intentosFallidos.get(llave);
    if (previo && previo.n >= 5 && Date.now() < previo.hasta) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto y vuelve a probar.' });
    }
    const r = await pool.query('SELECT id, usuario, nombre, clave_hash, activo FROM usuarios WHERE usuario = $1', [usuario]);
    const u = r.rows[0];
    // Con usuario inexistente se calcula igual un hash, para no delatar si la cuenta existe.
    const ok = await verificarClave(clave, u ? u.clave_hash : 'scrypt$00$00') && u && u.activo;
    if (!ok) {
      const n = previo && Date.now() < previo.hasta ? previo.n + 1 : 1;
      intentosFallidos.set(llave, { n, hasta: Date.now() + 60000 });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    intentosFallidos.delete(llave);
    await pool.query('DELETE FROM sesiones WHERE expira < NOW()');
    const token = nuevoToken();
    await pool.query("INSERT INTO sesiones (token_hash, usuario_id, expira) VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)", [sha256(token), u.id, String(SESION_HORAS)]);
    res.set('Set-Cookie', cookieSesion(token, SESION_HORAS * 3600));
    res.json({ usuario: { id: u.id, usuario: u.usuario, nombre: u.nombre } });
  } catch (error) {
    console.error('Error al iniciar sesión:', error.message);
    res.status(500).json({ error: 'Error interno al iniciar sesión' });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const token = leerCookie(req, 'qhaway_sesion');
    if (token) await pool.query('DELETE FROM sesiones WHERE token_hash = $1', [sha256(token)]);
  } catch (error) {
    console.error('Error al cerrar sesión:', error.message);
  }
  res.set('Set-Cookie', cookieSesion('', 0));
  res.json({ ok: true });
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

// Endpoint GET /api/alertas: obtiene alertas almacenadas (requiere sesión).
//   ?limite=60        cuántas devolver (máximo 200)
//   ?antes=ID         solo las anteriores a ese id (para pedir páginas más antiguas)
//   ?solo_senales=1   solo las que tienen posible vulneración
// El encabezado X-Hay-Mas indica si hay señales más antiguas que la última fila devuelta.
const COLUMNAS_ALERTA = 'id, timestamp, fuente, texto_analizado, vulneracion_detectada, tipo_violencia, cita_exacta, justificacion_legal';
app.get('/api/alertas', requiereSesion, async (req, res) => {
  try {
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 60, 1), 200);
    const antes = parseInt(req.query.antes, 10);
    const cond = [], params = [];
    if (req.query.solo_senales === '1') cond.push('vulneracion_detectada');
    if (Number.isFinite(antes)) { params.push(antes); cond.push('id < $' + params.length); }
    params.push(limite);
    const result = await pool.query(
      `SELECT ${COLUMNAS_ALERTA} FROM alertas ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
    let hayMas = false;
    if (result.rows.length) {
      const mas = await pool.query('SELECT 1 FROM alertas WHERE vulneracion_detectada AND id < $1 LIMIT 1', [result.rows[result.rows.length - 1].id]);
      hayMas = mas.rowCount > 0;
    }
    res.set('X-Hay-Mas', hayMas ? '1' : '0');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar alertas:', error.message);
    res.status(500).json({ error: 'Error interno al consultar la base de datos' });
  }
});

// Conteo de segmentos analizados por fuente en un periodo (para el Observatorio).
app.get('/api/resumen', requiereSesion, async (req, res) => {
  const desde = new Date(req.query.desde), hasta = new Date(req.query.hasta);
  if (isNaN(desde.getTime()) || isNaN(hasta.getTime())) return res.status(400).json({ error: 'desde y hasta deben ser fechas ISO.' });
  try {
    const r = await pool.query(
      `SELECT fuente, COUNT(*)::int AS analizados, (COUNT(*) FILTER (WHERE vulneracion_detectada))::int AS senales
       FROM alertas
       WHERE timestamp >= ($1::timestamptz AT TIME ZONE 'UTC') AND timestamp < ($2::timestamptz AT TIME ZONE 'UTC')
       GROUP BY fuente`, [desde.toISOString(), hasta.toISOString()]);
    res.json(r.rows);
  } catch (error) {
    console.error('Error al resumir alertas:', error.message);
    res.status(500).json({ error: 'Error interno al consultar la base de datos' });
  }
});

/* ======================================================================
 * Decisiones de la revisión humana y exportaciones (requieren sesión).
 * Son eventos que solo se agregan: así queda la historia completa del caso.
 * La persona que firma es siempre la de la sesión, no un dato del cliente.
 * ====================================================================== */
const TIPOS_PROBLEMATICA = ['Estereotipo', 'Culpabilización', 'Revictimización', 'Normalización', 'Sin clasificar'];
const SELECT_EVENTO = `SELECT e.id, e.alerta_id, e.tipo, e.decision, e.tipo_final, e.comentario, e.norma, e.modelo, e.archivo, e.revisor, e.creado,
                              a.fuente, a.timestamp AS alerta_ts
                       FROM eventos_caso e JOIN alertas a ON a.id = e.alerta_id`;
const texto = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

app.get('/api/eventos', requiereSesion, async (req, res) => {
  try {
    const despues = parseInt(req.query.despues, 10) || 0;
    const r = await pool.query(SELECT_EVENTO + ' WHERE e.id > $1 ORDER BY e.id ASC LIMIT 5000', [despues]);
    res.json(r.rows);
  } catch (error) {
    console.error('Error al consultar eventos:', error.message);
    res.status(500).json({ error: 'Error interno al consultar la base de datos' });
  }
});

app.post('/api/eventos', requiereSesion, async (req, res) => {
  try {
    const b = req.body || {};
    const alertaId = parseInt(b.alerta_id, 10);
    if (!Number.isFinite(alertaId)) return res.status(400).json({ error: 'alerta_id requerido.' });
    const alerta = await pool.query('SELECT id, vulneracion_detectada FROM alertas WHERE id = $1', [alertaId]);
    if (!alerta.rowCount) return res.status(404).json({ error: 'El caso ya no existe.' });

    let datos;
    if (b.tipo === 'validacion') {
      if (!alerta.rows[0].vulneracion_detectada) return res.status(400).json({ error: 'Solo se validan señales con posible vulneración.' });
      if (!['confirmada', 'descartada', 'corregida'].includes(b.decision)) return res.status(400).json({ error: 'Decisión no válida.' });
      const comentario = texto(b.comentario, 2000);
      if (!comentario) return res.status(400).json({ error: 'El comentario es obligatorio.' });
      const tipoFinal = texto(b.tipo_final, 60) || null;
      if (b.decision === 'corregida' && (!tipoFinal || tipoFinal === 'Sin clasificar' || !TIPOS_PROBLEMATICA.includes(tipoFinal))) {
        return res.status(400).json({ error: 'Indica el tipo de problemática correcto.' });
      }
      if (tipoFinal && !TIPOS_PROBLEMATICA.includes(tipoFinal)) return res.status(400).json({ error: 'Tipo de problemática no válido.' });
      let norma = null;
      if (b.norma && b.decision !== 'descartada') {
        const nombre = texto(b.norma.nombre, 300);
        if (!nombre) return res.status(400).json({ error: 'La normativa corregida necesita un nombre.' });
        norma = { id: texto(b.norma.id, 40) || 'otra', nombre, original: texto(b.norma.original, 300) || null };
      }
      datos = { tipo: 'validacion', decision: b.decision, tipo_final: tipoFinal, comentario, norma, modelo: texto(b.modelo, 120) || null, archivo: null };
    } else if (b.tipo === 'exportacion') {
      const previa = await pool.query("SELECT 1 FROM eventos_caso WHERE alerta_id = $1 AND tipo = 'validacion' LIMIT 1", [alertaId]);
      if (!previa.rowCount) return res.status(409).json({ error: 'El caso aún no tiene una decisión.' });
      const archivo = texto(b.archivo, 200);
      if (!archivo) return res.status(400).json({ error: 'archivo requerido.' });
      datos = { tipo: 'exportacion', decision: null, tipo_final: null, comentario: null, norma: null, modelo: null, archivo };
    } else {
      return res.status(400).json({ error: 'Tipo de evento no válido.' });
    }

    const ins = await pool.query(
      `INSERT INTO eventos_caso (alerta_id, tipo, decision, tipo_final, comentario, norma, modelo, archivo, usuario_id, revisor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [alertaId, datos.tipo, datos.decision, datos.tipo_final, datos.comentario, datos.norma ? JSON.stringify(datos.norma) : null,
       datos.modelo, datos.archivo, req.usuario.id, req.usuario.nombre]);
    const fila = await pool.query(SELECT_EVENTO + ' WHERE e.id = $1', [ins.rows[0].id]);
    console.log(`📝 ${datos.tipo} del caso #${alertaId} por ${req.usuario.usuario}${datos.decision ? ': ' + datos.decision : ''}`);
    res.status(201).json(fila.rows[0]);
  } catch (error) {
    console.error('Error al guardar el evento:', error.message);
    res.status(500).json({ error: 'Error interno al guardar en la base de datos' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend Orquestador escuchando en http://localhost:${PORT}`);
  console.log(`🤖 Modelo LLM: ${OLLAMA_MODEL} en ${OLLAMA_URL}`);
});
