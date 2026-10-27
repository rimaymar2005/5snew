'use strict';
// Generación de la rotación de auditorías. Reglas: nadie se audita a sí misma, en una semana cada área activa
// recibe una sola auditora (y audita a una sola área), y una pareja auditora→auditada no se repite en el ciclo.
//
// Una "semana" es una lista de parejas [auditora, auditada] con índices de área (posición en la lista completa).

// Rotación desde cero: con m áreas activas, patrón de desplazamiento -> m-1 semanas sin repetir pareja.
function rotacionDesdeCero(activos) {
  const m = activos.length;
  const semanas = [];
  for (let w = 1; w < m; w++) semanas.push(activos.map((aud, k) => [aud, activos[(k + w) % m]]));
  return semanas;
}

// Una semana: asignación perfecta auditoras→auditadas evitando parejas ya usadas (Kuhn con heurística:
// primero las auditoras con menos opciones, y a cada una se le ofrecen primero las auditadas más escasas).
function emparejarSemana(activos, usados) {
  const ok = (a, b) => a !== b && !usados.has(`${a}>${b}`);
  const opciones = new Map(activos.map((a) => [a, activos.filter((b) => ok(a, b))]));
  const demanda = new Map(activos.map((b) => [b, activos.filter((a) => ok(a, b)).length]));
  for (const a of activos) opciones.get(a).sort((x, y) => demanda.get(x) - demanda.get(y) || x - y);
  const orden = [...activos].sort((x, y) => opciones.get(x).length - opciones.get(y).length || x - y);
  const dueno = new Map(); // auditada -> auditora
  const intentar = (a, vistos) => {
    for (const b of opciones.get(a)) {
      if (vistos.has(b)) continue;
      vistos.add(b);
      if (!dueno.has(b) || intentar(dueno.get(b), vistos)) { dueno.set(b, a); return true; }
    }
    return false;
  };
  for (const a of orden) if (!intentar(a, new Set())) return null;
  return activos.map((a) => { for (const [b, aud] of dueno) if (aud === a) return [a, b]; return null; });
}

// Completa las semanas (desde+1 .. hasta) respetando las parejas ya usadas. Se detiene en la primera semana
// imposible; devuelve las semanas logradas.
function completarSemanas(activos, usados, cantidad) {
  const usadas = new Set(usados);
  const semanas = [];
  if (activos.length < 2) return semanas;
  for (let i = 0; i < cantidad; i++) {
    const s = emparejarSemana(activos, usadas);
    if (!s) break;
    s.forEach(([a, b]) => usadas.add(`${a}>${b}`));
    semanas.push(s);
  }
  return semanas;
}

module.exports = { rotacionDesdeCero, completarSemanas, emparejarSemana };
