'use strict';
const mysql = require('mysql2/promise');

// Migraciones incrementales (cada una es una lista de sentencias). Se aplican en orden al arrancar
// y se registran en la tabla `migraciones`.
const TABLA = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const MIGRACIONES = [
  [
    `CREATE TABLE areas (
      id VARCHAR(20) NOT NULL PRIMARY KEY, nombre VARCHAR(200) NOT NULL, checklist VARCHAR(20) NOT NULL, orden INT NOT NULL
    ) ${TABLA}`,
    `CREATE TABLE checklists (
      codigo VARCHAR(20) NOT NULL PRIMARY KEY, nombre VARCHAR(200) NOT NULL, formato VARCHAR(200) NULL,
      u2 DOUBLE NOT NULL, u3 DOUBLE NOT NULL, u4 DOUBLE NOT NULL, u5 DOUBLE NOT NULL
    ) ${TABLA}`,
    `CREATE TABLE puntos (
      checklist VARCHAR(20) NOT NULL, n INT NOT NULL, s VARCHAR(30) NOT NULL, texto TEXT NOT NULL, maximo INT NOT NULL,
      PRIMARY KEY (checklist, n)
    ) ${TABLA}`,
    `CREATE TABLE rotacion (
      semana INT NOT NULL, auditora VARCHAR(20) NOT NULL, auditada VARCHAR(20) NOT NULL,
      PRIMARY KEY (semana, auditora)
    ) ${TABLA}`,
    `CREATE TABLE parametros (clave VARCHAR(50) NOT NULL PRIMARY KEY, valor TEXT NOT NULL) ${TABLA}`,
    `CREATE TABLE auditorias (
      id VARCHAR(40) NOT NULL PRIMARY KEY, ciclo CHAR(10) NOT NULL, semana INT NOT NULL,
      auditora VARCHAR(20) NOT NULL, auditada VARCHAR(20) NOT NULL, checklist VARCHAR(20) NOT NULL,
      persona_audita VARCHAR(200) NULL, responsable VARCHAR(200) NULL, fecha CHAR(10) NULL,
      estado ENUM('borrador','final') NOT NULL,
      creado VARCHAR(30) NULL, terminado VARCHAR(30) NULL, firma MEDIUMTEXT NULL, dispositivo VARCHAR(64) NULL,
      calificacion DOUBLE NULL, nivel CHAR(2) NULL, usuario VARCHAR(64) NULL,
      INDEX idx_aud_semana (ciclo, semana)
    ) ${TABLA}`,
    `CREATE TABLE respuestas (
      auditoria_id VARCHAR(40) NOT NULL, n INT NOT NULL, puntos INT NULL, hallazgo TEXT NULL, accion TEXT NULL,
      PRIMARY KEY (auditoria_id, n)
    ) ${TABLA}`,
    `CREATE TABLE usuarios (
      area VARCHAR(20) NOT NULL PRIMARY KEY, pin_hash VARCHAR(100) NOT NULL, actualizado VARCHAR(40) NOT NULL
    ) ${TABLA}`,
    `CREATE TABLE bitacora (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, ts VARCHAR(30) NOT NULL, quien VARCHAR(64) NOT NULL,
      accion VARCHAR(60) NOT NULL, detalle VARCHAR(500) NULL
    ) ${TABLA}`,
  ],
  [
    // las áreas no se borran (el ID de auditoría usa su posición): se desactivan
    'ALTER TABLE areas ADD COLUMN activa TINYINT(1) NOT NULL DEFAULT 1',
  ],
  [
    // número de nómina de la persona auditada (sustituye a la firma como dato de cierre de la auditoría)
    'ALTER TABLE auditorias ADD COLUMN nomina_auditado VARCHAR(20) NULL AFTER responsable',
  ],
  [
    // segundos de captura activa de la auditoría; solo lo ve el administrador
    'ALTER TABLE auditorias ADD COLUMN duracion_seg INT NULL AFTER dispositivo',
  ],
  [
    // Gemba: hallazgos registrados en piso, con su foto
    `CREATE TABLE gemba (
      id VARCHAR(40) NOT NULL PRIMARY KEY, creado VARCHAR(30) NOT NULL, registrante VARCHAR(200) NOT NULL, area_registra VARCHAR(20) NOT NULL,
      fecha CHAR(10) NOT NULL, area VARCHAR(20) NOT NULL, lugar VARCHAR(200) NOT NULL, observacion TEXT NOT NULL, dirigido VARCHAR(20) NOT NULL,
      foto_tipo VARCHAR(20) NULL, foto MEDIUMBLOB NULL, dispositivo VARCHAR(64) NULL,
      INDEX idx_gemba_fecha (fecha), INDEX idx_gemba_area (area), INDEX idx_gemba_dirigido (dirigido), INDEX idx_gemba_registra (area_registra)
    ) ${TABLA}`,
  ],
  [
    // "dirigido a" pasa de área a nombre de persona (texto libre)
    'ALTER TABLE gemba MODIFY dirigido VARCHAR(200) NOT NULL',
  ],
  [
    // correo de cada área (destino de avisos) y registro de avisos ya enviados (para no repetirlos)
    'ALTER TABLE areas ADD COLUMN correo VARCHAR(200) NULL',
    `CREATE TABLE correos_enviados (clave VARCHAR(100) NOT NULL PRIMARY KEY, ts VARCHAR(30) NOT NULL) ${TABLA}`,
  ],
  [
    // subcategorías de cada área; "maquinas" es el texto que indica qué máquinas hay que auditar en ella
    `CREATE TABLE subareas (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, area VARCHAR(20) NOT NULL, nombre VARCHAR(200) NOT NULL,
      maquinas TEXT NULL, orden INT NOT NULL, activa TINYINT(1) NOT NULL DEFAULT 1,
      UNIQUE KEY uq_subarea (area, nombre)
    ) ${TABLA}`,
  ],
  [
    // sección del área auditada que se revisó (rota una por semana)
    'ALTER TABLE auditorias ADD COLUMN subarea VARCHAR(200) NULL AFTER auditada',
  ],
  [
    // máquina de la sección que eligió quien audita
    'ALTER TABLE auditorias ADD COLUMN maquina VARCHAR(200) NULL AFTER subarea',
  ],
  [
    // escala 0–5: cada pregunta vale 5 y la calificación es el porcentaje del máximo (en lugar de sumar 100)
    'ALTER TABLE checklists ADD COLUMN escala TINYINT NULL',
  ],
];

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Envoltura mínima sobre el pool: consultas parametrizadas (nunca se concatenan valores) y transacciones.
class Db {
  constructor(pool, ejecutor) { this.pool = pool; this.ej = ejecutor || pool; }
  async q(sql, params) { const [r] = await this.ej.query(sql, params); return r; }
  async uno(sql, params) { const r = await this.q(sql, params); return r[0] || null; }
  async tx(fn) {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const v = await fn(new Db(this.pool, c));
      await c.commit();
      return v;
    } catch (e) {
      try { await c.rollback(); } catch (e2) { /* la conexión ya se perdió */ }
      throw e;
    } finally { c.release(); }
  }
  close() { return this.pool.end(); }
}

async function abrir({ host, port, user, password, database, charset = 'utf8mb4', ssl }, { intentos = 30 } = {}) {
  const pool = mysql.createPool({
    host, port, user, password, database, charset, ...(ssl ? { ssl } : {}), waitForConnections: true, connectionLimit: 10,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
  });
  const db = new Db(pool);
  // la base puede tardar en estar lista cuando todo arranca junto
  for (let i = 1; ; i++) {
    try { await db.q('SELECT 1'); break; } catch (e) {
      if (i >= intentos) { await pool.end().catch(() => {}); throw new Error(`No se pudo conectar a MariaDB (${host}:${port}, base ${database}): ${e.message}`); }
      await pausa(2000);
    }
  }
  await migrar(db);
  await asegurarParametros(db);
  return db;
}

async function migrar(db) {
  await db.q(`CREATE TABLE IF NOT EXISTS migraciones (version INT NOT NULL PRIMARY KEY, aplicada VARCHAR(30) NOT NULL) ${TABLA}`);
  const hechas = new Set((await db.q('SELECT version FROM migraciones')).map((r) => r.version));
  for (let v = 1; v <= MIGRACIONES.length; v++) {
    if (hechas.has(v)) continue;
    for (const sql of MIGRACIONES[v - 1]) await db.q(sql); // el DDL de MariaDB confirma implícitamente
    await db.q('INSERT INTO migraciones (version, aplicada) VALUES (?,?)', [v, new Date().toISOString()]);
  }
}

// Una instalación nueva arranca vacía pero con parámetros por omisión: todo lo demás se captura desde la app.
async function asegurarParametros(db) {
  const hay = await db.uno("SELECT valor FROM parametros WHERE clave = 'inicio'");
  if (hay) return;
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // próximo lunes
  const inicio = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await db.q('INSERT INTO parametros (clave, valor) VALUES ?', [[['schema', 'a5s-config-1'], ['nombre', 'Auditorías 5S'], ['inicio', inicio], ['dias', '6']]]);
}

// Reemplaza la configuración. Si cambia el inicio del ciclo, las auditorías del ciclo anterior se
// archivan (su ID se prefija con el inicio del ciclo) para no chocar con las nuevas.
async function guardarConfig(db, cfg, { nuevoCiclo = false } = {}) {
  const previo = await db.uno("SELECT valor FROM parametros WHERE clave = 'inicio'");
  const { c: vivas } = await db.uno("SELECT COUNT(*) AS c FROM auditorias WHERE id NOT LIKE '%/%' AND ciclo <> ?", [cfg.inicio]);
  if (vivas && !nuevoCiclo) {
    const e = new Error(`Ya hay ${vivas} auditorías de otro ciclo (inicio ${previo ? previo.valor : '?'}). `
      + 'Descarga el CSV y confirma que quieres archivarlas para iniciar el ciclo nuevo.');
    e.status = 409;
    e.codigo = 'ciclo_nuevo';
    throw e;
  }
  await db.tx(async (t) => {
    if (vivas) {
      await t.q("UPDATE respuestas r JOIN auditorias a ON a.id = r.auditoria_id SET r.auditoria_id = CONCAT(a.ciclo, '/', a.id) WHERE a.id NOT LIKE '%/%' AND a.ciclo <> ?", [cfg.inicio]);
      await t.q("UPDATE auditorias SET id = CONCAT(ciclo, '/', id) WHERE id NOT LIKE '%/%' AND ciclo <> ?", [cfg.inicio]);
    }
    const subPrevias = await t.q('SELECT area, nombre, maquinas, orden, activa FROM subareas ORDER BY area, orden');
    const correosPrevios = new Map((await t.q('SELECT id, correo FROM areas')).map((r) => [r.id, r.correo]));
    for (const tabla of ['areas', 'subareas', 'checklists', 'puntos', 'rotacion', 'parametros']) await t.q(`DELETE FROM ${tabla}`);
    await t.q('INSERT INTO areas (id, nombre, checklist, orden, correo) VALUES ?', [cfg.areas.map((a, i) => [a.id, a.nombre, a.checklist, i, correosPrevios.get(a.id) || null])]);
    // subcategorías: las del JSON si el área trae "subareas"; si no, se conservan las que ya tenía
    const subs = [];
    cfg.areas.forEach((a) => {
      if (Array.isArray(a.subareas)) a.subareas.forEach((x, k) => subs.push([a.id, x.nombre.trim(), x.maquinas || null, k, 1]));
      else subPrevias.filter((x) => x.area === a.id).forEach((x) => subs.push([x.area, x.nombre, x.maquinas, x.orden, x.activa]));
    });
    if (subs.length) await t.q('INSERT INTO subareas (area, nombre, maquinas, orden, activa) VALUES ?', [subs]);
    await t.q('INSERT INTO checklists (codigo, nombre, formato, escala, u2, u3, u4, u5) VALUES ?',
      [cfg.checklists.map((c) => [c.codigo, c.nombre, c.formato || '', c.escala === 5 ? 5 : null, ...c.umbrales])]);
    const puntos = [];
    for (const c of cfg.checklists) for (const p of c.puntos) puntos.push([c.codigo, p.n, p.s, p.q, p.p]);
    await t.q('INSERT INTO puntos (checklist, n, s, texto, maximo) VALUES ?', [puntos]);
    const rot = [];
    cfg.rotacion.forEach((fila, w) => fila.forEach((v, a) => rot.push([w + 1, cfg.areas[a].id, cfg.areas[v].id])));
    await t.q('INSERT INTO rotacion (semana, auditora, auditada) VALUES ?', [rot]);
    await t.q('INSERT INTO parametros (clave, valor) VALUES ?', [[['schema', cfg.schema], ['nombre', cfg.nombre], ['inicio', cfg.inicio], ['dias', String(cfg.dias)]]]);
    // los PIN de áreas que ya no existen dejan de ser válidos
    await t.q("DELETE FROM usuarios WHERE area <> 'lobby' AND area NOT IN (SELECT id FROM areas)");
  });
}

// Carga la configuración a una estructura en memoria; null si aún no hay configuración.
async function cargarConfig(db) {
  const par = Object.fromEntries((await db.q('SELECT clave, valor FROM parametros')).map((r) => [r.clave, r.valor]));
  if (!par.inicio) return null;
  const areas = (await db.q('SELECT id, nombre, checklist, activa, correo FROM areas ORDER BY orden'))
    .map((a, i) => ({ id: a.id, nombre: a.nombre, checklist: a.checklist, activa: !!a.activa, correo: a.correo || '', idx: i }));
  const areaIdx = new Map(areas.map((a) => [a.id, a.idx]));
  for (const a of areas) a.subareas = [];
  for (const x of await db.q('SELECT id, area, nombre, maquinas, activa FROM subareas ORDER BY area, orden')) {
    const i = areaIdx.get(x.area);
    if (i !== undefined) areas[i].subareas.push({ id: x.id, nombre: x.nombre, maquinas: x.maquinas || '', activa: !!x.activa });
  }
  const checklists = new Map();
  for (const c of await db.q('SELECT * FROM checklists ORDER BY codigo')) {
    checklists.set(c.codigo, { codigo: c.codigo, nombre: c.nombre, formato: c.formato, escala: c.escala || null, umbrales: [c.u2, c.u3, c.u4, c.u5], puntos: [], total: 0 });
  }
  for (const p of await db.q('SELECT * FROM puntos ORDER BY checklist, n')) {
    const c = checklists.get(p.checklist);
    c.puntos.push({ n: p.n, s: p.s, q: p.texto, p: p.maximo });
    c.total += p.maximo;
  }
  // rotacion[semana-1][idxAuditora] = idxAuditada; las áreas sin asignación esa semana quedan sin valor
  const rotacion = [];
  const filas = await db.q('SELECT semana, auditora, auditada FROM rotacion');
  const maxSemana = filas.reduce((m, r) => Math.max(m, r.semana), 0);
  for (let w = 0; w < maxSemana; w++) rotacion.push([]);
  for (const r of filas) rotacion[r.semana - 1][areaIdx.get(r.auditora)] = areaIdx.get(r.auditada);
  return {
    schema: par.schema, nombre: par.nombre, inicio: par.inicio, dias: Number(par.dias),
    areas, areaIdx, checklists, rotacion, semanas: rotacion.length,
  };
}

// Config en el mismo formato del JSON de importación (lo que consume la app).
function configParaApi(cfg) {
  return {
    schema: cfg.schema, nombre: cfg.nombre, inicio: cfg.inicio, dias: cfg.dias,
    areas: cfg.areas.map((a) => ({ id: a.id, nombre: a.nombre, checklist: a.checklist, activa: a.activa, subareas: a.subareas })),
    checklists: [...cfg.checklists.values()].map((c) => ({
      codigo: c.codigo, nombre: c.nombre, formato: c.formato, escala: c.escala || undefined, umbrales: c.umbrales, puntos: c.puntos,
    })),
    rotacion: cfg.rotacion.map((fila) => Array.from({ length: cfg.areas.length }, (_, i) => (fila[i] === undefined ? null : fila[i]))),
  };
}

async function bitacora(db, quien, accion, detalle) {
  await db.q('INSERT INTO bitacora (ts, quien, accion, detalle) VALUES (?,?,?,?)',
    [new Date().toISOString(), String(quien).slice(0, 64), accion, detalle ? String(detalle).slice(0, 500) : null]);
}

// Respaldo lógico en SQL (estructura + datos) que se puede restaurar en phpMyAdmin o con `mysql < archivo.sql`.
async function volcar(db) {
  const esc = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : mysql.escape(String(v)));
  const out = [`-- Respaldo de Auditorías 5S · ${new Date().toISOString()}`, 'SET NAMES utf8mb4;', 'SET FOREIGN_KEY_CHECKS=0;', ''];
  const tablas = (await db.q('SHOW TABLES')).map((r) => Object.values(r)[0]);
  for (const t of tablas) {
    const [{ 'Create Table': ddl }] = await db.q(`SHOW CREATE TABLE \`${t}\``);
    out.push(`DROP TABLE IF EXISTS \`${t}\`;`, `${ddl};`);
    const filas = await db.q(`SELECT * FROM \`${t}\``);
    for (let i = 0; i < filas.length; i += 200) {
      const lote = filas.slice(i, i + 200);
      const cols = Object.keys(lote[0]).map((c) => `\`${c}\``).join(', ');
      out.push(`INSERT INTO \`${t}\` (${cols}) VALUES`, lote.map((f) => `(${Object.values(f).map(esc).join(', ')})`).join(',\n') + ';');
    }
    out.push('');
  }
  out.push('SET FOREIGN_KEY_CHECKS=1;');
  return out.join('\n');
}

module.exports = { abrir, guardarConfig, cargarConfig, configParaApi, bitacora, volcar };
