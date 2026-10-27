'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const L = require('./logic');
const { validarConfig } = require('./configImport');
const D = require('./db');
const { crearCorreos, registrar: registrarCorreos } = require('./correos');
const { INACTIVO: CORREO_INACTIVO } = require('./correo');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TTL_AREA = '14d';
const TTL_ADMIN = '12h';
const LOGIN_MAX = 8;
const LOGIN_VENTANA_MS = 10 * 60 * 1000;
// hash de relleno: el login tarda lo mismo exista o no el área
const HASH_RELLENO = bcrypt.hashSync('relleno-sin-uso', 10);

const ahora = () => (process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date());

class HttpError extends Error {
  constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; }
}
const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };

function igualesSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function csvCelda(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas al abrir en Excel
  return `"${s.replace(/"/g, '""')}"`;
}

const REINTENTABLE = new Set(['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

// conexion = { host, port, user, password, database }
// correo = cliente de Microsoft Graph (./correo); adminCorreos = destinatarios de los avisos al administrador; programar = revisión diaria
async function createApp({ conexion, adminPassword, jwtSecret, trustProxy = '1', correo = CORREO_INACTIVO, plantaNombre = '', adminCorreos = [], urlApp = '', programar = false, horaCorreo = 8 }) {
  const db = await D.abrir(conexion);
  let cfg = await D.cargarConfig(db);
  const app = express();
  const secreto = jwtSecret || crypto.randomBytes(32).toString('hex');
  if (!jwtSecret) console.warn('[aviso] JWT_SECRET no definido: se generó uno temporal; las sesiones se pierden al reiniciar.');
  if (!adminPassword) console.warn('[aviso] ADMIN_PASSWORD no definido: el acceso de administrador está deshabilitado.');

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy === 'false' ? false : (/^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy));

  app.use((req, res, next) => { res.locals.nonce = crypto.randomBytes(16).toString('base64'); next(); });
  app.use(helmet({
    hsts: false, // el HSTS lo aplica el proxy HTTPS
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: '3mb' }));

  // CORS cerrado: no se emiten cabeceras CORS y se rechazan escrituras de otro origen.
  app.use('/api', (req, res, next) => {
    const o = req.get('origin');
    if (o && req.method !== 'GET' && req.method !== 'HEAD') {
      let host = '';
      try { host = new URL(o).host; } catch { /* origen inválido */ }
      if (host !== req.get('host')) return res.status(403).json({ error: 'Origen no permitido.' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ---------- autenticación ----------
  const intentos = new Map();
  const claveIntento = (req, quien) => `${req.ip}|${quien}`;
  function bloqueado(clave) {
    const r = intentos.get(clave);
    if (!r) return 0;
    if (Date.now() - r.t0 > LOGIN_VENTANA_MS) { intentos.delete(clave); return 0; }
    return r.n >= LOGIN_MAX ? Math.ceil((LOGIN_VENTANA_MS - (Date.now() - r.t0)) / 60000) : 0;
  }
  function falla(clave) {
    if (intentos.size > 5000) for (const [k, v] of intentos) if (Date.now() - v.t0 > LOGIN_VENTANA_MS) intentos.delete(k);
    const r = intentos.get(clave);
    if (!r || Date.now() - r.t0 > LOGIN_VENTANA_MS) intentos.set(clave, { n: 1, t0: Date.now() });
    else r.n += 1;
  }

  const firmar = (payload, exp) => jwt.sign(payload, secreto, { algorithm: 'HS256', expiresIn: exp });
  const wrap = (fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };

  function auth(requerido) {
    return wrap(async (req, res, next) => {
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      if (!m) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
      let p;
      try { p = jwt.verify(m[1], secreto, { algorithms: ['HS256'] }); } catch (e) {
        return res.status(401).json({ error: 'Tu sesión venció. Inicia sesión de nuevo.', vencida: true });
      }
      if (p.rol === 'lobby') {
        const u = await db.uno("SELECT actualizado FROM usuarios WHERE area = 'lobby'");
        if (!u || u.actualizado !== p.pv) return res.status(401).json({ error: 'La contraseña de lobby cambió. Inicia sesión de nuevo.', vencida: true });
        if (requerido !== 'lobby') return res.status(403).json({ error: 'Este usuario solo puede ver el dashboard.' });
      }
      if (requerido === 'lobby' && p.rol === 'area') return res.status(403).json({ error: 'No tienes acceso al dashboard de lobby.' });
      if (p.rol === 'area') {
        const u = await db.uno('SELECT actualizado FROM usuarios WHERE area = ?', [p.area]);
        const ar = cfg.areas[cfg.areaIdx.get(p.area)];
        if (!u || u.actualizado !== p.pv || !ar || !ar.activa) return res.status(401).json({ error: 'Tu PIN cambió o el área ya no existe. Inicia sesión de nuevo.', vencida: true });
      }
      if (requerido === 'admin' && p.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede hacer esto.' });
      req.user = p;
      next();
    });
  }
  const quien = (req) => (req.user.rol === 'admin' ? 'admin' : req.user.area);
  const necesitaCfg = (req, res, next) => (cfg ? next() : res.status(409).json({ error: 'Aún no hay configuración. El administrador debe importarla.', sinConfig: true }));

  // ---------- públicos ----------
  app.get('/api/salud', wrap(async (req, res) => {
    try { await db.q('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false, error: 'Base de datos no disponible.' }); }
  }));

  app.get('/api/areas', wrap((req, res) => {
    const activas = cfg.areas.filter((a) => a.activa);
    res.json({ configurada: activas.length > 0, nombre: cfg.nombre, areas: activas.map((a) => ({ id: a.id, nombre: a.nombre })) });
  }));

  app.post('/api/login', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.admin) {
      const clave = claveIntento(req, 'admin');
      const esp = bloqueado(clave);
      if (esp) fail(429, `Demasiados intentos. Espera ${esp} min e inténtalo de nuevo.`);
      if (!adminPassword || typeof b.password !== 'string' || !igualesSeguro(b.password, adminPassword)) {
        falla(clave);
        await D.bitacora(db, 'admin', 'login_fallido', req.ip);
        fail(401, 'Contraseña de administrador incorrecta.');
      }
      intentos.delete(clave);
      await D.bitacora(db, 'admin', 'login', req.ip);
      return res.json({ token: firmar({ rol: 'admin' }, TTL_ADMIN), rol: 'admin' });
    }
    if (b.lobby) {
      const clave = claveIntento(req, 'lobby');
      const esp = bloqueado(clave);
      if (esp) fail(429, `Demasiados intentos. Espera ${esp} min e inténtalo de nuevo.`);
      const pw = typeof b.password === 'string' ? b.password : '';
      const u = await db.uno("SELECT pin_hash, actualizado FROM usuarios WHERE area = 'lobby'");
      const coincide = await bcrypt.compare(pw.slice(0, 72), u ? u.pin_hash : HASH_RELLENO);
      if (!(u && coincide)) {
        falla(clave);
        await D.bitacora(db, 'lobby', 'login_fallido', req.ip);
        fail(u ? 401 : 403, u ? 'Contraseña de lobby incorrecta.' : 'El usuario lobby aún no tiene contraseña. El administrador debe establecerla.');
      }
      intentos.delete(clave);
      await D.bitacora(db, 'lobby', 'login', req.ip);
      return res.json({ token: firmar({ rol: 'lobby', pv: u.actualizado }, '30d'), rol: 'lobby' });
    }
    const area = typeof b.area === 'string' ? b.area : '';
    const pin = typeof b.pin === 'string' ? b.pin : '';
    const clave = claveIntento(req, area);
    const esp = bloqueado(clave);
    if (esp) fail(429, `Demasiados intentos con este PIN. Espera ${esp} min e inténtalo de nuevo.`);
    const u = await db.uno('SELECT pin_hash, actualizado FROM usuarios WHERE area = ?', [area]);
    const arLogin = cfg.areas[cfg.areaIdx.get(area)];
    if (arLogin && !arLogin.activa) fail(403, 'Esta área está desactivada. Pide al administrador que la reactive.');
    if (arLogin && !u) fail(403, 'Esta área aún no tiene PIN. Pide al administrador que lo establezca.');
    // se compara siempre contra un hash para no revelar (por tiempo de respuesta) si el área existe
    const coincide = await bcrypt.compare(pin.slice(0, 72), u ? u.pin_hash : HASH_RELLENO);
    if (!(u && /^\d{4,6}$/.test(pin) && coincide)) {
      falla(clave);
      await D.bitacora(db, area || '?', 'login_fallido', req.ip);
      fail(401, 'Área o PIN incorrectos. Revisa el PIN (4 a 6 dígitos).');
    }
    intentos.delete(clave);
    await D.bitacora(db, area, 'login', req.ip);
    res.json({ token: firmar({ rol: 'area', area, pv: u.actualizado }, TTL_AREA), rol: 'area', area });
  }));

  // ---------- configuración ----------
  app.get('/api/config', auth(), necesitaCfg, wrap((req, res) => {
    const hoy = L.localYMD(ahora());
    res.json({ config: D.configParaApi(cfg), hoy, ahora: ahora().toISOString(), semana: L.semanaActual(cfg.inicio, hoy, cfg.semanas) });
  }));

  app.put('/api/config', auth('admin'), wrap(async (req, res) => {
    const v = validarConfig(req.body);
    if (!v.ok) return res.status(422).json({ error: 'La configuración tiene errores. Corrígelos y vuelve a importar.', errores: v.errores });
    await D.guardarConfig(db, req.body, { nuevoCiclo: req.query.nuevo_ciclo === '1' });
    cfg = await D.cargarConfig(db);
    await D.bitacora(db, 'admin', 'config_importada', `${cfg.areas.length} áreas, ${cfg.checklists.size} checklists, ${cfg.semanas} semanas`);
    res.json({ ok: true, areas: cfg.areas.length, checklists: cfg.checklists.size, semanas: cfg.semanas, inicio: cfg.inicio });
  }));

  // Cambia solo la fecha de inicio del ciclo (recorre todas las fechas de las semanas y sus fechas límite).
  // Las auditorías ya capturadas se conservan: siguen ligadas a su semana (S03-A12) y se pasan al ciclo con la fecha nueva.
  app.put('/api/config/inicio', auth('admin'), necesitaCfg, wrap(async (req, res) => {
    const nuevo = req.body && req.body.inicio;
    if (typeof nuevo !== 'string' || Number.isNaN(L.parseYMD(nuevo))) fail(422, 'La fecha de inicio debe tener formato yyyy-mm-dd y ser una fecha válida.');
    const previo = cfg.inicio;
    if (nuevo === previo) return res.json({ ok: true, inicio: previo, sinCambios: true });
    const { c: cantidad } = await db.uno("SELECT COUNT(*) AS c FROM auditorias WHERE ciclo = ? AND id NOT LIKE '%/%'", [previo]);
    if (cantidad && req.query.confirmar !== '1') {
      return res.status(409).json({
        error: `Hay ${cantidad} auditoría${cantidad === 1 ? '' : 's'} capturada${cantidad === 1 ? '' : 's'} en este ciclo. Se conservarán, pero sus fechas límite y su estatus se recalcularán con la nueva fecha de inicio.`,
        codigo: 'confirmar_inicio', cantidad,
      });
    }
    await db.tx(async (t) => {
      await t.q("UPDATE parametros SET valor = ? WHERE clave = 'inicio'", [nuevo]);
      await t.q("UPDATE auditorias SET ciclo = ? WHERE ciclo = ? AND id NOT LIKE '%/%'", [nuevo, previo]);
    });
    cfg = await D.cargarConfig(db);
    await D.bitacora(db, 'admin', 'inicio_cambiado', `${previo} → ${nuevo} (${cantidad} auditorías conservadas)`);
    res.json({ ok: true, inicio: nuevo, anterior: previo, auditorias: cantidad, semanas: cfg.semanas });
  }));

  // ---------- administración en la app: áreas, checklists, ciclo y rotación ----------
  require('./admin').registrar({ app, db, auth, wrap, fail, ahora, getCfg: () => cfg, recargar: async () => { cfg = await D.cargarConfig(db); return cfg; }, nuevaVersion: () => crypto.randomBytes(8).toString('hex'), SQL_PIN: `INSERT INTO usuarios (area, pin_hash, actualizado) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE pin_hash = VALUES(pin_hash), actualizado = VALUES(actualizado)` });

  // ---------- correo (Microsoft Graph): avisos de Gemba, recordatorios y resumen semanal ----------
  const correos = crearCorreos({ db, getCfg: () => cfg, ahora, filaSemana, mapaAuditorias, correo, planta: plantaNombre || 'planta', adminCorreos, urlApp });
  registrarCorreos({ app, auth, wrap, fail, correos, correo });
  if (programar) correos.iniciar({ hora: horaCorreo });

  // ---------- Gemba: hallazgos con foto ----------
  require('./gemba').registrar({ app, db, auth, wrap, fail, ahora, getCfg: () => cfg, correos });

  // ---------- usuarios (PIN) ----------
  const SQL_PIN = `INSERT INTO usuarios (area, pin_hash, actualizado) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE pin_hash = VALUES(pin_hash), actualizado = VALUES(actualizado)`;
  const nuevaVersion = () => crypto.randomBytes(8).toString('hex');

  app.get('/api/usuarios', auth('admin'), necesitaCfg, wrap(async (req, res) => {
    const con = new Set((await db.q('SELECT area FROM usuarios')).map((r) => r.area));
    res.json(cfg.areas.map((a) => ({ area: a.id, nombre: a.nombre, activa: a.activa, tiene_pin: con.has(a.id) })));
  }));

  app.put('/api/usuarios/:area/pin', auth('admin'), necesitaCfg, wrap(async (req, res) => {
    const { area } = req.params;
    if (!cfg.areaIdx.has(area)) fail(404, 'El área no existe.');
    const pin = req.body && req.body.pin;
    if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) fail(422, 'El PIN debe tener de 4 a 6 dígitos.');
    await db.q(SQL_PIN, [area, await bcrypt.hash(pin, 10), nuevaVersion()]);
    await D.bitacora(db, 'admin', 'pin_establecido', area);
    res.json({ ok: true });
  }));

  // Genera PIN aleatorios para las áreas sin PIN (o para todas con {todos:true}); se muestran una sola vez.
  app.post('/api/usuarios/pines-iniciales', auth('admin'), necesitaCfg, wrap(async (req, res) => {
    const todos = !!(req.body && req.body.todos);
    const con = new Set((await db.q('SELECT area FROM usuarios')).map((r) => r.area));
    const salida = [];
    for (const a of cfg.areas) {
      if (!a.activa || (!todos && con.has(a.id))) continue;
      salida.push({ area: a.id, nombre: a.nombre, pin: String(crypto.randomInt(0, 10000)).padStart(4, '0') });
    }
    const hashes = await Promise.all(salida.map((s) => bcrypt.hash(s.pin, 10)));
    await db.tx(async (t) => { for (let i = 0; i < salida.length; i++) await t.q(SQL_PIN, [salida[i].area, hashes[i], nuevaVersion()]); });
    await D.bitacora(db, 'admin', 'pines_generados', `${salida.length} áreas`);
    res.json(salida);
  }));

  app.get('/api/bitacora', auth('admin'), wrap(async (req, res) => {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    res.json(await db.q('SELECT ts, quien, accion, detalle FROM bitacora ORDER BY id DESC LIMIT ?', [lim]));
  }));

  // ---------- auditorías ----------
  const cicloActual = () => cfg.inicio;

  async function filaApi(r, conDetalle, admin = false) {
    const c = cfg.checklists.get(r.checklist);
    const limite = L.fechaLimite(cfg.inicio, r.semana, cfg.dias);
    const final = r.estado === 'final';
    const o = {
      id: r.id, semana: r.semana, auditora: r.auditora, auditada: r.auditada, subarea: r.subarea || null, maquina: r.maquina || null, checklist: r.checklist,
      persona_audita: r.persona_audita, responsable: r.responsable, nomina_auditado: r.nomina_auditado, fecha: r.fecha, estado: r.estado,
      creado: r.creado, terminado: r.terminado, dispositivo: r.dispositivo,
      calificacion: r.calificacion, nivel: r.nivel,
      fecha_limite: limite,
      entrega: final && r.terminado ? L.entrega(L.localYMD(new Date(r.terminado)), limite) : null,
    };
    if (conDetalle) {
      o.firma = r.firma; // solo auditorías antiguas, capturadas cuando aún se pedía firma
      if (admin) o.duracion_seg = r.duracion_seg; // el tiempo de captura solo lo ve el administrador
      o.respuestas = await db.q('SELECT n, puntos, hallazgo, accion FROM respuestas WHERE auditoria_id = ? ORDER BY n', [r.id]);
      o.total = c ? c.total : null;
    }
    return o;
  }

  const obtener = (id) => db.uno('SELECT * FROM auditorias WHERE id = ? AND ciclo = ?', [id, cicloActual()]);

  // un área ve las auditorías que hace y las que recibió ya finalizadas; el administrador, todas
  const puedeVer = (u, r) => u.rol === 'admin' || (u.rol === 'area' && (r.auditora === u.area || (r.auditada === u.area && r.estado === 'final')));

  app.get('/api/auditorias', auth(), necesitaCfg, wrap(async (req, res) => {
    const w = ['ciclo = ?'];
    const args = [cicloActual()];
    if (req.query.semana) { w.push('semana = ?'); args.push(parseInt(req.query.semana, 10) || 0); }
    // un área solo ve las auditorías en las que participa (las que hace y las que recibe ya finalizadas)
    const propia = req.user.rol === 'area' ? req.user.area : null;
    const filtroArea = propia || (req.query.area ? String(req.query.area) : null);
    if (filtroArea) { w.push('(auditora = ? OR auditada = ?)'); args.push(filtroArea, filtroArea); }
    if (propia) { w.push("(auditora = ? OR estado = 'final')"); args.push(propia); }
    if (req.query.estado === 'final' || req.query.estado === 'borrador') { w.push('estado = ?'); args.push(req.query.estado); }
    const filas = await db.q(`SELECT * FROM auditorias WHERE ${w.join(' AND ')} ORDER BY semana, id`, args);
    const salida = [];
    for (const r of filas) salida.push(await filaApi(r, req.query.detalle === '1', req.user.rol === 'admin'));
    res.json(salida);
  }));

  app.get('/api/auditorias/:id', auth(), necesitaCfg, wrap(async (req, res) => {
    const r = await obtener(req.params.id);
    if (!r) fail(404, 'Esa auditoría no se ha guardado en el servidor.');
    if (!puedeVer(req.user, r)) fail(403, 'Solo puedes ver los reportes de tu área.');
    res.json(await filaApi(r, true, req.user.rol === 'admin'));
  }));

  function evaluarRespuestas(c, lista, final) {
    const errores = [];
    if (!Array.isArray(lista)) return { errores: ['"respuestas" debe ser una lista.'] };
    const porN = new Map(c.puntos.map((p) => [p.n, p]));
    const vistos = new Set();
    const limpias = [];
    for (const r of lista) {
      const p = r && porN.get(r.n);
      if (!p) { errores.push(`El punto ${r && r.n} no existe en el checklist ${c.codigo}.`); continue; }
      if (vistos.has(r.n)) { errores.push(`El punto ${r.n} viene repetido.`); continue; }
      vistos.add(r.n);
      const pts = r.puntos === null || r.puntos === undefined ? null : r.puntos;
      if (pts !== null && (!Number.isInteger(pts) || pts < 0 || pts > p.p)) {
        errores.push(`Punto ${r.n}: el puntaje debe ser un entero de 0 a ${p.p} (se recibió ${JSON.stringify(r.puntos)}).`);
        continue;
      }
      const texto = (x) => (typeof x === 'string' ? x.trim().slice(0, 1000) : '');
      const bajo = pts !== null && pts < p.p;
      limpias.push({ n: r.n, puntos: pts, hallazgo: bajo ? texto(r.hallazgo) : '', accion: bajo ? texto(r.accion) : '' });
    }
    let obtenidos = 0;
    const respondidos = new Set();
    for (const r of limpias) { if (r.puntos !== null) { obtenidos += r.puntos; respondidos.add(r.n); } }
    if (final) {
      const faltan = c.puntos.filter((p) => !respondidos.has(p.n)).map((p) => p.n);
      if (faltan.length) errores.push(`Faltan puntos por contestar: ${faltan.join(', ')}.`);
      // todo punto con puntaje menor al máximo exige hallazgo; la acción correctiva es opcional
      const sinHallazgo = limpias.filter((r) => r.puntos !== null && r.puntos < porN.get(r.n).p && !r.hallazgo).map((r) => r.n);
      if (sinHallazgo.length) errores.push(`Falta el hallazgo (obligatorio) en los puntos: ${sinHallazgo.join(', ')}.`);
    }
    return { errores, limpias, obtenidos };
  }

  const fechaISO = (s, tope) => {
    if (typeof s !== 'string') return null;
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    return new Date(Math.min(t, tope.getTime())).toISOString();
  };

  app.put('/api/auditorias/:id', auth(), necesitaCfg, wrap(async (req, res) => {
    const id = req.params.id;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const pid = L.parseAuditId(id);
    if (!pid) fail(400, 'ID de auditoría inválido. Formato esperado: S03-A12.');
    if (pid.semana < 1 || pid.semana > cfg.semanas || pid.idx >= cfg.areas.length) {
      fail(404, 'Ese ID no existe en la rotación de esta configuración.');
    }
    const auditora = cfg.areas[pid.idx];
    const auditada = cfg.areas[cfg.rotacion[pid.semana - 1][pid.idx]];
    if (!auditada) fail(404, 'Ese ID no existe en la rotación de esta configuración.');
    if (auditora.id === auditada.id) fail(422, 'Un área no puede auditarse a sí misma.');
    const c = cfg.checklists.get(auditada.checklist);
    const seccion = L.seccionDe(auditada, pid.semana);
    if (b.subarea !== undefined && b.subarea !== null && (!seccion || b.subarea !== seccion.nombre)) {
      fail(422, seccion ? `En ${id} la sección a auditar es ${seccion.nombre}, no ${b.subarea}.` : `${auditada.nombre} no tiene secciones activas.`);
    }

    const maquinas = seccion ? L.listaMaquinas(seccion.maquinas) : [];
    const maquina = typeof b.maquina === 'string' ? b.maquina.trim() : '';

    if (b.auditora !== undefined && b.auditora !== auditora.id) fail(422, `En ${id} la auditora es ${auditora.id}, no ${b.auditora}.`);
    if (b.auditada !== undefined && b.auditada !== auditada.id) {
      fail(422, b.auditada === auditora.id ? 'Un área no puede auditarse a sí misma.' : `En ${id} la auditada es ${auditada.id}, no ${b.auditada}.`);
    }
    if (b.checklist !== undefined && b.checklist !== c.codigo) fail(422, `El checklist de ${auditada.nombre} es ${c.codigo}, no ${b.checklist}.`);

    if (req.user.rol === 'area' && req.user.area !== auditora.id) fail(403, `Solo ${auditora.nombre} puede registrar esta auditoría.`);

    const now = ahora();
    const hoy = L.localYMD(now);
    if (hoy < L.inicioSemana(cfg.inicio, pid.semana)) fail(422, `La semana ${pid.semana} aún no inicia (${L.inicioSemana(cfg.inicio, pid.semana)}).`);

    // una auditoría atrasada se hace antes que las siguientes: no se puede trabajar una semana mientras haya otra anterior atrasada
    if (req.user.rol === 'area') {
      const yaFinal = await db.uno("SELECT id FROM auditorias WHERE id = ? AND ciclo = ? AND estado = 'final'", [id, cicloActual()]);
      if (!yaFinal) {
        const finales = new Set((await db.q("SELECT semana FROM auditorias WHERE ciclo = ? AND auditora = ? AND estado = 'final'", [cicloActual(), auditora.id])).map((r) => r.semana));
        for (let w = 1; w < pid.semana; w++) {
          const fila = cfg.rotacion[w - 1];
          if (!fila || fila[pid.idx] === undefined || fila[pid.idx] === null || finales.has(w)) continue;
          if (L.estatus(false, cfg.inicio, cfg.dias, w, hoy) === 'Atrasada') {
            fail(422, `Tienes atrasada la auditoría de la semana ${w} (${L.auditId(w, pid.idx)}). Haz primero la atrasada y después ${id}.`);
          }
        }
      }
    }

    const estado = b.estado === undefined ? 'borrador' : b.estado;
    if (estado !== 'borrador' && estado !== 'final') fail(422, '"estado" debe ser "borrador" o "final".');
    const final = estado === 'final';
    const errores = [];
    const txt = (v, max, campo) => {
      if (v === undefined || v === null) return '';
      if (typeof v !== 'string' || v.length > max) { errores.push(`"${campo}" debe ser texto de máximo ${max} caracteres.`); return ''; }
      return v.trim();
    };
    const persona = txt(b.persona_audita, 120, 'persona_audita');
    const responsable = txt(b.responsable, 120, 'responsable');
    const dispositivo = txt(b.dispositivo, 64, 'dispositivo');
    // la fecha de la auditoría no se captura: es siempre el día en que se guarda (el día en que se finalizó, si ya terminó)
    let duracion = null;
    if (typeof b.duracion_seg === 'number' && Number.isFinite(b.duracion_seg)) duracion = Math.min(Math.max(Math.round(b.duracion_seg), 0), 172800);
    if (final && !persona) errores.push('Falta el nombre de la persona que audita.');
    if (maquina && !maquinas.includes(maquina)) errores.push(`La máquina "${maquina}" no está en la lista de la sección ${seccion ? seccion.nombre : ''}.`);
    if (final && maquinas.length && !maquina) errores.push('Falta elegir la máquina que se auditó.');
    // número de nómina del auditado: obligatorio para finalizar (solo dígitos)
    const nomina = txt(b.nomina_auditado, 20, 'nomina_auditado');
    if (final && !nomina) errores.push('Falta el número de nómina del auditado.');
    else if (nomina && !/^\d{1,12}$/.test(nomina)) errores.push('El número de nómina solo puede llevar dígitos (máximo 12).');
    const ev = evaluarRespuestas(c, b.respuestas === undefined ? [] : b.respuestas, final);
    errores.push(...ev.errores);
    if (errores.length) return res.status(422).json({ error: errores[0], errores });

    const cal = final ? L.calificacion(ev.obtenidos, c.total) : null;
    const niv = final ? L.nivel(cal, c.umbrales) : null;
    const terminado = final ? (fechaISO(b.terminado, now) || now.toISOString()) : null;
    const fecha = final ? L.localYMD(new Date(terminado)) : hoy;
    const creadoNuevo = fechaISO(b.creado, now) || now.toISOString();

    // Transacción con bloqueo de la fila: la regla "una final no se modifica" es atómica aunque dos equipos
    // finalicen a la vez. Si dos inserciones chocan (clave duplicada) o hay interbloqueo, se reintenta.
    let resultado;
    for (let intento = 1; ; intento++) {
      try {
        resultado = await db.tx(async (t) => {
          const ex = await t.uno('SELECT * FROM auditorias WHERE id = ? AND ciclo = ? FOR UPDATE', [id, cicloActual()]);
          if (ex && ex.estado === 'final') return { conflicto: ex };
          if (ex) {
            await t.q(`UPDATE auditorias SET maquina=?, persona_audita=?, responsable=?, nomina_auditado=?, fecha=?, estado=?, terminado=?, dispositivo=?,
              duracion_seg=COALESCE(?, duracion_seg), calificacion=?, nivel=?, usuario=? WHERE id = ?`,
            [maquina || null, persona, responsable, nomina || null, fecha, estado, terminado, dispositivo, duracion, cal, niv, quien(req), id]);
          } else {
            await t.q(`INSERT INTO auditorias (id, ciclo, semana, auditora, auditada, subarea, maquina, checklist, persona_audita, responsable, nomina_auditado, fecha,
              estado, creado, terminado, dispositivo, duracion_seg, calificacion, nivel, usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [id, cicloActual(), pid.semana, auditora.id, auditada.id, seccion ? seccion.nombre : null, maquina || null, c.codigo, persona, responsable, nomina || null, fecha, estado, creadoNuevo, terminado, dispositivo, duracion, cal, niv, quien(req)]);
          }
          await t.q('DELETE FROM respuestas WHERE auditoria_id = ?', [id]);
          if (ev.limpias.length) await t.q('INSERT INTO respuestas (auditoria_id, n, puntos, hallazgo, accion) VALUES ?', [ev.limpias.map((r) => [id, r.n, r.puntos, r.hallazgo, r.accion])]);
          await D.bitacora(t, quien(req), final ? 'auditoria_finalizada' : 'auditoria_borrador', `${id} ${auditora.id}→${auditada.id}${final ? ` ${cal} ${niv}` : ''}`);
          return { ok: true };
        });
        break;
      } catch (e) {
        if (REINTENTABLE.has(e.code) && intento < 4) continue;
        throw e;
      }
    }
    if (resultado.conflicto) {
      return res.status(409).json({
        error: 'Esta auditoría ya fue finalizada y no se puede modificar.',
        auditoria: await filaApi(resultado.conflicto, true),
        mismo_dispositivo: !!b.dispositivo && b.dispositivo === resultado.conflicto.dispositivo,
      });
    }
    res.json(await filaApi(await obtener(id), true, req.user.rol === 'admin'));
  }));

  // ---------- semana / tablero ----------
  async function mapaAuditorias() {
    const m = new Map();
    for (const r of await db.q('SELECT id, semana, estado, subarea, maquina, calificacion, nivel, terminado, persona_audita, duracion_seg FROM auditorias WHERE ciclo = ?', [cicloActual()])) m.set(r.id, r);
    return m;
  }

  // Umbrales para expresar en nivel (1S a 5S) un promedio de toda la planta: los más usados por las áreas activas.
  function umbralesPlanta() {
    const cuenta = new Map();
    for (const a of cfg.areas) {
      if (!a.activa) continue;
      const c = cfg.checklists.get(a.checklist);
      if (c) cuenta.set(JSON.stringify(c.umbrales), (cuenta.get(JSON.stringify(c.umbrales)) || 0) + 1);
    }
    let mejor = '[51,72,88,95]'; let n = 0;
    for (const [k, v] of cuenta) if (v > n) { mejor = k; n = v; }
    return JSON.parse(mejor);
  }
  const nivelDe = (valor, u) => (valor === null || valor === undefined ? null : L.nivel(valor, u));

  // ----- filtro de periodo (semanal, mensual, anual o todo el ciclo) para todos los dashboards -----
  // Calendario ISO: una semana pertenece al mes y al año en que cae su jueves, así que un mes puede tener 4 o 5 semanas.
  const jueves = (ini) => L.addDays(ini, 3);
  function periodoOpciones() {
    const semanas = []; const meses = []; const anios = [];
    for (let s = 1; s <= cfg.semanas; s++) {
      const ini = L.inicioSemana(cfg.inicio, s);
      semanas.push({ valor: String(s), semana: s, iso: L.semanaISO(ini), inicio: ini, fin: L.addDays(ini, 6) });
      const j = jueves(ini);
      if (!meses.includes(j.slice(0, 7))) meses.push(j.slice(0, 7));
      if (!anios.includes(j.slice(0, 4))) anios.push(j.slice(0, 4));
    }
    return { semanas, meses, anios };
  }
  // Devuelve { periodo, valor, semanas[] } (números de semana del ciclo). `defecto` aplica si no se pidió periodo;
  // `vigente` es la semana en curso (0 si el ciclo no ha iniciado) y fija el valor por omisión.
  function resolverPeriodo(q, defecto, vigente) {
    const op = periodoOpciones();
    const periodo = ['semana', 'mes', 'anio', 'ciclo'].includes(q.periodo) ? q.periodo : defecto;
    const valorPedido = typeof q.valor === 'string' ? q.valor : '';
    const ref = jueves(vigente ? L.inicioSemana(cfg.inicio, vigente) : (op.semanas[0] ? op.semanas[0].inicio : cfg.inicio));
    const iniDe = (s) => jueves(L.inicioSemana(cfg.inicio, s));
    const todas = op.semanas.map((x) => x.semana);
    if (periodo === 'semana') {
      let n = parseInt(valorPedido, 10);
      if (!(n >= 1 && n <= cfg.semanas)) n = Math.min(Math.max(vigente || 1, 1), Math.max(cfg.semanas, 1));
      return { periodo, valor: String(n), semanas: cfg.semanas ? [n] : [] };
    }
    if (periodo === 'mes') {
      const valor = op.meses.includes(valorPedido) ? valorPedido : ref.slice(0, 7);
      return { periodo, valor, semanas: todas.filter((s) => iniDe(s).slice(0, 7) === valor) };
    }
    if (periodo === 'anio') {
      const valor = op.anios.includes(valorPedido) ? valorPedido : ref.slice(0, 4);
      return { periodo, valor, semanas: todas.filter((s) => iniDe(s).slice(0, 4) === valor) };
    }
    return { periodo: 'ciclo', valor: '', semanas: todas };
  }

  function filaSemana(semana, idx, mapa, hoy) {
    const aud = cfg.areas[idx];
    const tgt = cfg.areas[cfg.rotacion[semana - 1][idx]];
    if (!tgt) return null; // esa semana el área no tiene asignación (área nueva o desactivada)
    const id = L.auditId(semana, idx);
    const r = mapa.get(id);
    const final = !!r && r.estado === 'final';
    const limite = L.fechaLimite(cfg.inicio, semana, cfg.dias);
    return {
      id, semana, auditora: aud.id, auditora_nombre: aud.nombre, auditada: tgt.id, auditada_nombre: tgt.nombre,
      subarea: r && r.subarea ? r.subarea : (L.seccionDe(tgt, semana) || {}).nombre || null,
      maquina: r && r.maquina ? r.maquina : null,
      checklist: tgt.checklist, fecha_limite: limite,
      estatus: L.estatus(final, cfg.inicio, cfg.dias, semana, hoy),
      borrador: !!(r && r.estado === 'borrador'),
      calificacion: final ? r.calificacion : null, nivel: final ? r.nivel : null,
      terminado: final ? r.terminado : null,
      entrega: final && r.terminado ? L.entrega(L.localYMD(new Date(r.terminado)), limite) : null,
      persona_audita: r ? r.persona_audita : null,
    };
  }

  app.get('/api/semana/:n', auth(), necesitaCfg, wrap(async (req, res) => {
    const n = parseInt(req.params.n, 10);
    if (!(n >= 1 && n <= cfg.semanas)) fail(404, `La semana debe estar entre 1 y ${cfg.semanas}.`);
    const hoy = L.localYMD(ahora());
    const mapa = await mapaAuditorias();
    res.json({
      semana: n, inicio: L.inicioSemana(cfg.inicio, n), fecha_limite: L.fechaLimite(cfg.inicio, n, cfg.dias), hoy,
      actual: L.semanaActual(cfg.inicio, hoy, cfg.semanas),
      asignaciones: cfg.areas.map((a) => filaSemana(n, a.idx, mapa, hoy)).filter(Boolean)
        .filter((f) => req.user.rol !== 'area' || f.auditora === req.user.area || f.auditada === req.user.area),
    });
  }));

  app.get('/api/tablero', auth(), necesitaCfg, wrap(async (req, res) => {
    const hoy = L.localYMD(ahora());
    const mapa = await mapaAuditorias();
    const act = L.semanaActual(cfg.inicio, hoy, cfg.semanas);
    const ultima = act.estado === 'previo' ? 0 : Math.min(act.semana, cfg.semanas);
    const per = resolverPeriodo(req.query, 'ciclo', ultima);
    const aud = cfg.areas.map((a) => ({
      area: a.id, nombre: a.nombre, activa: a.activa, asignadas: 0, completadas: 0, a_tiempo: 0, fuera_de_tiempo: 0, atrasadas: 0, pendientes: 0,
    }));
    const rec = cfg.areas.map((a) => ({ area: a.id, nombre: a.nombre, activa: a.activa, checklist: a.checklist, recibidas: 0, suma: 0, ultima_semana: 0, ultima_calificacion: null, ultimo_nivel: null }));
    let suma = 0;
    for (const s of per.semanas) {
      if (s > ultima) continue; // las semanas que aún no inician no cuentan
      for (const a of cfg.areas) {
        const f = filaSemana(s, a.idx, mapa, hoy);
        if (!f) continue;
        const t = aud[a.idx];
        t.asignadas += 1;
        if (f.estatus === 'Completada') {
          t.completadas += 1;
          if (f.entrega === 'A tiempo') t.a_tiempo += 1; else t.fuera_de_tiempo += 1;
          const r = rec[cfg.areaIdx.get(f.auditada)];
          r.recibidas += 1; r.suma += f.calificacion; suma += f.calificacion;
          if (s >= r.ultima_semana) { r.ultima_semana = s; r.ultima_calificacion = f.calificacion; r.ultimo_nivel = f.nivel; }
        } else if (f.estatus === 'Atrasada') t.atrasadas += 1;
        else t.pendientes += 1;
      }
    }
    for (const t of aud) {
      const exigibles = t.completadas + t.atrasadas;
      t.pct_a_tiempo = exigibles ? Math.round((t.a_tiempo / exigibles) * 1000) / 10 : null;
      t.semaforo = L.semaforo({ iniciadas: t.asignadas, completadas: t.completadas, atrasadas: t.atrasadas, fuera_de_tiempo: t.fuera_de_tiempo });
    }
    for (const r of rec) {
      r.promedio = r.recibidas ? L.redondear1(r.suma / r.recibidas) : null; delete r.suma; delete r.ultima_semana;
      r.nivel_promedio = nivelDe(r.promedio, cfg.checklists.get(r.checklist).umbrales); // con los umbrales del checklist de esa área
    }
    // un área solo ve sus propias métricas: como auditora (lo que le toca hacer) y como auditada (lo que recibió)
    const soloMia = req.user.rol === 'area' ? req.user.area : null;
    const audVis = soloMia ? aud.filter((t) => t.area === soloMia) : aud;
    const recVis = soloMia ? rec.filter((r) => r.area === soloMia) : rec;
    const tot = audVis.reduce((x, t) => ({
      ya_tocaban: x.ya_tocaban + t.asignadas, completadas: x.completadas + t.completadas, atrasadas: x.atrasadas + t.atrasadas,
      a_tiempo: x.a_tiempo + t.a_tiempo, fuera_de_tiempo: x.fuera_de_tiempo + t.fuera_de_tiempo,
    }), { ya_tocaban: 0, completadas: 0, atrasadas: 0, a_tiempo: 0, fuera_de_tiempo: 0 });
    const exig = tot.completadas + tot.atrasadas;
    // promedio de la planta (administrador) o de lo que recibió el área (área)
    const miRec = soloMia ? recVis[0] : null;
    const resumen = {
      ...tot,
      pct_a_tiempo: exig ? Math.round((tot.a_tiempo / exig) * 1000) / 10 : null,
      calificacion_promedio: tot.completadas ? L.redondear1(suma / tot.completadas) : null,
      nivel_promedio: tot.completadas ? nivelDe(L.redondear1(suma / tot.completadas), umbralesPlanta()) : null,
    };
    if (miRec) { resumen.calificacion_promedio = miRec.promedio; resumen.nivel_promedio = miRec.nivel_promedio; }
    res.json({
      hoy, semana: act, nombre: cfg.nombre, periodo: per.periodo, valor: per.valor, opciones: periodoOpciones(),
      resumen, auditoras: audVis, auditadas: recVis,
    });
  }));

  // ---------- dashboard de lobby (solo lectura, sin calificaciones ni nombres de personas) ----------
  // Luz por área: Verde = al corriente (auditoría de esta semana hecha y nada atrasado); Amarillo = la de esta semana
  // sigue pendiente pero aún en plazo; Rojo = tiene alguna auditoría atrasada.
  app.get('/api/lobby', auth('lobby'), wrap(async (req, res) => {
    const hoy = L.localYMD(ahora());
    const mapa = await mapaAuditorias();
    const act = L.semanaActual(cfg.inicio, hoy, cfg.semanas);
    const semana = act.estado === 'previo' ? 0 : Math.min(act.semana, cfg.semanas);
    // columnas = semanas del periodo elegido (una semana, un mes o un año)
    const per = resolverPeriodo(req.query, 'mes', semana);
    const columnas = per.semanas.map((s) => {
      const ini = L.inicioSemana(cfg.inicio, s);
      return { semana: s, iso: L.semanaISO(ini), inicio: ini, fin: L.addDays(ini, 6), actual: s === semana };
    });
    const areas = [];
    const resumen = { total: 0, hechas: 0, pendientes: 0, atrasadas: 0 };
    const quienAudita = new Map(); // semana -> (área auditada -> área auditora)
    const auditoraDe = (s, idx) => {
      if (!quienAudita.has(s)) {
        const m = new Map();
        (cfg.rotacion[s - 1] || []).forEach((b, i) => { if (b !== undefined && b !== null) m.set(b, i); });
        quienAudita.set(s, m);
      }
      return quienAudita.get(s).get(idx);
    };
    for (const a of cfg.areas) {
      if (!a.activa) continue;
      let atrasadas = 0;
      let esta = null;
      for (let s = 1; s <= semana; s++) {
        const f = filaSemana(s, a.idx, mapa, hoy);
        if (!f) continue;
        if (f.estatus === 'Atrasada') atrasadas += 1;
        if (s === semana) esta = f;
      }
      const luz = atrasadas > 0 ? 'Rojo' : !esta ? 'Sin asignar' : esta.estatus === 'Completada' ? 'Verde' : 'Amarillo';
      if (esta) {
        resumen.total += 1;
        if (esta.estatus === 'Completada') resumen.hechas += 1;
        else if (esta.estatus === 'Pendiente') resumen.pendientes += 1;
      }
      if (atrasadas > 0) resumen.atrasadas += 1;
      // además del semáforo de la auditoría que hace el área, la calificación que recibió esa semana como área auditada
      let sumaR = 0; let nR = 0;
      const celdas = columnas.map((c) => {
        const f = filaSemana(c.semana, a.idx, mapa, hoy);
        const ai = auditoraDe(c.semana, a.idx);
        const reg = ai === undefined ? null : mapa.get(L.auditId(c.semana, ai));
        const recibida = reg && reg.estado === 'final' ? { calificacion: reg.calificacion, nivel: reg.nivel } : null;
        if (recibida) { sumaR += recibida.calificacion; nR += 1; }
        return { e: f ? f.estatus : null, tarde: !!f && f.entrega === 'Fuera de tiempo', a: f ? f.auditada_nombre : null, recibida };
      });
      const promedioR = nR ? L.redondear1(sumaR / nR) : null;
      areas.push({
        id: a.id, nombre: a.nombre, luz, esta_semana: esta ? esta.estatus : null, atrasadas, celdas,
        recibido: { n: nR, promedio: promedioR, nivel: nivelDe(promedioR, cfg.checklists.get(a.checklist).umbrales) },
      });
    }
    res.json({
      nombre: cfg.nombre, hoy, ahora: ahora().toISOString(), estado: act.estado, semana, semanas: cfg.semanas,
      inicio: semana ? L.inicioSemana(cfg.inicio, semana) : cfg.inicio, fecha_limite: semana ? L.fechaLimite(cfg.inicio, semana, cfg.dias) : null,
      resumen, periodo: per.periodo, valor: per.valor, opciones: periodoOpciones(), columnas, areas,
    });
  }));

  // ---------- dashboard ejecutivo (métricas agregadas; lobby y administrador) ----------
  const pct1 = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
  app.get('/api/ejecutivo', auth('lobby'), wrap(async (req, res) => {
    const hoy = L.localYMD(ahora());
    const mapa = await mapaAuditorias();
    const act = L.semanaActual(cfg.inicio, hoy, cfg.semanas);
    const ultima = act.estado === 'previo' ? 0 : Math.min(act.semana, cfg.semanas);
    const per = resolverPeriodo(req.query, 'ciclo', ultima);
    const semanasPer = per.semanas.filter((s) => s <= ultima);
    const ultimaPer = semanasPer.length ? semanasPer[semanasPer.length - 1] : 0;

    // ---- por semana y por área ----
    const tendencia = [];
    const tot = { ya_tocaban: 0, completadas: 0, a_tiempo: 0, fuera_de_tiempo: 0, atrasadas: 0, pendientes: 0 };
    const porArea = new Map(cfg.areas.map((a) => [a.idx, { atrasadas: 0, esta: null }]));
    const recibidas = new Map(); // auditada -> { suma, n }
    let sumaCal = 0;
    for (const s of semanasPer) {
      const ini = L.inicioSemana(cfg.inicio, s);
      const w = { semana: s, iso: L.semanaISO(ini), inicio: ini, fin: L.addDays(ini, 6), asignadas: 0, completadas: 0, a_tiempo: 0, atrasadas: 0, pendientes: 0, suma: 0 };
      for (const a of cfg.areas) {
        const f = filaSemana(s, a.idx, mapa, hoy);
        if (!f) continue;
        w.asignadas += 1;
        const pa = porArea.get(a.idx);
        if (s === ultimaPer) pa.esta = f;
        if (f.estatus === 'Completada') {
          w.completadas += 1; w.suma += f.calificacion; sumaCal += f.calificacion;
          if (f.entrega === 'A tiempo') w.a_tiempo += 1;
          const r = recibidas.get(f.auditada) || { suma: 0, n: 0 };
          r.suma += f.calificacion; r.n += 1; recibidas.set(f.auditada, r);
        } else if (f.estatus === 'Atrasada') { w.atrasadas += 1; pa.atrasadas += 1; } else w.pendientes += 1;
      }
      tot.ya_tocaban += w.asignadas; tot.completadas += w.completadas; tot.a_tiempo += w.a_tiempo;
      tot.atrasadas += w.atrasadas; tot.pendientes += w.pendientes;
      tendencia.push({
        semana: s, iso: w.iso, inicio: w.inicio, fin: w.fin, asignadas: w.asignadas, completadas: w.completadas, a_tiempo: w.a_tiempo,
        atrasadas: w.atrasadas, pendientes: w.pendientes,
        cumplimiento: pct1(w.completadas, w.completadas + w.atrasadas), calificacion: w.completadas ? L.redondear1(w.suma / w.completadas) : null,
      });
    }
    tot.fuera_de_tiempo = tot.completadas - tot.a_tiempo;

    // ---- semáforo actual por área activa (misma regla que el lobby) ----
    const luces = { Verde: 0, Amarillo: 0, Rojo: 0, 'Sin asignar': 0 };
    for (const a of cfg.areas) {
      if (!a.activa) continue;
      const pa = porArea.get(a.idx);
      const luz = pa.atrasadas > 0 ? 'Rojo' : !pa.esta ? 'Sin asignar' : pa.esta.estatus === 'Completada' ? 'Verde' : 'Amarillo';
      luces[luz] += 1;
    }

    // ---- niveles, calificaciones y rankings ----
    const niveles = { '1S': 0, '2S': 0, '3S': 0, '4S': 0, '5S': 0 };
    for (const r of mapa.values()) if (r.estado === 'final' && niveles[r.nivel] !== undefined && semanasPer.includes(r.semana)) niveles[r.nivel] += 1;
    const lista = cfg.areas.filter((a) => recibidas.has(a.id)).map((a) => ({ id: a.id, nombre: a.nombre, promedio: L.redondear1(recibidas.get(a.id).suma / recibidas.get(a.id).n), recibidas: recibidas.get(a.id).n }));
    for (const x of lista) x.nivel = nivelDe(x.promedio, cfg.checklists.get(cfg.areas[cfg.areaIdx.get(x.id)].checklist).umbrales);
    const mejores = [...lista].sort((x, y) => y.promedio - x.promedio || x.id.localeCompare(y.id)).slice(0, 5);
    const peores = [...lista].sort((x, y) => x.promedio - y.promedio || x.id.localeCompare(y.id)).slice(0, 5);
    const masAtrasos = cfg.areas.filter((a) => a.activa && porArea.get(a.idx).atrasadas > 0)
      .map((a) => ({ id: a.id, nombre: a.nombre, atrasadas: porArea.get(a.idx).atrasadas }))
      .sort((x, y) => y.atrasadas - x.atrasadas || x.id.localeCompare(y.id)).slice(0, 5);

    // ---- por S y puntos más débiles (a partir de las respuestas de auditorías finalizadas) ----
    // Resultados de la planta por S: promedio de los puntos obtenidos en cada S sobre todas las auditorías finalizadas
    // (y promedio de lo que valía esa S en cada auditoría). Las 5 S suman el promedio de calificación de la planta.
    const porAud = new Map(); // auditoría -> { S -> { obt, max } }
    const porPunto = new Map();
    const filasR = await db.q("SELECT a.id, a.checklist, r.n, r.puntos FROM respuestas r JOIN auditorias a ON a.id = r.auditoria_id WHERE a.ciclo = ? AND a.estado = 'final' AND a.semana IN (?) AND r.puntos IS NOT NULL", [cicloActual(), semanasPer.length ? semanasPer : [0]]);
    for (const x of filasR) {
      const c = cfg.checklists.get(x.checklist);
      const p = c && c.puntos[x.n - 1];
      if (!p) continue;
      const m = porAud.get(x.id) || new Map();
      const g = m.get(p.s) || { obt: 0, max: 0 };
      g.obt += x.puntos; g.max += p.p; m.set(p.s, g); porAud.set(x.id, m);
      const k = `${x.checklist}#${x.n}`;
      const q = porPunto.get(k) || { checklist: x.checklist, n: x.n, s: p.s, texto: p.q, obtenidos: 0, posibles: 0, respuestas: 0, hallazgos: 0 };
      q.obtenidos += x.puntos; q.posibles += p.p; q.respuestas += 1; if (x.puntos < p.p) q.hallazgos += 1;
      porPunto.set(k, q);
    }
    const ordenS = ['Seleccionar', 'Ordenar', 'Limpiar', 'Estandarizar', 'Sostener'];
    const uPlanta = umbralesPlanta();
    for (const w of tendencia) w.nivel = nivelDe(w.calificacion, uPlanta);
    const nAud = porAud.size;
    const por_s = ordenS.map((s) => {
      let obt = 0; let max = 0;
      for (const m of porAud.values()) { const g = m.get(s); if (g) { obt += g.obt; max += g.max; } }
      const pct = pct1(obt, max);
      return { s, auditorias: nAud, promedio_obtenido: nAud ? L.redondear1(obt / nAud) : null, promedio_maximo: nAud ? L.redondear1(max / nAud) : null, pct, nivel: nivelDe(pct, uPlanta) };
    }).filter((x) => x.promedio_maximo);
    const puntos_debiles = [...porPunto.values()].map((q) => ({ checklist: q.checklist, n: q.n, s: q.s, texto: q.texto, pct: pct1(q.obtenidos, q.posibles), respuestas: q.respuestas, hallazgos: q.hallazgos }))
      .filter((q) => q.hallazgos > 0).sort((x, y) => x.pct - y.pct || y.hallazgos - x.hallazgos).slice(0, 5);

    res.json({
      nombre: cfg.nombre, hoy, ahora: ahora().toISOString(), estado: act.estado, semana: ultima, semanas: cfg.semanas,
      periodo: per.periodo, valor: per.valor, opciones: periodoOpciones(), umbrales: uPlanta,
      kpis: {
        ...tot,
        cumplimiento: pct1(tot.completadas, tot.completadas + tot.atrasadas),
        puntualidad: pct1(tot.a_tiempo, tot.completadas),
        calificacion_promedio: tot.completadas ? L.redondear1(sumaCal / tot.completadas) : null,
        nivel_promedio: tot.completadas ? nivelDe(L.redondear1(sumaCal / tot.completadas), uPlanta) : null,
        areas_activas: cfg.areas.filter((a) => a.activa).length,
      },
      luces, tendencia, niveles, por_s, mejores, peores, mas_atrasos: masAtrasos, puntos_debiles,
    });
  }));

  // ---------- cumplimiento y calificación por mes de cada área (lobby y administrador) ----------
  // Cumplimiento = auditorías que le tocaba hacer: realizadas ÷ (realizadas + atrasadas). Calificación = promedio de lo que recibió como área auditada.
  app.get('/api/mensual', auth('lobby'), wrap(async (req, res) => {
    const hoy = L.localYMD(ahora());
    const mapa = await mapaAuditorias();
    const act = L.semanaActual(cfg.inicio, hoy, cfg.semanas);
    const ultima = act.estado === 'previo' ? 0 : Math.min(act.semana, cfg.semanas);
    const op = periodoOpciones();
    const mesDe = (s) => jueves(L.inicioSemana(cfg.inicio, s)).slice(0, 7);
    const meses = op.meses.filter((m) => { for (let s = 1; s <= ultima; s++) if (mesDe(s) === m) return true; return false; });
    const celda = () => ({ realizadas: 0, atrasadas: 0, recibidas: 0, suma: 0 });
    const por = new Map(cfg.areas.map((a) => [a.idx, new Map(meses.map((m) => [m, celda()]))]));
    const planta = new Map(meses.map((m) => [m, celda()]));
    for (let s = 1; s <= ultima; s++) {
      const m = mesDe(s);
      for (const a of cfg.areas) {
        const f = filaSemana(s, a.idx, mapa, hoy);
        if (!f) continue;
        const c = por.get(a.idx).get(m); const pl = planta.get(m);
        if (f.estatus === 'Completada') {
          c.realizadas += 1; pl.realizadas += 1;
          const r = por.get(cfg.areaIdx.get(f.auditada)).get(m);
          r.recibidas += 1; r.suma += f.calificacion; pl.recibidas += 1; pl.suma += f.calificacion;
        } else if (f.estatus === 'Atrasada') { c.atrasadas += 1; pl.atrasadas += 1; }
      }
    }
    const salida = (c, u) => {
      const cal = c.recibidas ? L.redondear1(c.suma / c.recibidas) : null;
      return { cumplimiento: pct1(c.realizadas, c.realizadas + c.atrasadas), realizadas: c.realizadas, atrasadas: c.atrasadas, recibidas: c.recibidas, calificacion: cal, nivel: nivelDe(cal, u) };
    };
    res.json({
      nombre: cfg.nombre, hoy, estado: act.estado, meses, umbrales: umbralesPlanta(),
      areas: cfg.areas.map((a) => {
        const u = cfg.checklists.get(a.checklist).umbrales;
        return { id: a.id, nombre: a.nombre, activa: a.activa, meses: meses.map((m) => salida(por.get(a.idx).get(m), u)) };
      }),
      planta: meses.map((m) => salida(planta.get(m), umbralesPlanta())),
    });
  }));

  // ---------- tiempos de captura: dato exclusivo del administrador ----------
  app.get('/api/admin/tiempos', auth('admin'), wrap(async (req, res) => {
    const hoy = L.localYMD(ahora());
    const act = L.semanaActual(cfg.inicio, hoy, cfg.semanas);
    const ultima = act.estado === 'previo' ? 0 : Math.min(act.semana, cfg.semanas);
    const per = resolverPeriodo(req.query, 'ciclo', ultima);
    const filas = await db.q("SELECT id, semana, auditora, auditada, persona_audita, terminado, duracion_seg FROM auditorias WHERE ciclo = ? AND estado = 'final' AND semana IN (?) ORDER BY terminado DESC", [cicloActual(), per.semanas.length ? per.semanas : [0]]);
    const nombre = (id) => { const i = cfg.areaIdx.get(id); return i === undefined ? id : cfg.areas[i].nombre; };
    const conTiempo = filas.filter((f) => f.duracion_seg !== null && f.duracion_seg !== undefined);
    const orden = conTiempo.map((f) => f.duracion_seg).sort((x, y) => x - y);
    const mediana = orden.length ? (orden.length % 2 ? orden[(orden.length - 1) / 2] : Math.round((orden[orden.length / 2 - 1] + orden[orden.length / 2]) / 2)) : null;
    const porAud = new Map();
    for (const f of conTiempo) { const g = porAud.get(f.auditora) || { suma: 0, n: 0 }; g.suma += f.duracion_seg; g.n += 1; porAud.set(f.auditora, g); }
    res.json({
      periodo: per.periodo, valor: per.valor, opciones: periodoOpciones(),
      resumen: {
        auditorias: filas.length, con_tiempo: conTiempo.length,
        promedio_seg: conTiempo.length ? Math.round(conTiempo.reduce((x, f) => x + f.duracion_seg, 0) / conTiempo.length) : null,
        mediana_seg: mediana, minimo_seg: orden.length ? orden[0] : null, maximo_seg: orden.length ? orden[orden.length - 1] : null,
      },
      por_area: [...porAud.entries()].map(([id, g]) => ({ id, nombre: nombre(id), auditorias: g.n, promedio_seg: Math.round(g.suma / g.n) })).sort((x, y) => y.promedio_seg - x.promedio_seg),
      auditorias: filas.map((f) => ({ id: f.id, semana: f.semana, auditora: f.auditora, auditora_nombre: nombre(f.auditora), auditada_nombre: nombre(f.auditada), persona_audita: f.persona_audita, terminado: f.terminado, duracion_seg: f.duracion_seg })),
    });
  }));

  // ---------- exportación y respaldo ----------
  app.get('/api/export.csv', auth('admin'), necesitaCfg, wrap(async (req, res) => {
    const desde = req.query.desde;
    if (desde !== undefined && Number.isNaN(L.parseYMD(desde))) fail(400, '"desde" debe tener formato yyyy-mm-dd.');
    const maxP = Math.max(22, ...[...cfg.checklists.values()].map((c) => c.puntos.length));
    const cab = ['ID auditoría', 'Fecha y hora de envío', 'Correo de quien responde', 'Persona que audita', 'Área auditora', 'Área auditada', 'Sección auditada', 'Máquina auditada',
      'Código checklist', 'Responsable 5S del área auditada', 'Hallazgos', 'Acciones correctivas'];
    for (let i = 1; i <= maxP; i++) cab.push(`P${L.pad2(i)}`);
    // el tiempo de captura es un dato del administrador: solo aparece cuando exporta él
    const verTiempo = req.user.rol === 'admin';
    cab.push('ID respuesta Forms');
    if (verTiempo) cab.push('Tiempo de captura (seg)');
    cab.push('Calificación');
    const lineas = [cab.map(csvCelda).join(',')];
    const nombre = (id) => { const i = cfg.areaIdx.get(id); return i === undefined ? id : cfg.areas[i].nombre; };
    const filas = await db.q("SELECT * FROM auditorias WHERE ciclo = ? AND estado = 'final' ORDER BY semana, id", [cicloActual()]);
    const porAud = new Map();
    for (const x of await db.q("SELECT r.auditoria_id, r.n, r.puntos, r.hallazgo, r.accion FROM respuestas r JOIN auditorias a ON a.id = r.auditoria_id WHERE a.ciclo = ? AND a.estado = 'final' ORDER BY r.auditoria_id, r.n", [cicloActual()])) {
      if (!porAud.has(x.auditoria_id)) porAud.set(x.auditoria_id, []);
      porAud.get(x.auditoria_id).push(x);
    }
    for (const r of filas) {
      const t = new Date(r.terminado);
      if (desde && L.localYMD(t) < desde) continue;
      const resp = porAud.get(r.id) || [];
      const pts = new Map(resp.map((x) => [x.n, x.puntos]));
      const hall = resp.filter((x) => x.hallazgo).map((x) => `P${L.pad2(x.n)}: ${x.hallazgo}`).join(' | ');
      const acc = resp.filter((x) => x.accion).map((x) => `P${L.pad2(x.n)}: ${x.accion}`).join(' | ');
      const fila = [r.id, L.localYMDHM(t), '', r.persona_audita, nombre(r.auditora), nombre(r.auditada), r.subarea || '', r.maquina || '', r.checklist, r.responsable, hall, acc];
      for (let i = 1; i <= maxP; i++) fila.push(pts.has(i) ? pts.get(i) : '');
      fila.push(r.dispositivo || '');
      if (verTiempo) fila.push(r.duracion_seg === null || r.duracion_seg === undefined ? '' : r.duracion_seg);
      fila.push(r.calificacion === null || r.calificacion === undefined ? '' : r.calificacion);
      lineas.push(fila.map(csvCelda).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="auditorias_5s_${L.localYMD(ahora())}.csv"`);
    res.send(`﻿${lineas.join('\r\n')}\r\n`);
  }));

  app.get('/api/respaldo', auth('admin'), wrap(async (req, res) => {
    const sql = await D.volcar(db);
    await D.bitacora(db, 'admin', 'respaldo', null);
    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="respaldo_5s_${L.localYMD(ahora())}.sql"`);
    res.send(sql);
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

  // ---------- frontend ----------
  function paginaIndex(req, res) {
    let html;
    try { html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); } catch { return res.status(404).send('Falta public/index.html'); }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(html.replace(/__NONCE__/g, res.locals.nonce));
  }
  app.get(['/', '/index.html'], paginaIndex);
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err && err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.codigo ? err.message : (err.status === 413 ? 'El archivo es demasiado grande.' : 'Solicitud inválida.'), ...(err.codigo ? { codigo: err.codigo } : {}) });
    }
    console.error('[error]', err && err.code ? `${err.code}: ${err.message}` : (err && err.stack ? err.stack.split('\n')[0] : err));
    if (err && /^(ECONNREFUSED|PROTOCOL_CONNECTION_LOST|ETIMEDOUT|ER_CON_COUNT_ERROR)/.test(err.code || '')) {
      return res.status(503).json({ error: 'La base de datos no está disponible. Inténtalo en un momento.' });
    }
    res.status(500).json({ error: 'Error interno del servidor.' });
  });

  return { app, db, correos, close: () => { correos.detener(); return db.close(); } };
}

module.exports = { createApp };
