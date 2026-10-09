// Contraseñas y sesiones. Usa solo módulos incluidos en Node (sin dependencias nuevas).
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

async function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(String(clave), sal, 64);
  return 'scrypt$' + sal.toString('hex') + '$' + h.toString('hex');
}

async function verificarClave(clave, guardado) {
  const [alg, salHex, hashHex] = String(guardado || '').split('$');
  if (alg !== 'scrypt' || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const h = await scrypt(String(clave), Buffer.from(salHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(h, esperado);
}

const sha256 = texto => crypto.createHash('sha256').update(texto).digest('hex');
const nuevoToken = () => crypto.randomBytes(32).toString('hex');

module.exports = { hashClave, verificarClave, sha256, nuevoToken };
