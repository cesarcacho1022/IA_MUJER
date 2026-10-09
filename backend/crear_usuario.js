// Crea o actualiza un usuario para iniciar sesión en Qhaway Medios.
//   node crear_usuario.js                                 (pregunta los datos)
//   node crear_usuario.js usuario "Nombre Apellido" clave (sin preguntar)
//   node crear_usuario.js --desactivar usuario
// Si el usuario ya existe, se le cambian el nombre y la contraseña.
const readline = require('readline');
const { Pool } = require('pg');
const { hashClave } = require('./auth');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgrespassword',
  database: process.env.DB_NAME || 'ia_mujer_db',
});

function preguntar(pregunta, oculto) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    if (oculto && process.stdin.isTTY) {
      rl._writeToOutput = function (cadena) {
        if (cadena.includes(pregunta) || cadena === '\r\n' || cadena === '\n') rl.output.write(cadena);
        else rl.output.write('*');
      };
    }
    rl.question(pregunta, respuesta => { rl.close(); resolve(respuesta); });
  });
}

async function asegurarTabla() {
  await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    usuario VARCHAR(60) UNIQUE NOT NULL,
    nombre VARCHAR(120) NOT NULL,
    clave_hash TEXT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function main() {
  const args = process.argv.slice(2);
  await asegurarTabla();

  if (args[0] === '--desactivar') {
    const u = String(args[1] || '').trim().toLowerCase();
    const r = await pool.query('UPDATE usuarios SET activo = FALSE WHERE usuario = $1', [u]);
    if (!r.rowCount) throw new Error('No existe el usuario «' + u + '».');
    await pool.query('DELETE FROM sesiones WHERE usuario_id = (SELECT id FROM usuarios WHERE usuario = $1)', [u]).catch(() => {});
    console.log('Usuario «' + u + '» desactivado. Ya no puede iniciar sesión.');
    return;
  }

  let [usuario, nombre, clave] = args;
  if (!usuario) usuario = await preguntar('Usuario (sin espacios, ej. kolivos): ');
  usuario = String(usuario || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) throw new Error('El usuario debe tener de 3 a 60 caracteres: letras, números, punto, guion o guion bajo.');
  if (!nombre) nombre = await preguntar('Nombre que aparecerá en las decisiones (ej. Kim Olivos): ');
  nombre = String(nombre || '').trim();
  if (!nombre) throw new Error('El nombre es obligatorio.');
  if (!clave) {
    clave = await preguntar('Contraseña (mínimo 8 caracteres): ', true);
    const repetida = await preguntar('Repite la contraseña: ', true);
    if (clave !== repetida) throw new Error('Las contraseñas no coinciden.');
  }
  if (String(clave).length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');

  const hash = await hashClave(clave);
  const r = await pool.query(
    `INSERT INTO usuarios (usuario, nombre, clave_hash) VALUES ($1, $2, $3)
     ON CONFLICT (usuario) DO UPDATE SET nombre = EXCLUDED.nombre, clave_hash = EXCLUDED.clave_hash, activo = TRUE
     RETURNING (xmax = 0) AS nuevo`, [usuario, nombre, hash]);
  console.log((r.rows[0].nuevo ? 'Usuario creado: ' : 'Usuario actualizado: ') + usuario + ' (' + nombre + ')');
}

main().then(() => pool.end(), err => { console.error('ERROR: ' + err.message); pool.end(); process.exitCode = 1; });
