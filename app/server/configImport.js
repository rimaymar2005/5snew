'use strict';
const { parseYMD } = require('./logic');

const SCHEMA = 'a5s-config-1';
const MAX_ERRORES = 40;
const NOMBRES_S = ['Seleccionar', 'Ordenar', 'Limpiar', 'Estandarizar', 'Sostener'];

const esTexto = (x) => typeof x === 'string' && x.trim().length > 0;
const esEntero = (x) => Number.isInteger(x);

// Errores de un checklist (estructura, umbrales, puntos y suma = 100). `et` es la etiqueta para los mensajes.
function erroresChecklist(c, et) {
  const out = [];
  const err = (m) => out.push(m);
  if (!c || !esTexto(c.codigo)) return [`${et}: falta "codigo".`];
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(c.codigo)) err(`${et}: el código solo puede llevar letras, números, punto, guion y guion bajo (máximo 20).`);
  if (!esTexto(c.nombre)) err(`${et}: falta "nombre".`);
  const u = c.umbrales;
  if (!Array.isArray(u) || u.length !== 4 || u.some((x) => typeof x !== 'number' || !(x > 0 && x <= 100))
    || !(u[0] < u[1] && u[1] < u[2] && u[2] < u[3])) {
    err(`${et}: "umbrales" debe tener 4 números crecientes entre 0 y 100 (2S, 3S, 4S, 5S).`);
  }
  if (!Array.isArray(c.puntos) || !c.puntos.length) { err(`${et}: "puntos" debe ser una lista no vacía.`); return out; }
  let suma = 0;
  c.puntos.forEach((p, k) => {
    if (!p || p.n !== k + 1) return err(`${et}: el punto en la posición ${k + 1} debe tener n = ${k + 1}.`);
    if (!esTexto(p.s) || !NOMBRES_S.includes(p.s)) err(`${et}, punto ${p.n}: "s" debe ser Seleccionar, Ordenar, Limpiar, Estandarizar o Sostener.`);
    if (!esTexto(p.q)) err(`${et}, punto ${p.n}: falta el texto de la pregunta.`);
    else if (p.q.length > 2000) err(`${et}, punto ${p.n}: la pregunta es demasiado larga (máximo 2000 caracteres).`);
    if (!esEntero(p.p) || p.p < 1 || p.p > 100) err(`${et}, punto ${p.n}: el valor debe ser un entero de 1 a 100.`);
    else suma += p.p;
  });
  // escala 0–5 ("escala": 5): todas las preguntas valen 5 y la calificación es el porcentaje sobre el máximo; si no, deben sumar 100
  if (c.escala !== undefined && c.escala !== null && c.escala !== 5) err(`${et}: "escala" solo puede ser 5 (preguntas de 0 a 5) o no ir.`);
  if (c.escala === 5) { if (c.puntos.some((p) => p && p.p !== 5)) err(`${et}: en escala 0–5 todas las preguntas valen 5.`); }
  else if (suma !== 100) err(`${et}: los puntos suman ${suma}, deben sumar exactamente 100.`);
  return out;
}

// Valida la configuración importada. Devuelve { ok, errores[] } con mensajes claros.
function validarConfig(cfg) {
  const errores = [];
  const err = (m) => { if (errores.length < MAX_ERRORES) errores.push(m); };

  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, errores: ['El archivo debe ser un objeto JSON con la configuración.'] };
  }
  if (cfg.schema !== SCHEMA) err(`"schema" debe ser "${SCHEMA}" (se recibió ${JSON.stringify(cfg.schema)}).`);
  if (!esTexto(cfg.nombre)) err('Falta "nombre" (texto).');
  if (Number.isNaN(parseYMD(cfg.inicio))) err('"inicio" debe ser una fecha válida con formato yyyy-mm-dd.');
  if (!esEntero(cfg.dias) || cfg.dias < 1 || cfg.dias > 30) err('"dias" debe ser un entero entre 1 y 30.');

  // ----- checklists -----
  const checklists = new Map();
  if (!Array.isArray(cfg.checklists) || !cfg.checklists.length) {
    err('"checklists" debe ser una lista con al menos un checklist.');
  } else {
    cfg.checklists.forEach((c, i) => {
      const et = `Checklist #${i + 1}${c && c.codigo ? ` (${c.codigo})` : ''}`;
      if (c && esTexto(c.codigo) && checklists.has(c.codigo)) { err(`${et}: código repetido.`); return; }
      if (c && esTexto(c.codigo)) checklists.set(c.codigo, c);
      erroresChecklist(c, et).forEach(err);
    });
  }

  // ----- áreas -----
  const ids = new Set();
  const areas = Array.isArray(cfg.areas) ? cfg.areas : null;
  if (!areas || !areas.length) {
    err('"areas" debe ser una lista con al menos un área.');
  } else {
    areas.forEach((a, i) => {
      const et = `Área #${i + 1}${a && a.id ? ` (${a.id})` : ''}`;
      if (!a || !esTexto(a.id)) return err(`${et}: falta "id".`);
      if (ids.has(a.id)) err(`${et}: id repetido.`);
      ids.add(a.id);
      if (!esTexto(a.nombre)) err(`${et}: falta "nombre".`);
      if (!esTexto(a.checklist) || !checklists.has(a.checklist)) {
        err(`${et}: apunta al checklist "${a.checklist}", que no existe en "checklists".`);
      }
      if (a.subareas !== undefined) {
        if (!Array.isArray(a.subareas)) return err(`${et}: "subareas" debe ser una lista.`);
        const nom = new Set();
        a.subareas.forEach((x, k) => {
          if (!x || !esTexto(x.nombre)) return err(`${et}, subcategoría #${k + 1}: falta "nombre".`);
          if (nom.has(x.nombre.trim().toLowerCase())) err(`${et}: la subcategoría "${x.nombre}" está repetida.`);
          nom.add(x.nombre.trim().toLowerCase());
          if (x.maquinas !== undefined && x.maquinas !== null && typeof x.maquinas !== 'string') err(`${et}, "${x.nombre}": "maquinas" debe ser texto.`);
        });
      }
    });
    if (areas.length > 99) err('Se admiten máximo 99 áreas (el ID de auditoría usa 2 dígitos).');
  }

  // ----- rotación -----
  const n = areas ? areas.length : 0;
  const nombre = (i) => (areas && areas[i] ? `${areas[i].id} ${areas[i].nombre}` : `#${i}`);
  if (!Array.isArray(cfg.rotacion) || !cfg.rotacion.length) {
    err('"rotacion" debe ser una lista con al menos una semana.');
  } else if (n) {
    const parejas = new Map(); // "a>b" -> semana
    cfg.rotacion.forEach((fila, w) => {
      const sem = w + 1;
      if (!Array.isArray(fila) || fila.length !== n) {
        return err(`Rotación, semana ${sem}: debe tener ${n} valores (uno por área) y tiene ${Array.isArray(fila) ? fila.length : 'ninguno'}.`);
      }
      const vistos = new Set();
      let valida = true;
      fila.forEach((v, a) => {
        if (!esEntero(v) || v < 0 || v >= n) {
          valida = false;
          return err(`Rotación, semana ${sem}: el valor ${JSON.stringify(v)} de ${nombre(a)} no es un índice de área válido (0 a ${n - 1}).`);
        }
        if (v === a) err(`Rotación, semana ${sem}: ${nombre(a)} se audita a sí misma.`);
        if (vistos.has(v)) err(`Rotación, semana ${sem}: ${nombre(v)} es auditada por más de un área (debe haber una sola auditora por área).`);
        vistos.add(v);
      });
      if (!valida) return;
      fila.forEach((v, a) => {
        const k = `${a}>${v}`;
        if (parejas.has(k)) {
          err(`Rotación: la pareja ${nombre(a)} → ${nombre(v)} se repite en las semanas ${parejas.get(k)} y ${sem}.`);
        } else parejas.set(k, sem);
      });
    });
  }

  return { ok: errores.length === 0, errores };
}

module.exports = { validarConfig, erroresChecklist, SCHEMA, NOMBRES_S };
