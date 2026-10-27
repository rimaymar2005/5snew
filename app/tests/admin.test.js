'use strict';
// Administración dentro de la app: todo se da de alta desde la interfaz/API, sin importar archivos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, respuestas, FIRMA } = require('./helpers');
const { validarConfig } = require('../server/configImport');
const { rotacionDesdeCero, completarSemanas } = require('../server/rotacion');

const S = ['Seleccionar', 'Ordenar', 'Limpiar', 'Estandarizar', 'Sostener'];
const MIERCOLES_S1 = '2026-10-14T10:00:00';
process.env.FAKE_NOW = MIERCOLES_S1;

// checklist de 20 puntos de 5 (4/5/4/4/3)
function checklistNuevo(codigo, nombre = `Checklist ${codigo}`) {
  const puntos = [];
  [4, 5, 4, 4, 3].forEach((cant, i) => { for (let k = 0; k < cant; k++) puntos.push({ s: S[i], q: `Pregunta ${puntos.length + 1} ${codigo}`, p: 5 }); });
  return { codigo, nombre, formato: 'FMC-15', umbrales: [51, 72, 88, 95], puntos };
}

async function instalacionNueva() {
  const e = await iniciar();
  e.admin = (await e.api('POST', '/api/login', { body: { admin: true, password: 'admin-test' } })).json.token;
  e.A = (m, u, b) => e.api(m, u, { token: e.admin, body: b });
  return e;
}
async function conAreas(n, { inicio = '2026-10-12' } = {}) {
  const e = await instalacionNueva();
  assert.equal((await e.A('POST', '/api/checklists', checklistNuevo('CL-A'))).status, 201);
  assert.equal((await e.A('PUT', '/api/config/inicio', { inicio })).status, 200);
  const r = await e.A('POST', '/api/areas', { areas: Array.from({ length: n }, (_, i) => ({ nombre: `Área ${i + 1}`, checklist: 'CL-A' })) });
  assert.equal(r.status, 201, r.texto);
  e.pines = Object.fromEntries(r.json.areas.map((a) => [a.id, a.pin]));
  e.tokenDe = async (area) => (await e.api('POST', '/api/login', { body: { area, pin: e.pines[area] } })).json.token;
  return e;
}
const cuerpoFinal = (cfg, cl, extra = {}) => ({ estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '1234567', dispositivo: 'd1', respuestas: respuestas(cfg, cl), ...extra });

function paresDe(rotacion, hasta = rotacion.length) {
  const pares = [];
  for (let w = 0; w < hasta; w++) rotacion[w].forEach((b, a) => { if (b !== null && b !== undefined) pares.push(`${a}>${b}`); });
  return pares;
}

test('algoritmo de rotación: desde cero (36 áreas = 35 semanas) y completar semanas sin repetir parejas', () => {
  const activos = Array.from({ length: 36 }, (_, i) => i);
  const sem = rotacionDesdeCero(activos);
  assert.equal(sem.length, 35);
  const vistos = new Set();
  for (const s of sem) {
    assert.equal(new Set(s.map(([, b]) => b)).size, 36, 'una sola auditora por área');
    for (const [a, b] of s) { assert.notEqual(a, b); assert.ok(!vistos.has(`${a}>${b}`), 'pareja repetida'); vistos.add(`${a}>${b}`); }
  }
  // con un área nueva y 10 semanas ya usadas
  const usados = new Set(sem.slice(0, 10).flat().map(([a, b]) => `${a}>${b}`));
  const futuras = completarSemanas([...activos, 36], usados, 25);
  assert.equal(futuras.length, 25);
  for (const s of futuras) {
    assert.equal(new Set(s.map(([, b]) => b)).size, 37);
    for (const [a, b] of s) { assert.notEqual(a, b); assert.ok(!usados.has(`${a}>${b}`)); usados.add(`${a}>${b}`); }
  }
});

test('instalación nueva: arranca vacía y todo se da de alta desde la app (sin importar archivos)', async () => {
  const e = await instalacionNueva();
  try {
    let r = await e.api('GET', '/api/areas');
    assert.equal(r.json.configurada, false);
    assert.equal(r.json.areas.length, 0);
    // el panel de administración funciona vacío
    r = await e.A('GET', '/api/admin/resumen');
    assert.equal(r.status, 200);
    assert.equal(r.json.areas.length, 0);
    assert.equal(r.json.rotacion.semanas, 0);

    assert.equal((await e.A('POST', '/api/checklists', checklistNuevo('CL-A'))).status, 201);
    assert.equal((await e.A('POST', '/api/checklists', checklistNuevo('CL-B'))).status, 201);
    assert.equal((await e.A('PUT', '/api/config/inicio', { inicio: '2026-10-12' })).status, 200);
    r = await e.A('POST', '/api/areas', { areas: [
      { nombre: 'Almacén', checklist: 'CL-A' }, { nombre: 'Línea 1', checklist: 'CL-B' }, { nombre: 'Oficinas', checklist: 'CL-B' }, { nombre: 'Calidad', checklist: 'CL-B' },
    ] });
    assert.equal(r.status, 201, r.texto);
    assert.deepEqual(r.json.areas.map((a) => a.id), ['A-01', 'A-02', 'A-03', 'A-04']);
    assert.ok(r.json.areas.every((a) => /^\d{4}$/.test(a.pin)));
    assert.equal(r.json.rotacion.semanas, 3);

    // la configuración generada cumple todas las reglas del importador
    const cfg = (await e.A('GET', '/api/config')).json.config;
    const v = validarConfig({ ...cfg, areas: cfg.areas.map(({ id, nombre, checklist }) => ({ id, nombre, checklist })) });
    assert.deepEqual(v.errores, []);

    // con el PIN generado ya se puede auditar
    const pin = r.json.areas[0].pin;
    const login = await e.api('POST', '/api/login', { body: { area: 'A-01', pin } });
    assert.equal(login.status, 200);
    const sem = (await e.api('GET', '/api/semana/1', { token: login.json.token })).json;
    const mia = sem.asignaciones.find((a) => a.auditora === 'A-01');
    const idx = Number(mia.id.slice(-2)) - 1;
    assert.equal(idx, 0);
    const checklist = cfg.areas.find((a) => a.id === mia.auditada).checklist;
    const put = await e.api('PUT', `/api/auditorias/${mia.id}`, { token: login.json.token, body: cuerpoFinal(cfg, checklist) });
    assert.equal(put.status, 200, put.texto);
    assert.equal(put.json.calificacion, 100);
  } finally { await e.close(); }
});

test('áreas: validaciones, nombres únicos, edición y desactivación', async () => {
  const e = await conAreas(4);
  try {
    assert.equal((await e.A('POST', '/api/areas', { areas: [] })).status, 422);
    let r = await e.A('POST', '/api/areas', { areas: [{ nombre: 'área 1', checklist: 'CL-A' }] });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /Ya existe un área/);
    r = await e.A('POST', '/api/areas', { areas: [{ nombre: 'Nueva', checklist: 'NO-EXISTE' }] });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /no existe/);
    // solo admin
    const t1 = await e.tokenDe('A-01');
    assert.equal((await e.api('POST', '/api/areas', { token: t1, body: { areas: [{ nombre: 'X', checklist: 'CL-A' }] } })).status, 403);
    assert.equal((await e.api('PUT', '/api/areas/A-02', { token: t1, body: { nombre: 'X' } })).status, 403);

    // renombrar
    assert.equal((await e.A('PUT', '/api/areas/A-02', { nombre: 'Línea Uno' })).status, 200);
    assert.equal((await e.A('PUT', '/api/areas/A-02', { nombre: 'Área 3' })).status, 422);
    assert.equal((await e.A('PUT', '/api/areas/A-99', { nombre: 'Z' })).status, 404);

    // desactivar: no entra, su sesión cae, desaparece de la lista de acceso y sus semanas futuras se rehacen
    const t4 = await e.tokenDe('A-04');
    assert.equal((await e.api('GET', '/api/tablero', { token: t4 })).status, 200);
    r = await e.A('PUT', '/api/areas/A-04', { activa: false });
    assert.equal(r.status, 200);
    assert.equal((await e.api('GET', '/api/tablero', { token: t4 })).status, 401);
    const l = await e.api('POST', '/api/login', { body: { area: 'A-04', pin: e.pines['A-04'] } });
    assert.equal(l.status, 403);
    assert.match(l.json.error, /desactivada/);
    assert.equal((await e.api('GET', '/api/areas')).json.areas.length, 3);
    const cfg = (await e.A('GET', '/api/config')).json.config;
    assert.ok(cfg.rotacion.length >= 2 && cfg.rotacion.length <= 3);
    // la semana 1 (en curso) se conserva; de la semana 2 en adelante el área inactiva ya no participa
    assert.ok(cfg.rotacion.slice(1).every((fila) => fila[3] === null), 'el área inactiva no tiene asignación futura');
    assert.ok(cfg.rotacion.slice(1).every((fila) => !fila.includes(3)), 'nadie la audita');
    assert.notEqual(cfg.rotacion[0][3], null, 'la semana en curso no se toca');
    // reactivar la devuelve a la rotación
    assert.equal((await e.A('PUT', '/api/areas/A-04', { activa: true })).status, 200);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-04', pin: e.pines['A-04'] } })).status, 200);
    assert.ok((await e.A('GET', '/api/config')).json.config.rotacion.length >= 2);
  } finally { await e.close(); }
});

test('agregar un área con el ciclo en curso: las semanas iniciadas se conservan y las futuras se rehacen sin repetir parejas', async () => {
  process.env.FAKE_NOW = '2026-10-21T09:00:00'; // semana 2
  const e = await conAreas(6);
  try {
    const antes = (await e.A('GET', '/api/config')).json.config;
    assert.equal(antes.rotacion.length, 5);
    // una auditoría ya capturada en la semana 1
    const t1 = await e.tokenDe('A-01');
    const tgt = antes.areas[antes.rotacion[0][0]];
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpoFinal(antes, tgt.checklist) })).status, 200);

    const r = await e.A('POST', '/api/areas', { areas: [{ nombre: 'Área Nueva', checklist: 'CL-A' }] });
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.areas[0].id, 'A-07');
    assert.equal(r.json.rotacion.congeladas, 2);
    const despues = (await e.A('GET', '/api/config')).json.config;
    assert.ok(despues.rotacion.length >= 5 && despues.rotacion.length <= 6, 'el ciclo no se acorta (con 7 áreas puede llegar a 6 semanas)');
    // semanas 1 y 2 intactas (el área nueva no tiene asignación en ellas)
    for (let w = 0; w < 2; w++) {
      antes.rotacion[w].forEach((b, a) => assert.equal(despues.rotacion[w][a], b, `semana ${w + 1} área ${a}`));
      assert.equal(despues.rotacion[w][6], null);
      assert.ok(!despues.rotacion[w].includes(6));
    }
    // semanas futuras: cada una es permutación de las 7 áreas, sin auto-auditorías y sin repetir parejas en todo el ciclo
    const todas = paresDe(despues.rotacion);
    assert.equal(new Set(todas).size, todas.length, 'ninguna pareja se repite');
    for (let w = 2; w < despues.rotacion.length; w++) {
      const fila = despues.rotacion[w];
      assert.equal(new Set(fila).size, 7);
      fila.forEach((b, a) => assert.notEqual(a, b));
    }
    // el área nueva ya puede auditar en la semana 3 y su auditoría de la semana 1 sigue en pie
    assert.equal((await e.api('GET', '/api/auditorias/S01-A01', { token: t1 })).json.estado, 'final');
    // y el tablero no se rompe con áreas sin asignación en semanas pasadas
    const tb = await e.api('GET', '/api/tablero', { token: e.admin });
    assert.equal(tb.status, 200);
    assert.equal(tb.json.auditoras.find((a) => a.area === 'A-07').asignadas, 0);
    const s1 = (await e.api('GET', '/api/semana/1', { token: e.admin })).json;
    assert.equal(s1.asignaciones.length, 6);
  } finally { process.env.FAKE_NOW = MIERCOLES_S1; await e.close(); }
});

test('rotación: rehacer toda solo si no hay auditorías; recalcular lo futuro siempre', async () => {
  const e = await conAreas(5);
  try {
    let r = await e.A('POST', '/api/rotacion/regenerar', { completa: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.semanas, 4);
    const t1 = await e.tokenDe('A-01');
    const cfg = (await e.A('GET', '/api/config')).json.config;
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpoFinal(cfg, 'CL-A') })).status, 200);
    r = await e.A('POST', '/api/rotacion/regenerar', { completa: true });
    assert.equal(r.status, 409);
    r = await e.A('POST', '/api/rotacion/regenerar', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.congeladas, 1);
    assert.equal(r.json.semanas, 4);
  } finally { await e.close(); }
});

test('checklists y preguntas: crear, validar, editar, duplicar, bloquear lo que ya se usó y eliminar', async () => {
  const e = await conAreas(4);
  try {
    // validaciones
    let r = await e.A('POST', '/api/checklists', { ...checklistNuevo('CL-X'), puntos: checklistNuevo('CL-X').puntos.slice(1) });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /suman 95/);
    r = await e.A('POST', '/api/checklists', checklistNuevo('CL-A'));
    assert.equal(r.status, 422);
    assert.match(r.json.error, /Ya existe/);
    r = await e.A('POST', '/api/checklists', { ...checklistNuevo('CL-Y'), umbrales: [90, 80, 70, 60] });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /umbrales/);
    r = await e.A('POST', '/api/checklists', { ...checklistNuevo('mal código!') });
    assert.equal(r.status, 422);

    // preguntas fuera de orden se agrupan por S y se renumeran
    const desorden = checklistNuevo('CL-Z');
    desorden.puntos.reverse();
    assert.equal((await e.A('POST', '/api/checklists', desorden)).status, 201);
    let res = (await e.A('GET', '/api/admin/resumen')).json;
    const z = res.checklists.find((c) => c.codigo === 'CL-Z');
    assert.equal(z.puntos[0].s, 'Seleccionar');
    assert.deepEqual(z.puntos.map((p) => p.n), z.puntos.map((_, i) => i + 1));
    assert.equal(z.total, 100);

    // agregar una pregunta (rebalanceando) en un checklist sin uso
    const ed = JSON.parse(JSON.stringify(z));
    ed.puntos.find((p) => p.s === 'Sostener').p = 0.5; // inválido
    assert.equal((await e.A('PUT', '/api/checklists/CL-Z', ed)).status, 422);
    const ed2 = JSON.parse(JSON.stringify(z));
    ed2.puntos.pop();
    ed2.puntos.push({ s: 'Sostener', q: 'Nueva pregunta A', p: 3 }, { s: 'Sostener', q: 'Nueva pregunta B', p: 2 });
    r = await e.A('PUT', '/api/checklists/CL-Z', ed2);
    assert.equal(r.status, 200, r.texto);
    res = (await e.A('GET', '/api/admin/resumen')).json;
    assert.equal(res.checklists.find((c) => c.codigo === 'CL-Z').puntos.length, 21);

    // duplicar
    r = await e.A('POST', '/api/checklists/CL-A/duplicar', { codigo: 'CL-A2', nombre: 'Copia' });
    assert.equal(r.status, 201);
    assert.equal((await e.A('POST', '/api/checklists/CL-A/duplicar', { codigo: 'CL-A2' })).status, 422);

    // eliminar: no si lo usan áreas; sí si está libre
    r = await e.A('DELETE', '/api/checklists/CL-A');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /lo usan 4 área/);
    assert.equal((await e.A('DELETE', '/api/checklists/CL-Z')).status, 200);

    // cambiar el checklist de un área
    assert.equal((await e.A('PUT', '/api/areas/A-02', { checklist: 'CL-A2' })).status, 200);

    // uso real: una auditoría finalizada sobre CL-A bloquea cambios de estructura, pero no de texto
    const t1 = await e.tokenDe('A-01');
    const cfg = (await e.A('GET', '/api/config')).json.config;
    const audit = (await e.api('GET', '/api/semana/1', { token: t1 })).json.asignaciones.find((a) => a.auditora === 'A-01');
    const checklist = cfg.areas.find((a) => a.id === audit.auditada).checklist;
    assert.equal((await e.api('PUT', `/api/auditorias/${audit.id}`, { token: t1, body: cuerpoFinal(cfg, checklist) })).status, 200);
    res = (await e.A('GET', '/api/admin/resumen')).json;
    const usado = res.checklists.find((c) => c.codigo === checklist);
    assert.equal(usado.auditorias, 1);

    const textoNuevo = JSON.parse(JSON.stringify(usado));
    textoNuevo.puntos[0].q = 'Texto corregido sin cambiar el valor';
    textoNuevo.nombre = 'Nombre corregido';
    assert.equal((await e.A('PUT', `/api/checklists/${checklist}`, textoNuevo)).status, 200, 'texto y nombre sí se pueden');

    const estructura = JSON.parse(JSON.stringify(usado));
    estructura.puntos[0].p = 4; estructura.puntos[1].p = 6;
    r = await e.A('PUT', `/api/checklists/${checklist}`, estructura);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /ya se usó/);
    const umbral = JSON.parse(JSON.stringify(usado));
    umbral.umbrales = [50, 72, 88, 95];
    assert.equal((await e.A('PUT', `/api/checklists/${checklist}`, umbral)).status, 409);
    const masUna = JSON.parse(JSON.stringify(usado));
    masUna.puntos.pop(); masUna.puntos.push({ n: 20, s: 'Sostener', q: 'x', p: 2 }, { n: 21, s: 'Sostener', q: 'y', p: 3 });
    assert.equal((await e.A('PUT', `/api/checklists/${checklist}`, masUna)).status, 409);
    assert.equal((await e.A('DELETE', `/api/checklists/${checklist}`)).status, 409);
  } finally { await e.close(); }
});

test('parámetros del ciclo y cambio de PIN por el administrador', async () => {
  const e = await conAreas(4);
  try {
    assert.equal((await e.A('PUT', '/api/parametros', { dias: 0 })).status, 422);
    assert.equal((await e.A('PUT', '/api/parametros', { dias: 'x' })).status, 422);
    assert.equal((await e.A('PUT', '/api/parametros', { nombre: '  ' })).status, 422);
    const r = await e.A('PUT', '/api/parametros', { nombre: 'Auditorías Planta 1', dias: 5 });
    assert.equal(r.status, 200);
    const cfg = (await e.A('GET', '/api/config')).json.config;
    assert.equal(cfg.nombre, 'Auditorías Planta 1');
    assert.equal(cfg.dias, 5);
    const t = await e.tokenDe('A-03');
    assert.equal((await e.api('PUT', '/api/parametros', { token: t, body: { dias: 3 } })).status, 403);

    // el administrador cambia la contraseña (PIN) de un área: la anterior deja de servir y la sesión abierta cae
    assert.equal((await e.A('PUT', '/api/usuarios/A-03/pin', { pin: '98765' })).status, 200);
    assert.equal((await e.api('GET', '/api/tablero', { token: t })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-03', pin: e.pines['A-03'] } })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-03', pin: '98765' } })).status, 200);
  } finally { await e.close(); }
});

test('usuario lobby: solo ve el dashboard de semáforos (y el administrador controla su contraseña)', async () => {
  const e = await conAreas(4);
  try {
    // sin contraseña no puede entrar
    let r = await e.api('POST', '/api/login', { body: { lobby: true, password: 'x' } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /aún no tiene contraseña/);
    // solo el admin la establece; con reglas mínimas
    assert.equal((await e.api('PUT', '/api/lobby/password', { token: await e.tokenDe('A-01'), body: { password: 'lobby-1' } })).status, 403);
    assert.equal((await e.A('PUT', '/api/lobby/password', { password: 'abc' })).status, 422);
    assert.equal((await e.A('GET', '/api/admin/resumen')).json.lobby.configurado, false);
    assert.equal((await e.A('PUT', '/api/lobby/password', { password: 'lobby-1' })).status, 200);
    assert.equal((await e.A('GET', '/api/admin/resumen')).json.lobby.configurado, true);
    assert.equal((await e.api('POST', '/api/login', { body: { lobby: true, password: 'mala' } })).status, 401);
    r = await e.api('POST', '/api/login', { body: { lobby: true, password: 'lobby-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.rol, 'lobby');
    const tl = r.json.token;

    // el usuario lobby SOLO puede ver el dashboard
    assert.equal((await e.api('GET', '/api/lobby', { token: tl })).status, 200);
    const prohibidas = [['GET', '/api/tablero'], ['GET', '/api/config'], ['GET', '/api/semana/1'], ['GET', '/api/auditorias'], ['GET', '/api/export.csv'],
      ['GET', '/api/usuarios'], ['GET', '/api/admin/resumen'], ['PUT', '/api/auditorias/S01-A01', { estado: 'borrador' }], ['POST', '/api/areas', { areas: [{ nombre: 'X', checklist: 'CL-A' }] }]];
    for (const [m, u, b] of prohibidas) {
      const x = await e.api(m, u, { token: tl, body: b });
      assert.equal(x.status, 403, `${m} ${u} debe estar prohibido para lobby (fue ${x.status})`);
    }
    // un área no entra al dashboard de lobby; el admin sí
    assert.equal((await e.api('GET', '/api/lobby', { token: await e.tokenDe('A-01') })).status, 403);
    assert.equal((await e.api('GET', '/api/lobby', { token: e.admin })).status, 200);
    assert.equal((await e.api('GET', '/api/lobby')).status, 401);

    // semáforo: semana 1 en curso, nadie ha hecho nada -> todas Amarillo (pendientes en plazo)
    let d = (await e.api('GET', '/api/lobby', { token: tl })).json;
    assert.equal(d.semana, 1);
    assert.equal(d.areas.length, 4);
    assert.ok(d.areas.every((a) => a.luz === 'Amarillo' && a.esta_semana === 'Pendiente'));
    assert.deepEqual(d.resumen, { total: 4, hechas: 0, pendientes: 4, atrasadas: 0 });
    // matriz del mes: columnas = semanas del año (ISO) cuyo lunes cae en el mes; una celda por área y semana
    assert.deepEqual(d.opciones.meses, ['2026-10']);
    assert.deepEqual([d.periodo, d.valor], ['mes', '2026-10']);
    assert.deepEqual(d.columnas.map((c) => [c.semana, c.iso, c.inicio, c.actual]), [[1, 42, '2026-10-12', true], [2, 43, '2026-10-19', false], [3, 44, '2026-10-26', false]]);
    assert.deepEqual(d.areas.find((a) => a.id === 'A-02').celdas.map((c) => c.e), ['Pendiente', 'Programada', 'Programada']);
    assert.equal((await e.api('GET', '/api/lobby?periodo=mes&valor=2030-01', { token: tl })).json.valor, '2026-10', 'un mes inválido se ignora');
    // A-01 hace su auditoría -> Verde
    const cfg = (await e.A('GET', '/api/config')).json.config;
    const t1 = await e.tokenDe('A-01');
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpoFinal(cfg, 'CL-A') })).status, 200);
    d = (await e.api('GET', '/api/lobby', { token: tl })).json;
    assert.equal(d.areas.find((a) => a.id === 'A-01').luz, 'Verde');
    assert.equal(d.resumen.hechas, 1);
    assert.equal(d.areas.find((a) => a.id === 'A-01').celdas[0].e, 'Completada');
    // no se filtran calificaciones ni nombres de personas
    assert.ok(!/persona|Ana|Luis|firma|duracion|nomina/.test(JSON.stringify(d)), 'el lobby no recibe nombres de personas, firmas, nóminas ni tiempos');
    // pero sí la calificación que recibió cada área como auditada
    const mia = d.areas.find((a) => a.id === 'A-01');
    assert.equal(mia.celdas[0].e, 'Completada');
    const objetivo = cfg.areas[cfg.rotacion[0][0]].id; // A-01 audita a esta área
    const recibe = d.areas.find((a) => a.id === objetivo);
    assert.deepEqual([recibe.celdas[0].recibida.calificacion, recibe.celdas[0].recibida.nivel], [100, '5S']);
    assert.deepEqual([recibe.recibido.promedio, recibe.recibido.nivel, recibe.recibido.n], [100, '5S', 1]);
    assert.equal(d.areas.find((a) => a.id === 'A-01').celdas[0].recibida, null, 'quien nadie ha auditado aún no tiene calificación');

    // semana 2: las que no hicieron la 1 quedan en Rojo; A-01 queda pendiente de la 2
    process.env.FAKE_NOW = '2026-10-21T09:00:00';
    d = (await e.api('GET', '/api/lobby', { token: tl })).json;
    assert.equal(d.semana, 2);
    const luz = Object.fromEntries(d.areas.map((a) => [a.id, a.luz]));
    assert.deepEqual(luz, { 'A-01': 'Amarillo', 'A-02': 'Rojo', 'A-03': 'Rojo', 'A-04': 'Rojo' });
    assert.equal(d.areas.find((a) => a.id === 'A-02').atrasadas, 1);
    assert.deepEqual(d.areas.find((a) => a.id === 'A-02').celdas.map((c) => c.e), ['Atrasada', 'Pendiente', 'Programada']);
    assert.deepEqual(d.areas.find((a) => a.id === 'A-01').celdas.map((c) => c.e), ['Completada', 'Pendiente', 'Programada']);
    assert.equal(d.resumen.atrasadas, 3);
    process.env.FAKE_NOW = MIERCOLES_S1;

    // un área desactivada no aparece
    assert.equal((await e.A('PUT', '/api/areas/A-04', { activa: false })).status, 200);
    assert.equal((await e.api('GET', '/api/lobby', { token: tl })).json.areas.length, 3);

    // la contraseña nueva cierra la sesión anterior; importar una configuración no borra al usuario lobby
    const gen = await e.A('PUT', '/api/lobby/password', { generar: true });
    assert.match(gen.json.password, /^\d{6}$/);
    assert.equal((await e.api('GET', '/api/lobby', { token: tl })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { lobby: true, password: gen.json.password } })).status, 200);
    const seed = require('../seed/ejemplo-config.json');
    assert.equal((await e.A('PUT', '/api/config?nuevo_ciclo=1', seed)).status, 200);
    assert.equal((await e.api('POST', '/api/login', { body: { lobby: true, password: gen.json.password } })).status, 200);
  } finally { process.env.FAKE_NOW = MIERCOLES_S1; await e.close(); }
});

test('dashboard ejecutivo: métricas agregadas, solo para lobby y administrador', async () => {
  const e = await conAreas(4);
  try {
    await e.A('PUT', '/api/lobby/password', { password: 'lobby-1' });
    const tl = (await e.api('POST', '/api/login', { body: { lobby: true, password: 'lobby-1' } })).json.token;
    assert.equal((await e.api('GET', '/api/ejecutivo')).status, 401);
    assert.equal((await e.api('GET', '/api/ejecutivo', { token: await e.tokenDe('A-01') })).status, 403);
    assert.equal((await e.api('GET', '/api/ejecutivo', { token: e.admin })).status, 200);

    // vacío: sin auditorías hechas
    let d = (await e.api('GET', '/api/ejecutivo', { token: tl })).json;
    assert.equal(d.kpis.completadas, 0);
    assert.equal(d.kpis.calificacion_promedio, null);
    assert.equal(d.kpis.cumplimiento, null);
    assert.equal(d.puntos_debiles.length, 0);

    // semana 1: A-01 saca 100 y A-02 saca 95 (pierde la pregunta 1); ambas a tiempo
    const cfg = (await e.A('GET', '/api/config')).json.config;
    const t1 = await e.tokenDe('A-01');
    const t2 = await e.tokenDe('A-02');
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A01', { token: t1, body: cuerpoFinal(cfg, 'CL-A') })).status, 200);
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A02', { token: t2, body: cuerpoFinal(cfg, 'CL-A', { respuestas: respuestas(cfg, 'CL-A', (p) => (p.n === 1 ? 0 : p.p)) }) })).status, 200);
    // semana 2: A-03 y A-04 quedaron atrasadas de la semana 1
    process.env.FAKE_NOW = '2026-10-21T09:00:00';
    d = (await e.api('GET', '/api/ejecutivo', { token: tl })).json;
    assert.equal(d.semana, 2);
    assert.deepEqual({ ...d.kpis }, { ya_tocaban: 8, completadas: 2, a_tiempo: 2, fuera_de_tiempo: 0, atrasadas: 2, pendientes: 4,
      cumplimiento: 50, puntualidad: 100, calificacion_promedio: 97.5, nivel_promedio: '5S', areas_activas: 4 });
    // cumplimiento y calificación por mes de cada área
    assert.equal((await e.api('GET', '/api/mensual', { token: await e.tokenDe('A-01') })).status, 403);
    const mm = (await e.api('GET', '/api/mensual', { token: tl })).json;
    assert.deepEqual(mm.meses, ['2026-10']);
    const m1 = mm.areas.find((x) => x.id === 'A-01').meses[0];
    const mejor = mm.areas.map((x) => x.meses[0]).find((x) => x.calificacion === 100);
    assert.deepEqual([m1.cumplimiento, m1.realizadas, m1.atrasadas], [100, 1, 0]);
    assert.deepEqual([mejor.calificacion, mejor.nivel], [100, '5S']);
    assert.deepEqual([mm.planta[0].cumplimiento, mm.planta[0].calificacion], [50, 97.5]);
    // los resultados también llegan como nivel (1S a 5S): tendencia, por S y rankings
    assert.equal(d.tendencia[0].nivel, '5S');
    assert.equal(d.tendencia[1].nivel, null);
    assert.deepEqual(d.umbrales, [51, 72, 88, 95]);
    assert.deepEqual(d.por_s.map((x) => [x.s, x.nivel]), [['Seleccionar', '3S'], ['Ordenar', '5S'], ['Limpiar', '5S'], ['Estandarizar', '5S'], ['Sostener', '5S']]);
    assert.deepEqual([d.mejores[0].promedio, d.mejores[0].nivel, d.peores[0].promedio, d.peores[0].nivel], [100, '5S', 95, '5S']);
    // tablero: nivel junto a cada promedio
    const tbl = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tbl.resumen.nivel_promedio, '5S');
    assert.ok(tbl.auditadas.filter((a) => a.promedio !== null).every((a) => a.nivel_promedio === '5S'));
    assert.deepEqual(d.luces, { Verde: 0, Amarillo: 2, Rojo: 2, 'Sin asignar': 0 });
    assert.equal(d.tendencia.length, 2);
    assert.deepEqual([d.tendencia[0].iso, d.tendencia[0].cumplimiento, d.tendencia[0].calificacion], [42, 50, 97.5]);
    assert.deepEqual([d.tendencia[1].cumplimiento, d.tendencia[1].calificacion, d.tendencia[1].pendientes], [null, null, 4]);
    assert.deepEqual(d.niveles, { '1S': 0, '2S': 0, '3S': 0, '4S': 0, '5S': 2 });
    // promedio de la planta por S: puntos obtenidos promedio / puntos que valía la S (2 auditorías: 20 y 15 de 20)
    const sel = d.por_s.find((x) => x.s === 'Seleccionar');
    assert.deepEqual([sel.promedio_obtenido, sel.promedio_maximo, sel.pct, sel.auditorias], [17.5, 20, 87.5, 2]);
    assert.equal(d.por_s.find((x) => x.s === 'Ordenar').promedio_obtenido, 25);
    assert.equal(d.por_s.length, 5);
    // las cinco S suman el promedio de calificación de la planta (97.5) y su valor máximo suma 100
    assert.equal(d.por_s.reduce((x, s) => x + s.promedio_obtenido, 0), d.kpis.calificacion_promedio);
    assert.equal(d.por_s.reduce((x, s) => x + s.promedio_maximo, 0), 100);
    assert.equal(d.puntos_debiles.length, 1);
    assert.deepEqual([d.puntos_debiles[0].n, d.puntos_debiles[0].hallazgos, d.puntos_debiles[0].respuestas, d.puntos_debiles[0].pct], [1, 1, 2, 50]);
    assert.equal(d.mejores[0].promedio, 100);
    assert.equal(d.peores[0].promedio, 95);
    assert.deepEqual(d.mas_atrasos.map((x) => [x.id, x.atrasadas]), [['A-03', 1], ['A-04', 1]]);
    // no expone nombres de personas
    assert.ok(!/Ana|Luis|persona|firma/.test(JSON.stringify(d)));
  } finally { process.env.FAKE_NOW = MIERCOLES_S1; await e.close(); }
});

test('subcategorías de un área: se guardan con su texto de máquinas, se leen y sobreviven a reimportar la config', async () => {
  const e = await conAreas(2);
  try {
    assert.equal((await e.A('GET', '/api/areas/A-01/subareas')).json.subareas.length, 0);
    const r = await e.A('PUT', '/api/areas/A-01/subareas', { subareas: [{ nombre: 'Torno', maquinas: 'T-1, T-2' }, { nombre: 'Fresado', maquinas: 'F-1' }] });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.subareas.map((s) => [s.nombre, s.maquinas]), [['Torno', 'T-1'+String.fromCharCode(10)+'T-2'], ['Fresado', 'F-1']]);
    assert.equal((await e.A('PUT', '/api/areas/A-01/subareas', { subareas: [{ nombre: 'x' }, { nombre: 'X' }] })).status, 422);
    assert.equal((await e.A('PUT', '/api/areas/A-99/subareas', { subareas: [] })).status, 404);
    const cfg = (await e.A('GET', '/api/config')).json.config;
    assert.equal(cfg.areas[0].subareas.length, 2);
    delete cfg.areas[1].subareas;
    cfg.areas[0].subareas = [{ nombre: 'Nueva', maquinas: 'M-9' }];
    assert.equal((await e.A('PUT', '/api/config', cfg)).status, 200);
    assert.deepEqual((await e.A('GET', '/api/areas/A-01/subareas')).json.subareas.map((s) => s.nombre), ['Nueva']);
    cfg.areas[0].subareas = [{ nombre: '' }];
    assert.equal(validarConfig(cfg).ok, false);
  } finally { await e.close(); }
});
