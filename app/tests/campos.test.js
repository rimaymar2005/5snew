'use strict';
// Hallazgo obligatorio (la acción es opcional), fecha fija, tiempo de captura (solo administrador), filtros de periodo y columna Calificación del CSV.
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, respuestas } = require('./helpers');

const S = ['Seleccionar', 'Ordenar', 'Limpiar', 'Estandarizar', 'Sostener'];
process.env.FAKE_NOW = '2026-10-14T10:00:00';

function checklistNuevo(codigo) {
  const puntos = [];
  [4, 5, 4, 4, 3].forEach((cant, i) => { for (let k = 0; k < cant; k++) puntos.push({ s: S[i], q: `Pregunta ${puntos.length + 1}`, p: 5 }); });
  return { codigo, nombre: `Checklist ${codigo}`, formato: 'FMC-15', umbrales: [51, 72, 88, 95], puntos };
}
async function conAreas(n, inicio = '2026-10-12') {
  const e = await iniciar();
  e.admin = (await e.api('POST', '/api/login', { body: { admin: true, password: 'admin-test' } })).json.token;
  e.A = (m, u, b) => e.api(m, u, { token: e.admin, body: b });
  assert.equal((await e.A('POST', '/api/checklists', checklistNuevo('CL-A'))).status, 201);
  assert.equal((await e.A('PUT', '/api/config/inicio', { inicio })).status, 200);
  const r = await e.A('POST', '/api/areas', { areas: Array.from({ length: n }, (_, i) => ({ nombre: `Área ${i + 1}`, checklist: 'CL-A' })) });
  assert.equal(r.status, 201, r.texto);
  e.pines = Object.fromEntries(r.json.areas.map((a) => [a.id, a.pin]));
  e.tokenDe = async (area) => (await e.api('POST', '/api/login', { body: { area, pin: e.pines[area] } })).json.token;
  e.cfg = (await e.A('GET', '/api/config')).json.config;
  return e;
}
const final = (cfg, extra = {}, fn) => ({ estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '1234567', dispositivo: 'd1', respuestas: respuestas(cfg, 'CL-A', fn), ...extra });
const pierde1 = (p) => (p.n === 1 ? 0 : p.p);

test('el hallazgo es obligatorio en todo punto con puntaje menor al máximo; la acción correctiva es opcional', async () => {
  const e = await conAreas(4);
  try {
    const t1 = await e.tokenDe('A-01');
    const put = (body) => e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body });
    const base = final(e.cfg, {}, pierde1);
    const conTodo = (h, a) => ({ ...base, respuestas: base.respuestas.map((r) => (r.n === 1 ? { ...r, hallazgo: h, accion: a } : r)) });

    // sin hallazgo
    let r = await put(conTodo('', ''));
    assert.equal(r.status, 422);
    assert.match(r.json.error, /Falta el hallazgo \(obligatorio\).*: 1\./);
    // la acción sola no basta; los espacios en blanco no cuentan
    assert.equal((await put(conTodo('', 'Limpiar'))).status, 422);
    assert.equal((await put(conTodo('   ', '   '))).status, 422);
    // el borrador sí puede ir incompleto
    assert.equal((await put({ ...conTodo('', ''), estado: 'borrador' })).status, 200);
    // con hallazgo basta: la acción correctiva es opcional
    r = await put(conTodo('Se encontró polvo', ''));
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.respuestas.find((x) => x.n === 1).hallazgo, 'Se encontró polvo');
    assert.equal(r.json.respuestas.find((x) => x.n === 1).accion, '');

    // varios puntos faltantes se listan juntos
    const t2 = await e.tokenDe('A-02');
    const b2 = final(e.cfg, {}, (p) => (p.n === 3 || p.n === 7 ? 0 : p.p));
    b2.respuestas = b2.respuestas.map((x) => ({ n: x.n, puntos: x.puntos }));
    r = await e.api('PUT', '/api/auditorias/S01-A02', { token: t2, body: b2 });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /puntos: 3, 7\./);
    assert.match(r.json.error, /hallazgo/);
    // un punto con puntaje máximo no exige nada
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A02', { token: t2, body: final(e.cfg) })).status, 200);
  } finally { await e.close(); }
});

test('la fecha de la auditoría no se captura: es la del día (o la del día en que se finalizó)', async () => {
  const e = await conAreas(4);
  try {
    const t1 = await e.tokenDe('A-01');
    let r = await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: { estado: 'borrador', fecha: '2020-01-01', respuestas: [] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.fecha, '2026-10-14', 'el borrador toma la fecha del día, no la enviada');
    // finalizada "ayer" sin red: la fecha es la del día en que se terminó
    r = await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: final(e.cfg, { fecha: '1999-12-31', terminado: '2026-10-13T10:00:00' }) });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.fecha, '2026-10-13');
    const t2 = await e.tokenDe('A-02');
    r = await e.api('PUT', '/api/auditorias/S01-A02', { token: t2, body: final(e.cfg, { fecha: '2001-01-01' }) });
    assert.equal(r.json.fecha, '2026-10-14');
  } finally { await e.close(); }
});

test('el tiempo de captura solo lo ve el administrador (ni auditoras, ni auditadas, ni lobby, ni CSV)', async () => {
  const e = await conAreas(4);
  try {
    await e.A('PUT', '/api/lobby/password', { password: 'lobby-1' });
    const tl = (await e.api('POST', '/api/login', { body: { lobby: true, password: 'lobby-1' } })).json.token;
    const t1 = await e.tokenDe('A-01');
    // borrador con 50 s y luego final con 187 s; un valor inválido se ignora
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: { estado: 'borrador', duracion_seg: 50, respuestas: [] } })).status, 200);
    let r = await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: final(e.cfg, { duracion_seg: 187 }) });
    assert.equal(r.status, 200);
    assert.ok(!('duracion_seg' in r.json), 'la respuesta a la auditora no incluye el tiempo');
    const t2 = await e.tokenDe('A-02');
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A02', { token: t2, body: final(e.cfg, { duracion_seg: 'mucho' }) })).status, 200);

    // la auditora, la auditada y cualquier otra área no lo ven en ninguna ruta
    const auditada = e.cfg.areas[e.cfg.rotacion[0][0]].id; // a quien audita A-01
    const rutas = ['/api/auditorias/S01-A01', '/api/auditorias?detalle=1', '/api/auditorias?semana=1', '/api/semana/1', '/api/tablero'];
    for (const quien of ['A-01', auditada, 'A-04']) {
      const tok = await e.tokenDe(quien);
      for (const ruta of rutas) {
        const x = await e.api('GET', ruta, { token: tok });
        // un área ajena no puede abrir el reporte de otras dos
        assert.equal(x.status, quien === 'A-04' && ruta === '/api/auditorias/S01-A01' ? 403 : 200, `${quien} ${ruta}`);
        assert.ok(!/duracion|187/.test(x.texto), `${quien} no debe ver el tiempo en ${ruta}`);
      }
    }
    // lobby y dashboard ejecutivo tampoco
    for (const ruta of ['/api/lobby', '/api/ejecutivo']) assert.ok(!/duracion|187/.test((await e.api('GET', ruta, { token: tl })).texto), ruta);
    assert.equal((await e.api('GET', '/api/admin/tiempos', { token: tl })).status, 403);
    assert.equal((await e.api('GET', '/api/admin/tiempos', { token: t1 })).status, 403);

    // el administrador sí
    assert.equal((await e.A('GET', '/api/auditorias/S01-A01')).json.duracion_seg, 187);
    const ti = (await e.A('GET', '/api/admin/tiempos')).json;
    assert.deepEqual([ti.resumen.auditorias, ti.resumen.con_tiempo, ti.resumen.promedio_seg, ti.resumen.minimo_seg, ti.resumen.maximo_seg], [2, 1, 187, 187, 187]);
    assert.equal(ti.auditorias.find((a) => a.id === 'S01-A01').duracion_seg, 187);
    assert.equal(ti.auditorias.find((a) => a.id === 'S01-A02').duracion_seg, null);
    assert.deepEqual(ti.por_area.map((a) => [a.id, a.promedio_seg]), [['A-01', 187]]);
  } finally { await e.close(); }
});

test('el CSV termina con la columna Calificación', async () => {
  const e = await conAreas(4);
  try {
    const t1 = await e.tokenDe('A-01');
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: final(e.cfg, { duracion_seg: 240 }, pierde1) })).status, 200);
    const bajar = async (token) => {
      const raw = await fetch(`${e.base}/fc/api/export.csv`, { headers: { authorization: `Bearer ${token}` } });
      return Buffer.from(await raw.arrayBuffer()).subarray(3).toString('utf8').trim().split('\r\n');
    };
    const celdas = (l) => l.slice(1, -1).split('","');
    // administrador: incluye el tiempo de captura, y Calificación sigue siendo la última columna
    let lineas = await bajar(e.admin);
    let cab = celdas(lineas[0]);
    assert.deepEqual(cab.slice(-3), ['ID respuesta Forms', 'Tiempo de captura (seg)', 'Calificación']);
    let fila = celdas(lineas[1]);
    assert.equal(fila.length, cab.length);
    assert.equal(fila[fila.length - 1], '95');
    assert.equal(fila[fila.length - 2], '240', 'tiempo de captura en segundos');
    // las áreas no descargan el CSV
    const prohibido = await fetch(`${e.base}/fc/api/export.csv`, { headers: { authorization: `Bearer ${t1}` } });
    assert.equal(prohibido.status, 403);
  } finally { await e.close(); }
});

test('todos los dashboards se pueden filtrar por semana, mes, año o ciclo', async () => {
  process.env.FAKE_NOW = '2027-01-06T10:00:00'; // semana 4 de un ciclo que cruza el año
  const e = await conAreas(6, '2026-12-14');
  try {
    await e.A('PUT', '/api/lobby/password', { password: 'lobby-1' });
    const tl = (await e.api('POST', '/api/login', { body: { lobby: true, password: 'lobby-1' } })).json.token;
    // A-01 hace la semana 1 y A-02 la semana 3
    const t1 = await e.tokenDe('A-01'); const t2 = await e.tokenDe('A-02');
    process.env.FAKE_NOW = '2026-12-16T10:00:00';
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: final(e.cfg) })).status, 200);
    process.env.FAKE_NOW = '2026-12-30T10:00:00';
    const b3 = final(e.cfg, {}, (p) => (p.n === 1 ? 2 : p.p));
    assert.equal((await e.api('PUT', '/api/auditorias/S03-A02', { token: e.admin, body: b3 })).status, 200);
    process.env.FAKE_NOW = '2027-01-06T10:00:00';

    const ej = async (q) => (await e.api('GET', `/api/ejecutivo${q}`, { token: tl })).json;
    // ciclo completo (por omisión): semanas 1 a 4 ya iniciadas
    let d = await ej('');
    assert.deepEqual([d.periodo, d.tendencia.length], ['ciclo', 4]);
    assert.deepEqual(d.opciones.anios, ['2026', '2027']);
    assert.deepEqual(d.opciones.meses, ['2026-12', '2027-01']);
    assert.equal(d.opciones.semanas.length, 5);
    // anual
    d = await ej('?periodo=anio&valor=2026');
    assert.deepEqual(d.tendencia.map((w) => w.iso), [51, 52, 53]);
    assert.equal(d.kpis.completadas, 2);
    d = await ej('?periodo=anio&valor=2027');
    assert.deepEqual(d.tendencia.map((w) => w.iso), [1], 'solo la semana 4 del ciclo (la 5 aún no inicia)');
    assert.equal(d.kpis.completadas, 0);
    assert.equal(d.niveles['5S'] + d.niveles['4S'] + d.niveles['3S'], 0);
    // por omisión del año: el de la semana en curso
    assert.equal((await ej('?periodo=anio')).valor, '2027');
    // mensual
    d = await ej('?periodo=mes&valor=2026-12');
    assert.equal(d.tendencia.length, 3);
    assert.equal((await ej('?periodo=mes')).valor, '2027-01');
    // semanal
    d = await ej('?periodo=semana&valor=3');
    assert.deepEqual([d.tendencia.length, d.kpis.completadas, d.kpis.ya_tocaban], [1, 1, 6]);
    assert.equal(d.por_s.length, 5);
    assert.equal((await ej('?periodo=semana&valor=99')).valor, '4', 'una semana inválida cae en la semana en curso');
    assert.equal((await ej('?periodo=nada')).periodo, 'ciclo');

    // lobby: las columnas siguen el periodo
    const lb = async (q) => (await e.api('GET', `/api/lobby${q}`, { token: tl })).json;
    d = await lb('');
    assert.deepEqual([d.periodo, d.valor, d.columnas.map((c) => c.semana)], ['mes', '2027-01', [4, 5]]);
    assert.deepEqual((await lb('?periodo=anio&valor=2026')).columnas.map((c) => c.semana), [1, 2, 3]);
    assert.deepEqual((await lb('?periodo=semana&valor=2')).columnas.map((c) => c.semana), [2]);
    assert.equal((await lb('?periodo=ciclo')).columnas.length, 5);
    assert.equal((await lb('?periodo=anio')).areas[0].celdas.length, 2);

    // tablero de las áreas (pestaña Acumulado)
    const tb = async (q) => (await e.api('GET', `/api/tablero${q}`, { token: e.admin })).json;
    d = await tb('');
    assert.deepEqual([d.periodo, d.resumen.ya_tocaban], ['ciclo', 24]);
    d = await tb('?periodo=anio&valor=2026');
    assert.equal(d.resumen.ya_tocaban, 18);
    assert.equal(d.resumen.completadas, 2);
    d = await tb('?periodo=semana&valor=1');
    assert.deepEqual([d.resumen.ya_tocaban, d.resumen.completadas], [6, 1]);
    assert.deepEqual((await tb('?periodo=mes&valor=2027-01')).opciones.meses, ['2026-12', '2027-01']);

    // tiempos de captura (administrador)
    const tm = (await e.A('GET', '/api/admin/tiempos?periodo=semana&valor=3')).json;
    assert.equal(tm.resumen.auditorias, 1);
    assert.equal((await e.A('GET', '/api/admin/tiempos?periodo=anio&valor=2027')).json.resumen.auditorias, 0);
  } finally { process.env.FAKE_NOW = '2026-10-14T10:00:00'; await e.close(); }
});

test('una auditoría atrasada se hace antes que las siguientes de la misma área', async () => {
  process.env.FAKE_NOW = '2026-10-21T10:00:00'; // semana 2: la semana 1 ya venció
  const e = await conAreas(4, '2026-10-12');
  try {
    const t1 = await e.tokenDe('A-01');
    let r = await e.api('PUT', '/api/auditorias/S02-A01', { token: t1, body: final(e.cfg) });
    assert.equal(r.status, 422, r.texto);
    assert.match(r.json.error, /atrasada.*semana 1/i);
    // al hacer la atrasada, ya puede hacer la de la semana actual
    r = await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: final(e.cfg) });
    assert.equal(r.status, 200, r.texto);
    r = await e.api('PUT', '/api/auditorias/S02-A01', { token: t1, body: final(e.cfg) });
    assert.equal(r.status, 200, r.texto);
  } finally { await e.close(); }
});

test('el mes se rige por el calendario ISO: la semana pertenece al mes de su jueves y un mes puede tener 5 semanas', async () => {
  process.env.FAKE_NOW = '2026-11-04T10:00:00'; // semana 6
  const e = await conAreas(7, '2026-09-28'); // lunes 28-sep: su jueves (1-oct) cae en octubre
  try {
    await e.A('PUT', '/api/lobby/password', { password: 'lobby-1' });
    const tl = (await e.api('POST', '/api/login', { body: { lobby: true, password: 'lobby-1' } })).json.token;
    const d = (await e.api('GET', '/api/ejecutivo?periodo=mes&valor=2026-10', { token: tl })).json;
    assert.equal(d.tendencia.length, 5);
    assert.deepEqual(d.opciones.meses.slice(0, 2), ['2026-10', '2026-11']);
    const l = (await e.api('GET', '/api/lobby?periodo=mes&valor=2026-10', { token: tl })).json;
    assert.equal(l.columnas.length, 5);
  } finally { await e.close(); }
});
