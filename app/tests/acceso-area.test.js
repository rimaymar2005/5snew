'use strict';
// Cada área solo ve sus métricas y sus reportes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { configReal, respuestas, entornoListo, FIRMA } = require('./helpers');

process.env.FAKE_NOW = '2026-10-14T10:00:00'; // miércoles de la semana 1

function cuerpoFinal(cfg, auditada, extra = {}) {
  const a = cfg.areas.find((x) => x.id === auditada);
  return {
    estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '123456', firma: FIRMA,
    fecha: '2026-10-14', terminado: '2026-10-14T09:00:00', creado: '2026-10-14T08:00:00', dispositivo: 'dev-1',
    respuestas: respuestas(cfg, a.checklist), ...extra,
  };
}

test('un área solo ve sus métricas y sus reportes', async () => {
  const e = await entornoListo(configReal());
  try {
    const cfg = e.cfg;
    // semana 1: A-n audita al área (n+1); A-01 audita a A-02, A-02 a A-03, A-03 a A-04...
    const t1 = await e.tokenDe('A-01');
    const t2 = await e.tokenDe('A-02');
    const t3 = await e.tokenDe('A-03');
    const t4 = await e.tokenDe('A-04');
    const aud1 = cfg.areas[cfg.rotacion[0][0]].id; // a quien audita A-01
    const aud2 = cfg.areas[cfg.rotacion[0][1]].id;
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpoFinal(cfg, aud1) })).status, 200);
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A02', { token: t2, body: cuerpoFinal(cfg, aud2) })).status, 200);

    // tablero acumulado: solo su fila como auditora y como auditada
    const tab = (await e.api('GET', '/api/tablero', { token: t1 })).json;
    assert.deepEqual(tab.auditoras.map((x) => x.area), ['A-01']);
    assert.deepEqual(tab.auditadas.map((x) => x.area), ['A-01']);
    assert.equal(tab.resumen.completadas, 1);
    // el administrador ve toda la planta
    const tabAdmin = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tabAdmin.auditoras.length, 36);
    assert.equal(tabAdmin.resumen.completadas, 2);

    // una auditada ve la calificación que recibió, y solo la suya
    const tabRec = (await e.api('GET', '/api/tablero', { token: await e.tokenDe(aud1) })).json;
    assert.equal(tabRec.auditadas.length, 1);
    assert.equal(tabRec.auditadas[0].recibidas, 1);
    assert.equal(tabRec.resumen.calificacion_promedio, tabRec.auditadas[0].promedio);

    // semana: solo las asignaciones donde participa
    const sem = (await e.api('GET', '/api/semana/1', { token: t1 })).json;
    assert.ok(sem.asignaciones.length >= 1 && sem.asignaciones.every((x) => x.auditora === 'A-01' || x.auditada === 'A-01'));
    assert.equal((await e.api('GET', '/api/semana/1', { token: e.admin })).json.asignaciones.length, 36);

    // reportes: el que hace, el que recibe finalizado; ningún otro
    assert.equal((await e.api('GET', '/api/auditorias/S01-A01', { token: t1 })).status, 200);
    assert.equal((await e.api('GET', '/api/auditorias/S01-A01', { token: await e.tokenDe(aud1) })).status, 200);
    assert.equal((await e.api('GET', '/api/auditorias/S01-A01', { token: t4 })).status, 403);
    assert.equal((await e.api('GET', '/api/auditorias/S01-A02', { token: t1 })).status, 403);
    assert.equal((await e.api('GET', '/api/auditorias/S01-A01', { token: e.admin })).status, 200);

    // el listado se limita a lo suyo aunque pida otra área
    const lista = (await e.api('GET', '/api/auditorias?area=A-02', { token: t1 })).json;
    assert.ok(lista.every((x) => x.auditora === 'A-01' || x.auditada === 'A-01'));
    assert.equal((await e.api('GET', '/api/auditorias', { token: t3 })).json.every((x) => x.auditora === 'A-03' || x.auditada === 'A-03'), true);
    assert.equal((await e.api('GET', '/api/auditorias', { token: e.admin })).json.length, 2);

    // un borrador de la auditora no lo ve la auditada
    const borrador = { estado: 'borrador', persona_audita: 'Ana', respuestas: [] };
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A03', { token: t3, body: borrador })).status, 200);
    const destino = cfg.areas[cfg.rotacion[0][2]].id;
    assert.equal((await e.api('GET', '/api/auditorias/S01-A03', { token: await e.tokenDe(destino) })).status, 403);

    // sin CSV para las áreas
    assert.equal((await e.api('GET', '/api/export.csv', { token: t1 })).status, 403);
    assert.equal((await e.api('GET', '/api/export.csv', { token: e.admin })).status, 200);
  } finally { await e.close(); }
});

test('máquina de la sección: lista obligatoria al finalizar, solo opciones válidas y sale en el CSV', async () => {
  const e = await entornoListo(configReal());
  try {
    const cfg = e.cfg;
    const t1 = await e.tokenDe('A-01');
    const aud = cfg.areas[cfg.rotacion[0][0]].id; // a quien audita A-01 en la semana 1
    // con coma o salto de línea, la lista queda normalizada (una por línea, sin repetidas)
    const g = await e.api('PUT', `/api/areas/${aud}/subareas`, { token: e.admin, body: { subareas: [{ nombre: 'S1', maquinas: 'T-1, T-2, T-1' }, { nombre: 'S2' }] } });
    assert.equal(g.status, 200, g.texto);
    assert.equal(g.json.subareas[0].maquinas, 'T-1\nT-2');
    const cuerpo = (extra) => ({
      estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '123456', firma: FIRMA,
      fecha: '2026-10-14', terminado: '2026-10-14T09:00:00', creado: '2026-10-14T08:00:00', dispositivo: 'dev-1',
      respuestas: respuestas(cfg, cfg.areas.find((x) => x.id === aud).checklist), ...extra,
    });
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpo({}) })).status, 422); // falta la máquina
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpo({ maquina: 'X-9' }) })).status, 422); // no está en la lista
    const ok = await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpo({ maquina: 'T-2' }) });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.subarea, 'S1');
    assert.equal(ok.json.maquina, 'T-2');
    const csv = (await e.api('GET', '/api/export.csv', { token: e.admin })).texto;
    assert.ok(csv.includes('"S1","T-2"'));
  } finally { await e.close(); }
});
