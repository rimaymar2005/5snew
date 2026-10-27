'use strict';
// Reglas de negocio puras. El frontend replica estas mismas funciones (public/index.html);
// el servidor es la fuente de verdad.

const MS_DIA = 86400000;

const pad2 = (n) => String(n).padStart(2, '0');

function parseYMD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : NaN;
}

const fmtYMD = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (ymd, n) => fmtYMD(parseYMD(ymd) + n * MS_DIA);

// Fecha local (zona horaria del proceso, TZ) en formato yyyy-mm-dd.
function localYMD(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Hora local "yyyy-MM-dd HH:mm".
function localYMDHM(date) {
  return `${localYMD(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// estado: 'previo' (aún no inicia), 'activo', 'terminado' (ya pasó la última semana).
function semanaActual(inicio, hoy, totalSemanas) {
  const d = Math.floor((parseYMD(hoy) - parseYMD(inicio)) / MS_DIA);
  if (d < 0) return { estado: 'previo', semana: 0 };
  const semana = Math.floor(d / 7) + 1;
  if (semana > totalSemanas) return { estado: 'terminado', semana };
  return { estado: 'activo', semana };
}

const inicioSemana = (inicio, semana) => addDays(inicio, (semana - 1) * 7);
const fechaLimite = (inicio, semana, dias) => addDays(inicio, (semana - 1) * 7 + dias);

// Número de semana del año (ISO 8601) de una fecha yyyy-mm-dd
function semanaISO(ymd) {
  const d = new Date(parseYMD(ymd));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // jueves de esa semana
  const primero = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - primero) / MS_DIA - 3 + ((primero.getUTCDay() + 6) % 7)) / 7);
}

const auditId = (semana, idxAuditora) => `S${pad2(semana)}-A${pad2(idxAuditora + 1)}`;

function parseAuditId(id) {
  const m = /^S(\d{2,3})-A(\d{2,3})$/.exec(String(id));
  if (!m) return null;
  return { semana: +m[1], idx: +m[2] - 1 };
}

// Completada | Atrasada | Pendiente | Programada
function estatus(final, inicio, dias, semana, hoy) {
  if (final) return 'Completada';
  if (hoy < inicioSemana(inicio, semana)) return 'Programada';
  if (hoy > fechaLimite(inicio, semana, dias)) return 'Atrasada';
  return 'Pendiente';
}

const entrega = (terminadoYMD, limite) => (terminadoYMD <= limite ? 'A tiempo' : 'Fuera de tiempo');

const redondear1 = (x) => Math.round(x * 10) / 10;

function calificacion(obtenidos, posibles) {
  return posibles > 0 ? redondear1((obtenidos / posibles) * 100) : 0;
}

// umbrales = [u2, u3, u4, u5]
function nivel(cal, umbrales) {
  if (cal >= umbrales[3]) return '5S';
  if (cal >= umbrales[2]) return '4S';
  if (cal >= umbrales[1]) return '3S';
  if (cal >= umbrales[0]) return '2S';
  return '1S';
}

// stats: { iniciadas, completadas, atrasadas, fuera_de_tiempo }
function semaforo(s) {
  if (!s.iniciadas) return 'Sin asignar';
  if (s.atrasadas > 0) return 'Rojo';
  if (s.completadas === s.iniciadas && s.fuera_de_tiempo === 0) return 'Verde';
  return 'Amarillo';
}

// Sección (subcategoría) del área auditada que toca en una semana: las activas rotan una por semana, en orden.
// Sin subcategorías activas devuelve null (se audita el área completa).
function seccionDe(area, semana) {
  const act = ((area && area.subareas) || []).filter((s) => s.activa !== false);
  return act.length ? act[(semana - 1) % act.length] : null;
}

// Máquinas de una sección: una por línea (los datos viejos separados por comas también se aceptan), sin vacías ni repetidas.
function listaMaquinas(texto) {
  let xs = String(texto || '').split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean);
  if (xs.length === 1 && xs[0].includes(',')) xs = xs[0].split(',').map((x) => x.trim()).filter(Boolean);
  return [...new Set(xs)];
}

module.exports = {
  listaMaquinas, seccionDe, pad2, parseYMD, fmtYMD, addDays, localYMD, localYMDHM, semanaActual, inicioSemana, fechaLimite,
  auditId, parseAuditId, semanaISO, estatus, entrega, calificacion, nivel, semaforo, redondear1,
};
