'use strict';
// Administración dentro de la app: áreas (y su usuario/PIN), checklists con sus preguntas, parámetros del ciclo y rotación.
// Reglas de integridad:
//  - Las áreas no se borran, se desactivan: el ID de auditoría (S03-A12) usa la posición del área.
//  - Un checklist que ya se usó en auditorías solo admite cambios de texto/nombre; no puede cambiar su estructura
//    (preguntas, valores, umbrales) porque cambiaría el significado de las calificaciones ya capturadas.
//  - La rotación se genera sola. Las semanas que ya iniciaron nunca se modifican.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const L = require('./logic');
const D = require('./db');
const { erroresChecklist, NOMBRES_S } = require('./configImport');
const { rotacionDesdeCero, completarSemanas } = require('./rotacion');
const { esCorreo } = require('./correo');

function registrar({ app, db, auth, wrap, fail, ahora, getCfg, recargar, nuevaVersion, SQL_PIN }) {
  const admin = auth('admin');
  const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  // ---------- lecturas ----------
  async function usoChecklists() {
    const uso = new Map();
    for (const r of await db.q("SELECT checklist, COUNT(*) AS c FROM auditorias WHERE id NOT LIKE '%/%' GROUP BY checklist")) uso.set(r.checklist, r.c);
    return uso;
  }

  app.get('/api/admin/resumen', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const uso = await usoChecklists();
    const { c: auditorias } = await db.uno("SELECT COUNT(*) AS c FROM auditorias WHERE id NOT LIKE '%/%'");
    const hoy = L.localYMD(ahora());
    res.json({
      parametros: { nombre: cfg.nombre, inicio: cfg.inicio, dias: cfg.dias },
      hoy,
      areas: cfg.areas.map((a) => ({ id: a.id, nombre: a.nombre, checklist: a.checklist, activa: a.activa, correo: a.correo || '', secciones: (a.subareas || []).filter((s) => s.activa).length })),
      checklists: [...cfg.checklists.values()].map((c) => ({
        codigo: c.codigo, nombre: c.nombre, formato: c.formato || '', escala: c.escala || null, umbrales: c.umbrales, puntos: c.puntos, total: c.total,
        areas: cfg.areas.filter((a) => a.checklist === c.codigo).map((a) => a.id),
        auditorias: uso.get(c.codigo) || 0,
      })),
      rotacion: {
        semanas: cfg.semanas, activas: cfg.areas.filter((a) => a.activa).length,
        iniciado: hoy >= cfg.inicio, semanaActual: L.semanaActual(cfg.inicio, hoy, Math.max(cfg.semanas, 1)),
      },
      auditorias,
      lobby: { configurado: !!(await db.uno("SELECT 1 AS x FROM usuarios WHERE area = 'lobby'")) },
    });
  }));

  // ---------- rotación ----------
  // Recalcula la rotación tras un cambio de áreas. Antes de que inicie el ciclo se rehace completa; ya iniciado,
  // las semanas que ya comenzaron se conservan tal cual y solo se rehacen las futuras (sin repetir parejas).
  async function ajustarRotacion({ completa = false } = {}) {
    const cfg = getCfg();
    const hoy = L.localYMD(ahora());
    const activos = cfg.areas.filter((a) => a.activa).map((a) => a.idx);
    let congeladas = 0;
    if (!completa && hoy >= cfg.inicio) {
      const act = L.semanaActual(cfg.inicio, hoy, 1e9);
      congeladas = Math.min(cfg.semanas, act.semana);
    }
    // un ciclo con m áreas activas puede tener hasta m-1 semanas; nunca se acorta por voluntad propia
    const objetivo = Math.max(cfg.semanas, activos.length - 1, 0);
    let nuevas;
    if (congeladas === 0) {
      nuevas = rotacionDesdeCero(activos);
    } else {
      const usados = new Set();
      for (let w = 0; w < congeladas; w++) cfg.rotacion[w].forEach((b, a) => { if (b !== undefined) usados.add(`${a}>${b}`); });
      nuevas = completarSemanas(activos, usados, Math.max(0, objetivo - congeladas));
    }
    await db.tx(async (t) => {
      await t.q('DELETE FROM rotacion WHERE semana > ?', [congeladas]);
      const filas = [];
      nuevas.forEach((sem, i) => sem.forEach(([a, b]) => filas.push([congeladas + 1 + i, cfg.areas[a].id, cfg.areas[b].id])));
      if (filas.length) await t.q('INSERT INTO rotacion (semana, auditora, auditada) VALUES ?', [filas]);
    });
    const nueva = await recargar();
    return {
      semanas: nueva.semanas, congeladas,
      nota: congeladas
        ? `Las ${congeladas} semana(s) que ya iniciaron se conservaron; la rotación futura se recalculó (${nueva.semanas} semanas en total).`
        : `Rotación generada: ${nueva.semanas} semanas para ${activos.length} áreas activas.`,
    };
  }

  app.post('/api/rotacion/regenerar', admin, wrap(async (req, res) => {
    const completa = !!(req.body && req.body.completa);
    if (completa) {
      const { c } = await db.uno("SELECT COUNT(*) AS c FROM auditorias WHERE id NOT LIKE '%/%'");
      if (c) fail(409, `Ya hay ${c} auditoría(s) capturada(s): no se puede rehacer toda la rotación. Se puede recalcular solo la parte futura.`);
    }
    const r = await ajustarRotacion({ completa });
    await D.bitacora(db, 'admin', 'rotacion_regenerada', r.nota);
    res.json({ ok: true, ...r });
  }));

  // ---------- áreas (cada área es también su usuario: tiene su PIN) ----------
  const siguienteId = (cfg) => {
    let max = 0;
    for (const a of cfg.areas) { const m = /^A-(\d+)$/.exec(a.id); if (m) max = Math.max(max, +m[1]); }
    return `A-${String(Math.max(max, cfg.areas.length) + 1).padStart(2, '0')}`;
  };

  app.post('/api/areas', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const lista = req.body && Array.isArray(req.body.areas) ? req.body.areas : null;
    if (!lista || !lista.length) fail(422, 'Indica al menos un área ({ areas: [{ nombre, checklist }] }).');
    if (lista.length > 99) fail(422, 'Máximo 99 áreas por solicitud.');
    const nombres = new Set(cfg.areas.map((a) => a.nombre.toLowerCase()));
    const errores = [];
    const nuevas = [];
    lista.forEach((x, i) => {
      const nombre = texto(x && x.nombre, 200);
      const checklist = texto(x && x.checklist, 20);
      if (!nombre) return errores.push(`Área #${i + 1}: falta el nombre.`);
      if (!cfg.checklists.has(checklist)) return errores.push(`Área "${nombre}": el checklist "${checklist}" no existe.`);
      if (nombres.has(nombre.toLowerCase())) return errores.push(`Ya existe un área llamada "${nombre}".`);
      nombres.add(nombre.toLowerCase());
      nuevas.push({ nombre, checklist });
    });
    if (cfg.areas.length + nuevas.length > 99) errores.push('Se admiten máximo 99 áreas en total (el ID de auditoría usa 2 dígitos).');
    if (errores.length) return res.status(422).json({ error: errores[0], errores });

    const creadas = [];
    let proximo = cfg.areas.length;
    let idNum = Number(siguienteId(cfg).slice(2));
    for (const n of nuevas) {
      const id = `A-${String(idNum).padStart(2, '0')}`;
      idNum += 1;
      creadas.push({ id, nombre: n.nombre, checklist: n.checklist, orden: proximo, pin: String(crypto.randomInt(0, 10000)).padStart(4, '0') });
      proximo += 1;
    }
    const hashes = await Promise.all(creadas.map((c) => bcrypt.hash(c.pin, 10)));
    await db.tx(async (t) => {
      await t.q('INSERT INTO areas (id, nombre, checklist, orden, activa) VALUES ?', [creadas.map((c) => [c.id, c.nombre, c.checklist, c.orden, 1])]);
      for (let i = 0; i < creadas.length; i++) await t.q(SQL_PIN, [creadas[i].id, hashes[i], nuevaVersion()]);
    });
    await recargar();
    const rot = await ajustarRotacion();
    await D.bitacora(db, 'admin', 'areas_creadas', creadas.map((c) => c.id).join(', '));
    res.status(201).json({ areas: creadas.map(({ id, nombre, checklist, pin }) => ({ id, nombre, checklist, pin })), rotacion: rot });
  }));

  app.put('/api/areas/:id', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const idx = cfg.areaIdx.get(req.params.id);
    if (idx === undefined) fail(404, 'El área no existe.');
    const a = cfg.areas[idx];
    const b = req.body || {};
    const nombre = b.nombre === undefined ? a.nombre : texto(b.nombre, 200);
    const checklist = b.checklist === undefined ? a.checklist : texto(b.checklist, 20);
    const activa = b.activa === undefined ? a.activa : !!b.activa;
    const correo = b.correo === undefined ? a.correo : texto(b.correo, 200);
    if (correo && !esCorreo(correo)) fail(422, 'El correo no es válido.');
    if (!nombre) fail(422, 'El nombre no puede quedar vacío.');
    if (!cfg.checklists.has(checklist)) fail(422, `El checklist "${checklist}" no existe.`);
    if (cfg.areas.some((x) => x.idx !== idx && x.nombre.toLowerCase() === nombre.toLowerCase())) fail(422, `Ya existe un área llamada "${nombre}".`);
    if (checklist !== a.checklist) {
      const { c } = await db.uno("SELECT COUNT(*) AS c FROM auditorias WHERE auditada = ? AND estado = 'borrador' AND id NOT LIKE '%/%'", [a.id]);
      if (c) fail(409, `Hay ${c} auditoría(s) en borrador para ${a.nombre}. Termínalas antes de cambiarle el checklist.`);
    }
    await db.q('UPDATE areas SET nombre = ?, checklist = ?, activa = ?, correo = ? WHERE id = ?', [nombre, checklist, activa ? 1 : 0, correo || null, a.id]);
    await recargar();
    let rotacion = null;
    if (activa !== a.activa) rotacion = await ajustarRotacion();
    await D.bitacora(db, 'admin', 'area_modificada', `${a.id}${activa !== a.activa ? (activa ? ' activada' : ' desactivada') : ''}`);
    res.json({ ok: true, area: { id: a.id, nombre, checklist, activa, correo }, rotacion });
  }));

  // ---------- subcategorías de un área (cada una con el texto de las máquinas a auditar) ----------
  // Se reemplaza la lista completa: { subareas: [{ nombre, maquinas }] }
  app.get('/api/areas/:id/subareas', admin, wrap((req, res) => {
    const idx = getCfg().areaIdx.get(req.params.id);
    if (idx === undefined) fail(404, 'El área no existe.');
    res.json({ area: req.params.id, subareas: getCfg().areas[idx].subareas });
  }));

  app.put('/api/areas/:id/subareas', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const idx = cfg.areaIdx.get(req.params.id);
    if (idx === undefined) fail(404, 'El área no existe.');
    const lista = req.body && Array.isArray(req.body.subareas) ? req.body.subareas : null;
    if (!lista) fail(422, 'Envía { subareas: [{ nombre, maquinas }] }.');
    if (lista.length > 100) fail(422, 'Máximo 100 subcategorías por área.');
    const vistos = new Set();
    const filas = [];
    const errores = [];
    lista.forEach((x, k) => {
      const nombre = texto(x && x.nombre, 200);
      if (!nombre) return errores.push(`Subcategoría #${k + 1}: falta el nombre.`);
      if (vistos.has(nombre.toLowerCase())) return errores.push(`La subcategoría "${nombre}" está repetida.`);
      vistos.add(nombre.toLowerCase());
      filas.push([req.params.id, nombre, L.listaMaquinas(texto(x.maquinas, 5000)).join('\n') || null, k, x.activa === false ? 0 : 1]);
    });
    if (errores.length) return res.status(422).json({ error: errores[0], errores });
    await db.tx(async (t) => {
      await t.q('DELETE FROM subareas WHERE area = ?', [req.params.id]);
      if (filas.length) await t.q('INSERT INTO subareas (area, nombre, maquinas, orden, activa) VALUES ?', [filas]);
    });
    await recargar();
    await D.bitacora(db, 'admin', 'subareas_guardadas', `${req.params.id}: ${filas.length}`);
    res.json({ ok: true, area: req.params.id, subareas: getCfg().areas[idx].subareas });
  }));

  // ---------- checklists y preguntas ----------
  // Ordena las preguntas por S (estable) y las renumera 1..N
  function normalizar(c) {
    const puntos = Array.isArray(c.puntos) ? c.puntos.map((p, i) => ({ ...p, _i: i })) : [];
    puntos.sort((x, y) => NOMBRES_S.indexOf(x.s) - NOMBRES_S.indexOf(y.s) || x._i - y._i);
    return {
      codigo: texto(c.codigo, 20), nombre: texto(c.nombre, 200), formato: texto(c.formato, 200), escala: c.escala === 5 ? 5 : null,
      umbrales: Array.isArray(c.umbrales) ? c.umbrales.map(Number) : c.umbrales,
      puntos: puntos.map((p, i) => ({ n: i + 1, s: p.s, q: texto(p.q, 2000), p: Number(p.p) })),
    };
  }

  async function guardarChecklist(t, c, esNuevo) {
    if (esNuevo) await t.q('INSERT INTO checklists (codigo, nombre, formato, escala, u2, u3, u4, u5) VALUES (?,?,?,?,?,?,?,?)', [c.codigo, c.nombre, c.formato, c.escala, ...c.umbrales]);
    else await t.q('UPDATE checklists SET nombre = ?, formato = ?, escala = ?, u2 = ?, u3 = ?, u4 = ?, u5 = ? WHERE codigo = ?', [c.nombre, c.formato, c.escala, ...c.umbrales, c.codigo]);
    await t.q('DELETE FROM puntos WHERE checklist = ?', [c.codigo]);
    await t.q('INSERT INTO puntos (checklist, n, s, texto, maximo) VALUES ?', [c.puntos.map((p) => [c.codigo, p.n, p.s, p.q, p.p])]);
  }

  app.post('/api/checklists', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const c = normalizar(req.body || {});
    const errores = erroresChecklist(c, `Checklist ${c.codigo || 'nuevo'}`);
    if (c.codigo && cfg.checklists.has(c.codigo)) errores.push(`Ya existe un checklist con el código ${c.codigo}.`);
    if (errores.length) return res.status(422).json({ error: errores[0], errores });
    await db.tx((t) => guardarChecklist(t, c, true));
    await recargar();
    await D.bitacora(db, 'admin', 'checklist_creado', c.codigo);
    res.status(201).json({ ok: true, codigo: c.codigo });
  }));

  app.put('/api/checklists/:codigo', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const actual = cfg.checklists.get(req.params.codigo);
    if (!actual) fail(404, 'El checklist no existe.');
    const uso = (await usoChecklists()).get(actual.codigo) || 0;
    const body = { ...(req.body || {}), codigo: actual.codigo };
    // en uso: se respeta el orden/numeración que manda el cliente para poder comparar punto por punto
    const c = uso ? { ...normalizar(body), puntos: (Array.isArray(body.puntos) ? body.puntos : []).map((p) => ({ n: p.n, s: p.s, q: texto(p.q, 2000), p: Number(p.p) })) } : normalizar(body);
    const errores = erroresChecklist(c, `Checklist ${c.codigo}`);
    if (errores.length) return res.status(422).json({ error: errores[0], errores });
    if (uso) {
      const igual = c.puntos.length === actual.puntos.length
        && c.puntos.every((p, i) => p.n === actual.puntos[i].n && p.s === actual.puntos[i].s && p.p === actual.puntos[i].p)
        && c.umbrales.every((u, i) => u === actual.umbrales[i]);
      if (!igual) {
        fail(409, `Este checklist ya se usó en ${uso} auditoría(s). Solo se pueden cambiar el nombre, el formato y el texto de las preguntas: agregar, quitar o cambiar el valor de las preguntas, o los umbrales, alteraría las calificaciones ya capturadas. Hazlo en un ciclo nuevo.`);
      }
    }
    await db.tx((t) => guardarChecklist(t, c, false));
    await recargar();
    await D.bitacora(db, 'admin', 'checklist_modificado', c.codigo);
    res.json({ ok: true, codigo: c.codigo });
  }));

  app.post('/api/checklists/:codigo/duplicar', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const origen = cfg.checklists.get(req.params.codigo);
    if (!origen) fail(404, 'El checklist no existe.');
    const codigo = texto(req.body && req.body.codigo, 20);
    const nombre = texto(req.body && req.body.nombre, 200) || `${origen.nombre} (copia)`;
    if (cfg.checklists.has(codigo)) fail(422, `Ya existe un checklist con el código ${codigo}.`);
    const c = normalizar({ ...origen, codigo, nombre, puntos: origen.puntos });
    const errores = erroresChecklist(c, `Checklist ${codigo || 'nuevo'}`);
    if (errores.length) return res.status(422).json({ error: errores[0], errores });
    await db.tx((t) => guardarChecklist(t, c, true));
    await recargar();
    await D.bitacora(db, 'admin', 'checklist_duplicado', `${origen.codigo} → ${codigo}`);
    res.status(201).json({ ok: true, codigo });
  }));

  app.delete('/api/checklists/:codigo', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const c = cfg.checklists.get(req.params.codigo);
    if (!c) fail(404, 'El checklist no existe.');
    const usan = cfg.areas.filter((a) => a.checklist === c.codigo);
    if (usan.length) fail(409, `No se puede eliminar: lo usan ${usan.length} área(s) (${usan.slice(0, 5).map((a) => a.id).join(', ')}${usan.length > 5 ? '…' : ''}). Cámbiales el checklist primero.`);
    const { n } = await db.uno('SELECT COUNT(*) AS n FROM auditorias WHERE checklist = ?', [c.codigo]);
    if (n) fail(409, `No se puede eliminar: tiene ${n} auditoría(s) registradas.`);
    await db.tx(async (t) => {
      await t.q('DELETE FROM puntos WHERE checklist = ?', [c.codigo]);
      await t.q('DELETE FROM checklists WHERE codigo = ?', [c.codigo]);
    });
    await recargar();
    await D.bitacora(db, 'admin', 'checklist_eliminado', c.codigo);
    res.json({ ok: true });
  }));

  // ---------- usuario lobby: solo ve el dashboard de semáforos ----------
  app.put('/api/lobby/password', admin, wrap(async (req, res) => {
    const b = req.body || {};
    let password = b.password;
    const generada = !!b.generar;
    if (generada) password = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (typeof password !== 'string' || password.length < 4 || password.length > 72) fail(422, 'La contraseña de lobby debe tener entre 4 y 72 caracteres.');
    await db.q(SQL_PIN, ['lobby', await bcrypt.hash(password, 10), nuevaVersion()]);
    await D.bitacora(db, 'admin', 'lobby_contrasena', generada ? 'generada' : 'establecida');
    res.json({ ok: true, ...(generada ? { password } : {}) });
  }));

  // ---------- parámetros del ciclo ----------
  app.put('/api/parametros', admin, wrap(async (req, res) => {
    const cfg = getCfg();
    const b = req.body || {};
    const nombre = b.nombre === undefined ? cfg.nombre : texto(b.nombre, 120);
    const dias = b.dias === undefined ? cfg.dias : b.dias;
    if (!nombre) fail(422, 'El nombre no puede quedar vacío.');
    if (!Number.isInteger(dias) || dias < 1 || dias > 30) fail(422, '"Días para completar" debe ser un entero entre 1 y 30.');
    await db.tx(async (t) => {
      await t.q("UPDATE parametros SET valor = ? WHERE clave = 'nombre'", [nombre]);
      await t.q("UPDATE parametros SET valor = ? WHERE clave = 'dias'", [String(dias)]);
    });
    await recargar();
    await D.bitacora(db, 'admin', 'parametros_modificados', `nombre="${nombre}", dias=${dias}`);
    res.json({ ok: true, nombre, dias });
  }));
}

module.exports = { registrar };
