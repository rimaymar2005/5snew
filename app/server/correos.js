'use strict';
// Correos de la app (por planta): nuevo hallazgo Gemba, recordatorios de auditorías pendientes/atrasadas y resumen semanal.
// Cada aviso se registra en `correos_enviados` con una clave única para no repetirlo (ni al reiniciar la app).
const L = require('./logic');
const D = require('./db');
const { esCorreo } = require('./correo');

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROJO = '#e2001a';

// Todo texto que viene de usuarios pasa por esc(). `filas` = [[etiqueta, valor]] (valor ya escapado) o { tabla: { cab, filas } }.
function plantilla({ titulo, intro, filas, tabla, url, pie }) {
  const lista = (filas || []).map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${v}</td></tr>`).join('');
  const tab = tabla && tabla.filas.length ? `<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:14px"><thead><tr>${tabla.cab.map((c) => `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid ${ROJO};color:#374151">${esc(c)}</th>`).join('')}</tr></thead><tbody>${tabla.filas.map((f) => `<tr>${f.map((c) => `<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#111827;max-width:640px">
<div style="border-top:4px solid ${ROJO};padding-top:12px"><h2 style="margin:0 0 8px;font-size:18px">${esc(titulo)}</h2></div>
${intro ? `<p style="margin:8px 0">${intro}</p>` : ''}${lista ? `<table style="border-collapse:collapse;margin:8px 0">${lista}</table>` : ''}${tab}
${url ? `<p style="margin:16px 0"><a href="${esc(url)}" style="background:${ROJO};color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Abrir la app</a></p>` : ''}
<p style="color:#6b7280;font-size:12px;margin-top:20px">${esc(pie || 'Mensaje automático de Auditorías 5S.')}</p></div>`;
}

function crearCorreos({ db, getCfg, ahora, filaSemana, mapaAuditorias, correo, planta, adminCorreos = [], urlApp }) {
  const pendientes = new Set();
  const activo = () => !!(correo && correo.activo);
  const admins = () => adminCorreos.filter(esCorreo);
  const etiqueta = `5S · ${planta}`;

  // Envía sin lanzar errores (un fallo de correo nunca debe tumbar la operación que lo originó); lo deja en la bitácora.
  function enviarSeguro(clave, msg) {
    const p = (async () => {
      for (let i = 0; i < 2; i++) {
        try { await correo.enviar(msg); await D.bitacora(db, 'correo', 'correo_enviado', `${clave} → ${msg.to.length} dest.`); return true; } catch (e) {
          if (i === 1) { try { await D.bitacora(db, 'correo', 'correo_error', `${clave}: ${e.message}`); } catch (e2) { /* sin bitácora */ } } else await new Promise((r) => setTimeout(r, 1500));
        }
      }
      return false;
    })();
    pendientes.add(p);
    p.finally(() => pendientes.delete(p));
    return p;
  }
  // Marca un aviso como enviado; false si ya existía (así no se repite).
  async function reservar(clave) {
    const r = await db.q('INSERT IGNORE INTO correos_enviados (clave, ts) VALUES (?, ?)', [clave, new Date().toISOString()]);
    return r.affectedRows === 1;
  }
  const correoDe = (areaId) => { const cfg = getCfg(); const i = cfg && cfg.areaIdx.get(areaId); const a = i === undefined ? null : cfg.areas[i]; return a && esCorreo(a.correo) ? a.correo.trim() : null; };
  const nombreDe = (id) => { const cfg = getCfg(); const i = cfg.areaIdx.get(id); return i === undefined ? id : cfg.areas[i].nombre; };

  // ----- Gemba: nuevo hallazgo (al área del problema y al administrador, con la foto adjunta) -----
  function gembaNuevo({ id, registrante, fecha, area, lugar, observacion, dirigido, fotoTipo, fotoBase64 }) {
    if (!activo()) return Promise.resolve(false);
    const to = [...new Set([correoDe(area), ...admins()].filter(Boolean))];
    if (!to.length) return Promise.resolve(false);
    const ext = fotoTipo === 'image/png' ? 'png' : fotoTipo === 'image/webp' ? 'webp' : 'jpg';
    return enviarSeguro(`gemba:${id}`, {
      to,
      subject: `[Gemba · ${planta}] Nuevo hallazgo en ${nombreDe(area)} · ${lugar}`.slice(0, 200),
      html: plantilla({
        titulo: 'Nuevo hallazgo Gemba',
        filas: [['Área', esc(`${area} · ${nombreDe(area)}`)], ['Lugar / máquina', esc(lugar)], ['Fecha', esc(fecha)], ['Registró', esc(registrante)], ['Dirigido a', esc(dirigido)], ['Observación', esc(observacion)]],
        intro: 'Se registró un hallazgo. La foto del problema va adjunta.', url: urlApp,
      }),
      adjuntos: [{ nombre: `hallazgo-${id}.${ext}`, tipo: fotoTipo, base64: fotoBase64 }],
    });
  }

  // ----- revisión diaria: recordatorios y resumen semanal -----
  async function revisarDiario({ forzar = false } = {}) {
    const cfg = getCfg();
    const res = { recordatorios: 0, atrasadas: 0, resumen: false };
    if (!activo() || !cfg) return res;
    const hoy = L.localYMD(ahora());
    if (!forzar && !(await reservar(`diario:${hoy}`))) return res;
    const act = L.semanaActual(cfg.inicio, hoy, cfg.semanas);
    if (act.estado !== 'activo') return res;
    const mapa = await mapaAuditorias();
    const activas = cfg.areas.filter((a) => a.activa);
    const enlaces = [];

    // atrasadas de cualquier semana hasta hoy, por área auditora
    const atrasadas = new Map();
    for (let s = 1; s <= act.semana; s++) {
      for (const a of activas) {
        const f = filaSemana(s, a.idx, mapa, hoy);
        if (f && f.estatus === 'Atrasada') { if (!atrasadas.has(a.id)) atrasadas.set(a.id, []); atrasadas.get(a.id).push(f); }
      }
    }
    const filaAud = (f) => [esc(f.id), esc(`Semana ${f.semana}`), esc(`${f.auditada} · ${f.auditada_nombre}`), esc(f.fecha_limite)];
    const cab = ['Auditoría', 'Semana', 'Área a auditar', 'Fecha límite'];
    for (const [areaId, lista] of atrasadas) {
      res.atrasadas += lista.length;
      const to = correoDe(areaId);
      if (!to || !(await reservar(`atr:${areaId}:${hoy}`))) continue;
      enlaces.push(enviarSeguro(`atr:${areaId}`, {
        to: [to], subject: `[${etiqueta}] Tienes ${lista.length} auditoría${lista.length === 1 ? '' : 's'} atrasada${lista.length === 1 ? '' : 's'}`,
        html: plantilla({ titulo: 'Auditorías 5S atrasadas', intro: `${esc(nombreDe(areaId))}: estas auditorías ya pasaron su fecha límite.`, tabla: { cab, filas: lista.map(filaAud) }, url: urlApp }),
      }));
    }
    // pendientes de esta semana que vencen hoy o mañana (un solo recordatorio por auditoría)
    for (const a of activas) {
      const f = filaSemana(act.semana, a.idx, mapa, hoy);
      if (!f || f.estatus !== 'Pendiente' || hoy < L.addDays(f.fecha_limite, -1)) continue;
      const to = correoDe(a.id);
      if (!to || !(await reservar(`pen:${f.id}`))) continue;
      res.recordatorios += 1;
      enlaces.push(enviarSeguro(`pen:${f.id}`, {
        to: [to], subject: `[${etiqueta}] Recordatorio: tu auditoría vence el ${f.fecha_limite}`,
        html: plantilla({ titulo: 'Auditoría 5S por vencer', intro: `${esc(a.nombre)}: tu auditoría de esta semana aún no se ha registrado.`, tabla: { cab, filas: [filaAud(f)] }, url: urlApp }),
      }));
    }
    // el administrador recibe la lista completa de atrasadas del día
    if (atrasadas.size && admins().length && (await reservar(`atr-admin:${hoy}`))) {
      const filas = [];
      for (const [areaId, lista] of atrasadas) for (const f of lista) filas.push([esc(`${areaId} · ${nombreDe(areaId)}`), ...filaAud(f)]);
      enlaces.push(enviarSeguro('atr-admin', {
        to: admins(), subject: `[${etiqueta}] ${res.atrasadas} auditoría${res.atrasadas === 1 ? '' : 's'} atrasada${res.atrasadas === 1 ? '' : 's'}`,
        html: plantilla({ titulo: 'Auditorías atrasadas', intro: `Al ${esc(hoy)} hay ${res.atrasadas} auditoría(s) atrasada(s) en ${atrasadas.size} área(s).`, tabla: { cab: ['Área auditora', ...cab], filas }, url: urlApp }),
      }));
    }
    // resumen de la semana que acaba de terminar (al administrador)
    if (act.semana > 1 && admins().length) res.resumen = await resumenSemana(act.semana - 1, mapa, hoy, enlaces);
    await Promise.all(enlaces);
    return res;
  }

  async function resumenSemana(w, mapa, hoy, enlaces) {
    const cfg = getCfg();
    if (!(await reservar(`resumen:${w}`))) return false;
    const filas = cfg.areas.filter((a) => a.activa).map((a) => filaSemana(w, a.idx, mapa, hoy)).filter(Boolean);
    const hechas = filas.filter((f) => f.estatus === 'Completada');
    const faltan = filas.filter((f) => f.estatus !== 'Completada');
    const prom = hechas.length ? L.redondear1(hechas.reduce((x, f) => x + f.calificacion, 0) / hechas.length) : null;
    const ini = L.inicioSemana(cfg.inicio, w);
    const fin = L.addDays(ini, 6);
    const gemba = await db.q('SELECT area, lugar, observacion FROM gemba WHERE fecha BETWEEN ? AND ? ORDER BY fecha, creado', [ini, fin]);
    enlaces.push(enviarSeguro(`resumen:${w}`, {
      to: admins(), subject: `[${etiqueta}] Resumen de la semana ${w} (${ini} al ${fin})`,
      html: plantilla({
        titulo: `Resumen semanal · semana ${w}`, url: urlApp,
        filas: [['Periodo', esc(`${ini} al ${fin}`)], ['Auditorías de la semana', String(filas.length)], ['Completadas', String(hechas.length)],
          ['Sin completar', String(faltan.length)], ['Calificación promedio', prom === null ? '—' : String(prom)], ['Hallazgos Gemba', String(gemba.length)]],
        tabla: { cab: ['Área auditora', 'Audita a', 'Estatus'], filas: faltan.map((f) => [esc(`${f.auditora} · ${f.auditora_nombre}`), esc(`${f.auditada} · ${f.auditada_nombre}`), esc(f.estatus)]) },
        intro: faltan.length ? 'Auditorías que no se completaron:' : 'Todas las auditorías de la semana se completaron.',
      }),
    }));
    return true;
  }

  // ----- programador: una revisión por día, a partir de la hora indicada (hora local del servidor) -----
  let timer = null;
  function iniciar({ hora = 8, cadaMs = 30 * 60 * 1000 } = {}) {
    if (timer || !activo()) return;
    const tic = () => { if (ahora().getHours() >= hora) revisarDiario().catch((e) => console.error('[correo]', e.message)); };
    timer = setInterval(tic, cadaMs);
    timer.unref();
    setTimeout(tic, 20000).unref();
  }
  const detener = () => { if (timer) clearInterval(timer); timer = null; };
  const esperar = () => Promise.all([...pendientes]);

  return { gembaNuevo, revisarDiario, iniciar, detener, esperar, activo, admins };
}

// Rutas del administrador: estado del correo y envío de prueba
function registrar({ app, auth, wrap, fail, correos, correo }) {
  app.get('/api/admin/correo', auth('admin'), wrap((req, res) => {
    res.json({ activo: correos.activo(), remitente: correo.remitente || null, admin: correos.admins() });
  }));
  app.post('/api/admin/correo/prueba', auth('admin'), wrap(async (req, res) => {
    if (!correos.activo()) fail(409, 'El correo no está configurado en el servidor (variables GRAPH_*).');
    const to = correos.admins();
    if (!to.length) fail(409, 'No hay correo de administrador configurado (MAIL_ADMIN).');
    try {
      await correo.enviar({ to, subject: '[Auditorías 5S] Correo de prueba', html: plantilla({ titulo: 'Correo de prueba', intro: 'La conexión con Microsoft Graph funciona.' }) });
    } catch (e) { fail(502, `No se pudo enviar: ${e.message}`); }
    res.json({ ok: true, destinatarios: to });
  }));
}

module.exports = { crearCorreos, registrar, plantilla, esc };
