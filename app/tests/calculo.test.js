'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../server/logic');
const { configReal, respuestas, entornoListo, FIRMA } = require('./helpers');

process.env.FAKE_NOW = '2026-10-14T10:00:00';

test('semana actual, fecha límite e ID', () => {
  assert.deepEqual(L.semanaActual('2026-10-12', '2026-10-11', 35), { estado: 'previo', semana: 0 });
  assert.equal(L.semanaActual('2026-10-12', '2026-10-12', 35).semana, 1);
  assert.equal(L.semanaActual('2026-10-12', '2026-10-18', 35).semana, 1);
  assert.equal(L.semanaActual('2026-10-12', '2026-10-19', 35).semana, 2);
  assert.equal(L.semanaActual('2026-10-12', '2027-06-07', 35).semana, 35); // 34*7 = 238 días -> 2027-06-07
  assert.equal(L.semanaActual('2026-10-12', '2027-06-14', 35).estado, 'terminado');
  assert.equal(L.fechaLimite('2026-10-12', 1, 6), '2026-10-18');
  assert.equal(L.fechaLimite('2026-10-12', 3, 6), '2026-11-01');
  assert.equal(L.auditId(3, 11), 'S03-A12');
});

test('estatus: Programada, Pendiente, Atrasada, Completada', () => {
  const e = (final, sem, hoy) => L.estatus(final, '2026-10-12', 6, sem, hoy);
  assert.equal(e(false, 2, '2026-10-18'), 'Programada');
  assert.equal(e(false, 1, '2026-10-12'), 'Pendiente');
  assert.equal(e(false, 1, '2026-10-18'), 'Pendiente'); // el día límite aún cuenta como en plazo
  assert.equal(e(false, 1, '2026-10-19'), 'Atrasada');
  assert.equal(e(true, 1, '2026-10-30'), 'Completada');
  assert.equal(L.entrega('2026-10-18', '2026-10-18'), 'A tiempo');
  assert.equal(L.entrega('2026-10-19', '2026-10-18'), 'Fuera de tiempo');
});

test('semáforo', () => {
  assert.equal(L.semaforo({ iniciadas: 0, completadas: 0, atrasadas: 0, fuera_de_tiempo: 0 }), 'Sin asignar');
  assert.equal(L.semaforo({ iniciadas: 3, completadas: 2, atrasadas: 1, fuera_de_tiempo: 0 }), 'Rojo');
  assert.equal(L.semaforo({ iniciadas: 3, completadas: 3, atrasadas: 0, fuera_de_tiempo: 0 }), 'Verde');
  assert.equal(L.semaforo({ iniciadas: 3, completadas: 3, atrasadas: 0, fuera_de_tiempo: 1 }), 'Amarillo');
  assert.equal(L.semaforo({ iniciadas: 3, completadas: 2, atrasadas: 0, fuera_de_tiempo: 0 }), 'Amarillo');
});

test('nivel con umbrales distintos (CL-12: 4S desde 89)', () => {
  assert.equal(L.nivel(88, [51, 72, 88, 95]), '4S');
  assert.equal(L.nivel(88, [51, 72, 89, 95]), '3S');
  assert.equal(L.nivel(89, [51, 72, 89, 95]), '4S');
  assert.equal(L.nivel(95, [51, 72, 89, 95]), '5S');
  assert.equal(L.nivel(94.9, [51, 72, 89, 95]), '4S');
  assert.equal(L.nivel(72, [51, 72, 88, 95]), '3S');
  assert.equal(L.nivel(51, [51, 72, 88, 95]), '2S');
  assert.equal(L.nivel(50.9, [51, 72, 88, 95]), '1S');
});

// Cálculo manual contra el servidor
async function finalizar(e, area, id, cl, perdidas) {
  const tok = e.admin; // el orden de atrasadas aplica a las áreas; estos casos prueban solo el cálculo
  // perdidas: { n: puntos obtenidos } ; el resto, máximo
  const r = await e.api('PUT', `/api/auditorias/${id}`, {
    token: tok,
    body: { estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '1234567', dispositivo: 'disp-1',
      respuestas: respuestas(e.cfg, cl, (p) => (perdidas[p.n] !== undefined ? perdidas[p.n] : p.p)) },
  });
  return r;
}

test('CL-12 (20 puntos, umbral 4S = 89): calificación y nivel coinciden con el cálculo manual', async () => {
  const e = await entornoListo(configReal());
  try {
    // S01-A35: A-35 audita a A-36 (CL-12) en la semana 1
    // 20 puntos de 5: se pierden 10 puntos (2 puntos de 5 -> 0) => 90 => 4S
    let r = await finalizar(e, 'A-35', 'S01-A35', 'CL-12', { 1: 0, 2: 0 });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.calificacion, 90);
    assert.equal(r.json.nivel, '4S');
    assert.equal(r.json.total, 100);

    // otra semana: S02-A34 (A-34 audita a A-36 en semana 2), se pierden 15 => 85 => 3S
    r = await finalizar(e, 'A-34', 'S02-A34', 'CL-12', {});
    // la semana 2 aún no inicia en FAKE_NOW (miércoles de la semana 1)
    assert.equal(r.status, 422);
    process.env.FAKE_NOW = '2026-10-20T09:00:00';
    r = await finalizar(e, 'A-34', 'S02-A34', 'CL-12', { 1: 0, 2: 0, 3: 0 });
    assert.equal(r.json.calificacion, 85);
    assert.equal(r.json.nivel, '3S'); // con umbral 88 también sería 3S; lo relevante: 90 es 4S arriba
    process.env.FAKE_NOW = '2026-10-14T10:00:00';
  } finally { await e.close(); }
});

test('CL-05 (22 puntos con valores 1 y 2): calificación y nivel contra cálculo manual', async () => {
  const e = await entornoListo(configReal());
  try {
    // S01-A04: A-04 audita a A-05 (CL-05). Total = 19*5 + 1 + 2 + 2 = 100
    const casos = [
      { perdidas: {}, cal: 100, nivel: '5S' },
      { perdidas: { 19: 0, 21: 0, 22: 0 }, cal: 95, nivel: '5S' }, // pierde 1+2+2 = 5
      { perdidas: { 1: 0, 19: 0 }, cal: 94, nivel: '4S' }, // pierde 5+1 = 6
      { perdidas: { 1: 0, 2: 0, 3: 3 }, cal: 88, nivel: '4S' }, // pierde 5+5+2 = 12
      { perdidas: { 1: 0, 2: 0, 3: 2 }, cal: 87, nivel: '3S' }, // pierde 13
      { perdidas: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i + 1, 0])), cal: 0, nivel: '1S' },
    ];
    // cada caso en una auditoría distinta: A-04 sólo tiene una en la semana 1, así que se usan semanas distintas
    process.env.FAKE_NOW = '2027-06-07T10:00:00'; // semana 35: todas las semanas ya iniciaron
    const cfg = e.cfg;
    // más simple: buscar para cada semana una pareja cuya auditada use CL-05
    let usados = 0;
    for (let w = 1; w <= 35 && usados < casos.length; w++) {
      const a = cfg.rotacion[w - 1].findIndex((t) => cfg.areas[t].checklist === 'CL-05');
      const id = `S${String(w).padStart(2, '0')}-A${String(a + 1).padStart(2, '0')}`;
      const r = await finalizar(e, cfg.areas[a].id, id, 'CL-05', casos[usados].perdidas);
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.calificacion, casos[usados].cal, `caso ${usados}`);
      assert.equal(r.json.nivel, casos[usados].nivel, `caso ${usados}`);
      usados += 1;
    }
    assert.equal(usados, casos.length);
  } finally { process.env.FAKE_NOW = '2026-10-14T10:00:00'; await e.close(); }
});

test('sección del área auditada: rota una por semana, solo entre las activas', () => {
  const L2 = require('../server/logic');
  const area = { subareas: [{ nombre: 'SH1' }, { nombre: 'SH2', activa: false }, { nombre: 'SH3', activa: true }] };
  assert.deepEqual([1, 2, 3, 4].map((w) => L2.seccionDe(area, w).nombre), ['SH1', 'SH3', 'SH1', 'SH3']);
  assert.equal(L2.seccionDe({ subareas: [] }, 1), null);
  assert.equal(L2.seccionDe({}, 5), null);
});
