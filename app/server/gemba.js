'use strict';
// Gemba: hallazgos registrados en piso (quién, foto, área, lugar/máquina, fecha, observación, a quién va dirigido).
// "Dirigido a" es el nombre de una persona (texto libre; más adelante habrá usuarios). Visibilidad: administrador y áreas ven todos.
const L = require('./logic');
const D = require('./db');

const ID_OK = /^G-[0-9a-z]{8,32}$/;
const FOTO_OK = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const FOTO_MAX = 1.5 * 1024 * 1024; // bytes ya decodificados (el cliente la reduce a ~150 KB)
const LIMITE_LISTA = 300;
const PUBLICO_MAX = 40; // registros sin sesión por IP en la ventana
const PUBLICO_VENTANA_MS = 10 * 60 * 1000;

function registrar({ app, db, auth, wrap, fail, ahora, getCfg, correos }) {
  const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const sinConfig = (req, res, next) => (getCfg() ? next() : res.status(409).json({ error: 'Aún no hay configuración. El administrador debe importarla.', sinConfig: true }));
  // Registrar un hallazgo no pide sesión (se hace desde la pantalla de acceso de la planta): quien lo envía queda como "publico".
  // Si trae sesión se valida y el hallazgo queda a nombre de su área (o del administrador).
  const dueno = (req) => (!req.user ? 'publico' : req.user.rol === 'admin' ? 'admin' : req.user.area);
  const conSesionOpcional = (req, res, next) => (req.get('authorization') ? auth()(req, res, next) : next());
  const intentos = new Map();
  function limitarPublico(req) {
    if (req.user) return;
    const ahoraMs = Date.now();
    if (intentos.size > 2000) for (const [k, v] of intentos) if (ahoraMs - v.t0 > PUBLICO_VENTANA_MS) intentos.delete(k);
    const r = intentos.get(req.ip);
    if (!r || ahoraMs - r.t0 > PUBLICO_VENTANA_MS) intentos.set(req.ip, { n: 1, t0: ahoraMs });
    else if (++r.n > PUBLICO_MAX) fail(429, 'Demasiados registros desde este equipo. Espera unos minutos e inténtalo de nuevo.');
  }
  const publico = (g) => ({
    id: g.id, creado: g.creado, registrante: g.registrante, area_registra: g.area_registra, fecha: g.fecha,
    area: g.area, lugar: g.lugar, observacion: g.observacion, dirigido: g.dirigido, foto: !!g.foto_tipo,
  });
  const COLS = 'id, creado, registrante, area_registra, fecha, area, lugar, observacion, dirigido, foto_tipo';

  app.put('/api/gemba/:id', conSesionOpcional, sinConfig, wrap(async (req, res) => {
    const id = req.params.id;
    if (!ID_OK.test(id)) fail(400, 'ID de hallazgo inválido.');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const cfg = getCfg();
    const previo = await db.uno(`SELECT ${COLS} FROM gemba WHERE id = ?`, [id]);
    if (previo) { // reintento de un envío que sí llegó: no se duplica (y no cuenta contra el límite)
      if (previo.area_registra !== dueno(req)) fail(409, 'Ese ID de hallazgo ya existe.');
      return res.json(publico(previo));
    }
    limitarPublico(req);
    const errores = [];
    const registrante = texto(b.registrante, 200);
    if (!registrante) errores.push('Escribe quién registra el hallazgo.');
    const lugar = texto(b.lugar, 200);
    if (!lugar) errores.push('Escribe el lugar o la máquina.');
    const observacion = texto(b.observacion, 2000);
    if (!observacion) errores.push('Escribe la observación.');
    const fecha = typeof b.fecha === 'string' ? b.fecha : '';
    if (Number.isNaN(L.parseYMD(fecha))) errores.push('La fecha debe tener formato aaaa-mm-dd.');
    const existe = (a) => typeof a === 'string' && cfg.areaIdx.has(a);
    if (!existe(b.area)) errores.push('Elige el área del hallazgo.');
    const dirigido = texto(b.dirigido, 200);
    if (!dirigido) errores.push('Escribe a quién va dirigido.');
    const m = typeof b.foto === 'string' ? FOTO_OK.exec(b.foto) : null;
    let foto = null;
    if (!m) errores.push('Agrega la foto del problema (JPG, PNG o WebP).');
    else {
      foto = Buffer.from(m[2], 'base64');
      if (foto.length > FOTO_MAX) errores.push('La foto es demasiado grande.');
    }
    if (errores.length) fail(422, errores.join(' '), { errores });
    const creado = typeof b.creado === 'string' && !Number.isNaN(Date.parse(b.creado)) ? new Date(b.creado).toISOString() : ahora().toISOString();
    await db.q(
      'INSERT INTO gemba (id, creado, registrante, area_registra, fecha, area, lugar, observacion, dirigido, foto_tipo, foto, dispositivo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, creado, registrante, dueno(req), fecha, b.area, lugar, observacion, dirigido, m[1], foto, texto(b.dispositivo, 64) || null]);
    await D.bitacora(db, dueno(req), 'gemba', `${id} ${b.area}`);
    if (correos) correos.gembaNuevo({ id, registrante, fecha, area: b.area, lugar, observacion, dirigido, fotoTipo: m[1], fotoBase64: m[2] }); // aviso por correo, sin esperar
    res.json(publico(await db.uno(`SELECT ${COLS} FROM gemba WHERE id = ?`, [id])));
  }));

  app.get('/api/gemba', auth(), wrap(async (req, res) => {
    const filas = await db.q(`SELECT ${COLS} FROM gemba ORDER BY fecha DESC, creado DESC LIMIT ?`, [LIMITE_LISTA]);
    res.json(filas.map(publico));
  }));

  app.get('/api/gemba/:id/foto', auth(), wrap(async (req, res) => {
    const g = await db.uno('SELECT id, foto_tipo, foto FROM gemba WHERE id = ?', [req.params.id]);
    if (!g || !g.foto) fail(404, 'No hay foto para ese hallazgo.');
    res.set('Content-Type', g.foto_tipo);
    res.send(g.foto);
  }));

  app.delete('/api/gemba/:id', auth('admin'), wrap(async (req, res) => {
    const r = await db.q('DELETE FROM gemba WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) fail(404, 'Ese hallazgo no existe.');
    await D.bitacora(db, 'admin', 'gemba_borrado', req.params.id);
    res.json({ ok: true });
  }));
}

module.exports = { registrar };
