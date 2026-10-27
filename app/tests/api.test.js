'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { configReal, respuestas, entornoListo, iniciar, crearBaseTemporal, FIRMA } = require('./helpers');

const MIERCOLES_S1 = '2026-10-14T10:00:00';
process.env.FAKE_NOW = MIERCOLES_S1;

const cuerpoFinal = (cfg, cl, extra = {}, fn) => ({
  estado: 'final', persona_audita: 'Ana Pérez', responsable: 'Luis Gómez', nomina_auditado: '1234567', dispositivo: 'dev-A',
  respuestas: respuestas(cfg, cl, fn), ...extra,
});

test('login: administrador, PIN y errores', async () => {
  const e = await entornoListo();
  try {
    assert.equal((await e.api('POST', '/api/login', { body: { admin: true, password: 'mala' } })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-01', pin: '0000' } })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-01', pin: 'abcd' } })).status, 401);
    const ok = await e.api('POST', '/api/login', { body: { area: 'A-01', pin: '1234' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.token);
    // sin token
    assert.equal((await e.api('GET', '/api/config')).status, 401);
    // un usuario de área no puede importar configuración ni ver respaldo
    assert.equal((await e.api('PUT', '/api/config', { token: ok.json.token, body: e.cfg })).status, 403);
    assert.equal((await e.api('GET', '/api/respaldo', { token: ok.json.token })).status, 403);
    // PIN inválido al establecerlo
    assert.equal((await e.api('PUT', '/api/usuarios/A-01/pin', { token: e.admin, body: { pin: '12' } })).status, 422);
  } finally { await e.close(); }
});

test('PIN incorrecto repetido: se bloquea con 429 (incluso con el PIN correcto)', async () => {
  const e = await entornoListo();
  try {
    let ultimo;
    for (let i = 0; i < 8; i++) ultimo = await e.api('POST', '/api/login', { body: { area: 'A-02', pin: '9999' } });
    assert.equal(ultimo.status, 401);
    const bloqueo = await e.api('POST', '/api/login', { body: { area: 'A-02', pin: '9999' } });
    assert.equal(bloqueo.status, 429);
    assert.match(bloqueo.json.error, /Espera/);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-02', pin: '1234' } })).status, 429);
    // otra área no se ve afectada
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-03', pin: '1234' } })).status, 200);
  } finally { await e.close(); }
});

test('token vencido o manipulado devuelve 401; restablecer el PIN invalida sesiones anteriores', async () => {
  const e = await entornoListo();
  try {
    const vencido = jwt.sign({ rol: 'admin' }, 'secreto-de-prueba', { expiresIn: -10 });
    const r = await e.api('GET', '/api/tablero', { token: vencido });
    assert.equal(r.status, 401);
    assert.equal(r.json.vencida, true);
    assert.equal((await e.api('GET', '/api/tablero', { token: jwt.sign({ rol: 'admin' }, 'otro-secreto') })).status, 401);
    const t = await e.tokenDe('A-05');
    assert.equal((await e.api('GET', '/api/tablero', { token: t })).status, 200);
    await e.api('PUT', '/api/usuarios/A-05/pin', { token: e.admin, body: { pin: '5555' } });
    assert.equal((await e.api('GET', '/api/tablero', { token: t })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-05', pin: '5555' } })).status, 200);
  } finally { await e.close(); }
});

test('reglas del servidor al guardar auditorías', async () => {
  const e = await entornoListo();
  try {
    const cfg = e.cfg;
    const t4 = await e.tokenDe('A-04');
    const put = (id, body, token = t4) => e.api('PUT', `/api/auditorias/${id}`, { token, body });

    // ID inexistente / mal formado
    assert.equal((await put('S99-A01', cuerpoFinal(cfg, 'CL-05'))).status, 404);
    assert.equal((await put('S01-A99', cuerpoFinal(cfg, 'CL-05'))).status, 404);
    assert.equal((await put('XYZ', cuerpoFinal(cfg, 'CL-05'))).status, 400);

    // S01-A04: A-04 audita a A-05 (CL-05)
    // auditarse a sí misma (el cliente declara auditada = auditora)
    let r = await put('S01-A04', { ...cuerpoFinal(cfg, 'CL-05'), auditada: 'A-04' });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /sí misma/);
    // auditada que no coincide con la rotación
    r = await put('S01-A04', { ...cuerpoFinal(cfg, 'CL-05'), auditada: 'A-20' });
    assert.equal(r.status, 422);
    // checklist incorrecto
    r = await put('S01-A04', { ...cuerpoFinal(cfg, 'CL-05'), checklist: 'CL-07' });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /CL-05/);
    // otra área no puede registrar la auditoría de A-04
    r = await put('S01-A04', cuerpoFinal(cfg, 'CL-05'), await e.tokenDe('A-10'));
    assert.equal(r.status, 403);
    // semana futura
    r = await put('S02-A04', cuerpoFinal(cfg, 'CL-05'));
    assert.equal(r.status, 422);
    assert.match(r.json.error, /aún no inicia/);

    // puntos fuera de rango
    const malo = cuerpoFinal(cfg, 'CL-05');
    malo.respuestas[18].puntos = 2; // el punto 19 vale 1
    r = await put('S01-A04', malo);
    assert.equal(r.status, 422);
    assert.match(r.json.error, /0 a 1/);
    const neg = cuerpoFinal(cfg, 'CL-05');
    neg.respuestas[0].puntos = -1;
    assert.equal((await put('S01-A04', neg)).status, 422);
    const dec = cuerpoFinal(cfg, 'CL-05');
    dec.respuestas[0].puntos = 2.5;
    assert.equal((await put('S01-A04', dec)).status, 422);

    // final incompleto, sin nombre o sin número de nómina del auditado
    const incompleto = cuerpoFinal(cfg, 'CL-05');
    incompleto.respuestas.pop();
    r = await put('S01-A04', incompleto);
    assert.equal(r.status, 422);
    assert.match(r.json.error, /Faltan puntos/);
    assert.equal((await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { persona_audita: '' }))).status, 422);
    r = await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { nomina_auditado: '' }));
    assert.equal(r.status, 422);
    assert.match(r.json.error, /nómina/);
    assert.equal((await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { nomina_auditado: undefined }))).status, 422);
    assert.equal((await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { nomina_auditado: '12ab' }))).status, 422);
    assert.equal((await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { nomina_auditado: '1234567890123' }))).status, 422);
    assert.equal((await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { nomina_auditado: 1234567 }))).status, 422, 'debe ser texto');

    // borrador parcial: idempotente
    const borrador = { estado: 'borrador', persona_audita: 'Ana', dispositivo: 'dev-A', respuestas: respuestas(cfg, 'CL-05', (p) => p.p).slice(0, 5) };
    r = await put('S01-A04', borrador);
    assert.equal(r.status, 200);
    assert.equal(r.json.estado, 'borrador');
    assert.equal(r.json.calificacion, null);
    r = await put('S01-A04', borrador);
    assert.equal(r.status, 200);
    assert.equal(r.json.respuestas.length, 5);

    // final válido; calificación recalculada en el servidor (se ignora la que mande el cliente)
    r = await put('S01-A04', { ...cuerpoFinal(cfg, 'CL-05', {}, (p) => (p.n === 1 ? 0 : p.p)), calificacion: 100, nivel: '5S' });
    assert.equal(r.status, 200);
    assert.equal(r.json.calificacion, 95);
    assert.equal(r.json.nivel, '5S');
    assert.equal(r.json.entrega, 'A tiempo');
    assert.equal(r.json.respuestas.find((x) => x.n === 1).hallazgo, 'Hallazgo 1');

    // una auditoría final no se modifica: 409 con el registro existente
    r = await put('S01-A04', cuerpoFinal(cfg, 'CL-05', { persona_audita: 'Otra persona' }));
    assert.equal(r.status, 409);
    assert.equal(r.json.auditoria.persona_audita, 'Ana Pérez');
    assert.equal(r.json.auditoria.calificacion, 95);
    r = await put('S01-A04', { estado: 'borrador', respuestas: [] });
    assert.equal(r.status, 409);

    // GET
    r = await e.api('GET', '/api/auditorias?semana=1&area=A-05', { token: t4 });
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].id, 'S01-A04');
    r = await e.api('GET', '/api/auditorias/S01-A04', { token: t4 });
    assert.equal(r.json.nomina_auditado, '1234567');
    assert.equal(r.json.firma, null, 'ya no se guarda firma');
  } finally { await e.close(); }
});

test('dos clientes finalizan la misma auditoría: gana la primera y la segunda recibe aviso', async () => {
  const e = await entornoListo();
  try {
    const cfg = e.cfg;
    const t = await e.tokenDe('A-04');
    const a = await e.api('PUT', '/api/auditorias/S01-A04', { token: t, body: cuerpoFinal(cfg, 'CL-05', { dispositivo: 'iPad-1', persona_audita: 'Primera' }) });
    const b = await e.api('PUT', '/api/auditorias/S01-A04', { token: t, body: cuerpoFinal(cfg, 'CL-05', { dispositivo: 'iPad-2', persona_audita: 'Segunda' }, (p) => (p.n === 3 ? 0 : p.p)) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 409);
    assert.equal(b.json.mismo_dispositivo, false);
    assert.equal(b.json.auditoria.persona_audita, 'Primera');
    // reintento del mismo dispositivo tras perder la respuesta: 409 pero reconocible como propio
    const c = await e.api('PUT', '/api/auditorias/S01-A04', { token: t, body: cuerpoFinal(cfg, 'CL-05', { dispositivo: 'iPad-1' }) });
    assert.equal(c.status, 409);
    assert.equal(c.json.mismo_dispositivo, true);
  } finally { await e.close(); }
});

test('estatus por fecha del sistema y semáforo', async () => {
  const e = await entornoListo();
  try {
    const cfg = e.cfg;
    const semana = async (n) => (await e.api('GET', `/api/semana/${n}`, { token: e.admin })).json;
    // Miércoles de la semana 1: Pendiente; semana 2: Programada
    let s1 = await semana(1);
    assert.ok(s1.asignaciones.every((a) => a.estatus === 'Pendiente'));
    assert.ok((await semana(2)).asignaciones.every((a) => a.estatus === 'Programada'));
    let tb = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tb.auditoras.find((x) => x.area === 'A-04').semaforo, 'Amarillo'); // pendiente en plazo
    assert.equal(tb.resumen.ya_tocaban, 36);

    // A-04 completa a tiempo
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: cuerpoFinal(cfg, 'CL-05') })).status, 200);
    tb = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tb.auditoras.find((x) => x.area === 'A-04').semaforo, 'Verde');
    assert.equal(tb.auditadas.find((x) => x.area === 'A-05').recibidas, 1);
    assert.equal(tb.auditadas.find((x) => x.area === 'A-05').promedio, 100);

    // Martes de la semana 2 (límite semana 1 = domingo 18): A-04 sigue verde, las demás Atrasadas -> Rojo
    process.env.FAKE_NOW = '2026-10-20T09:00:00';
    s1 = await semana(1);
    assert.equal(s1.asignaciones.find((a) => a.auditora === 'A-04').estatus, 'Completada');
    assert.equal(s1.asignaciones.find((a) => a.auditora === 'A-10').estatus, 'Atrasada');
    assert.ok((await semana(2)).asignaciones.every((a) => a.estatus === 'Pendiente'));
    assert.ok((await semana(3)).asignaciones.every((a) => a.estatus === 'Programada'));
    tb = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tb.auditoras.find((x) => x.area === 'A-10').semaforo, 'Rojo');
    assert.equal(tb.auditoras.find((x) => x.area === 'A-04').semaforo, 'Amarillo'); // semana 2 pendiente
    assert.equal(tb.resumen.atrasadas, 35);

    // A-10 completa su semana 1 fuera de tiempo (el lunes 19 ya es después del límite)
    const idA10 = 'S01-A10';
    const r = await e.api('PUT', `/api/auditorias/${idA10}`, { token: await e.tokenDe('A-10'), body: cuerpoFinal(cfg, cfg.areas[(9 + 1) % 36].checklist) });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.entrega, 'Fuera de tiempo');
    tb = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tb.auditoras.find((x) => x.area === 'A-10').semaforo, 'Amarillo'); // sin atrasadas pero fuera de tiempo
    assert.equal(tb.auditoras.find((x) => x.area === 'A-10').fuera_de_tiempo, 1);

    // Antes del inicio y después del ciclo
    process.env.FAKE_NOW = '2026-10-05T09:00:00';
    tb = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tb.semana.estado, 'previo');
    assert.equal(tb.auditoras[0].semaforo, 'Sin asignar');
    process.env.FAKE_NOW = '2027-07-01T09:00:00';
    tb = (await e.api('GET', '/api/tablero', { token: e.admin })).json;
    assert.equal(tb.semana.estado, 'terminado');
    assert.equal(tb.resumen.ya_tocaban, 36 * 35);
  } finally { process.env.FAKE_NOW = MIERCOLES_S1; await e.close(); }
});

test('export.csv: columnas, orden, comillas, BOM y acentos', async () => {
  const e = await entornoListo();
  try {
    const cfg = e.cfg;
    // S01-A35: A-35 audita a A-36 (CL-12, 20 puntos)
    await e.api('PUT', '/api/auditorias/S01-A35', {
      token: await e.tokenDe('A-35'),
      body: cuerpoFinal(cfg, 'CL-12', { persona_audita: 'José Ñandú "El Güero"', responsable: '=cmd|x', dispositivo: 'iPad-7' }, (p) => (p.n === 5 || p.n === 9 ? 0 : p.p)),
    });
    await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: cuerpoFinal(cfg, 'CL-05') });
    await e.api('PUT', '/api/auditorias/S01-A10', { token: await e.tokenDe('A-10'), body: { estado: 'borrador', respuestas: [] } });
    const raw = await fetch(`${e.base}/fc/api/export.csv?desde=2026-10-01`, { headers: { authorization: `Bearer ${e.admin}` } });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type'), /text\/csv/);
    const bytes = Buffer.from(await raw.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8');
    const lineas = bytes.subarray(3).toString('utf8').trim().split('\r\n');
    assert.equal(lineas.length, 3); // cabecera + 2 finales (el borrador no se exporta)
    const cab = lineas[0].split('","').map((x) => x.replace(/"/g, ''));
    const esperado = ['ID auditoría', 'Fecha y hora de envío', 'Correo de quien responde', 'Persona que audita', 'Área auditora', 'Área auditada', 'Sección auditada', 'Máquina auditada',
      'Código checklist', 'Responsable 5S del área auditada', 'Hallazgos', 'Acciones correctivas'];
    for (let i = 1; i <= 22; i++) esperado.push(`P${String(i).padStart(2, '0')}`);
    esperado.push('ID respuesta Forms', 'Tiempo de captura (seg)', 'Calificación'); // el administrador exporta con tiempo
    assert.deepEqual(cab, esperado);
    for (const l of lineas) assert.ok(l.startsWith('"') && l.endsWith('"'), 'todos los campos entre comillas');
    const celdas = (l) => l.slice(1, -1).split('","');
    const f = lineas.find((l) => l.startsWith('"S01-A35"'));
    const c = celdas(f);
    assert.equal(c.length, esperado.length);
    assert.match(c[1], /^2026-10-14 \d\d:\d\d$/);
    assert.equal(c[2], '');
    assert.equal(c[3], 'José Ñandú ""El Güero""');
    assert.equal(c[4], 'Área 35');
    assert.equal(c[5], 'Área 36');
    assert.equal(c[6], ''); // Sección auditada (el área de la prueba no tiene secciones)
    assert.equal(c[7], ''); // Máquina auditada
    assert.equal(c[8], 'CL-12');
    assert.equal(c[9], "'=cmd|x"); // neutraliza fórmulas
    assert.equal(c[10], 'P05: Hallazgo 5 | P09: Hallazgo 9');
    assert.equal(c[11], 'P05: Acción 5 | P09: Acción 9');
    assert.equal(c[12 + 4], '0'); // P05
    assert.equal(c[12], '5'); // P01
    assert.equal(c[12 + 19], '5'); // P20
    assert.equal(c[12 + 20], ''); // P21: CL-12 sólo tiene 20 puntos
    assert.equal(c[12 + 21], ''); // P22
    assert.equal(c[c.length - 3], 'iPad-7');
    assert.equal(c[c.length - 2], '', 'sin tiempo medido en esta auditoría');
    assert.equal(c[c.length - 1], '90', 'la última columna es la calificación');
    // filtro desde
    const fut = await e.api('GET', '/api/export.csv?desde=2026-10-15', { token: e.admin });
    assert.equal(fut.texto.trim().split('\r\n').length, 1);
  } finally { await e.close(); }
});

test('respaldo: solo admin y descarga un volcado SQL restaurable', async () => {
  const e = await entornoListo();
  try {
    assert.equal((await e.api('GET', '/api/respaldo', { token: await e.tokenDe('A-01') })).status, 403);
    const r = await fetch(`${e.base}/fc/api/respaldo`, { headers: { authorization: `Bearer ${e.admin}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /respaldo_5s_.*\.sql/);
    const sql = await r.text();
    assert.match(sql, /CREATE TABLE `auditorias`/);
    assert.match(sql, /INSERT INTO `areas`/);
    assert.match(sql, /\$2[aby]\$/, 'incluye los hashes de PIN');
    assert.ok(!sql.includes("'1234'"), 'nunca los PIN en claro');
  } finally { await e.close(); }
});

test('importar un ciclo nuevo exige confirmación y archiva las auditorías anteriores', async () => {
  const e = await entornoListo();
  try {
    await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: cuerpoFinal(e.cfg, 'CL-05') });
    const nuevo = { ...e.cfg, inicio: '2027-08-02' };
    let r = await e.api('PUT', '/api/config', { token: e.admin, body: nuevo });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'ciclo_nuevo');
    r = await e.api('PUT', '/api/config?nuevo_ciclo=1', { token: e.admin, body: nuevo });
    assert.equal(r.status, 200);
    process.env.FAKE_NOW = '2027-08-04T10:00:00';
    r = await e.api('GET', '/api/auditorias', { token: e.admin });
    assert.equal(r.json.length, 0);
    // el ID S01-A04 queda libre en el ciclo nuevo
    r = await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: cuerpoFinal(e.cfg, 'CL-05') });
    assert.equal(r.status, 200);
    // mismo inicio: se puede reimportar sin archivar
    assert.equal((await e.api('PUT', '/api/config', { token: e.admin, body: nuevo })).status, 200);
  } finally { process.env.FAKE_NOW = MIERCOLES_S1; await e.close(); }
});

test('PUT /api/config rechaza configuraciones inválidas con errores claros', async () => {
  const e = await entornoListo();
  try {
    const mala = configReal();
    mala.rotacion[4] = JSON.parse(JSON.stringify(mala.rotacion[0]));
    const r = await e.api('PUT', '/api/config', { token: e.admin, body: mala });
    assert.equal(r.status, 422);
    assert.ok(r.json.errores.some((x) => /se repite/.test(x)));
    // la configuración anterior sigue intacta
    const c = await e.api('GET', '/api/config', { token: e.admin });
    assert.equal(c.json.config.rotacion.length, 35);
  } finally { await e.close(); }
});

test('seguridad: cabeceras, CORS cerrado, JSON inválido, GET /api/areas público', async () => {
  const e = await entornoListo();
  try {
    const r = await e.api('GET', '/api/areas');
    assert.equal(r.status, 200);
    assert.equal(r.json.areas.length, 36);
    assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const x = await e.api('POST', '/api/login', { body: { area: 'A-01', pin: '1234' }, headers: { origin: 'http://malo.example' } });
    assert.equal(x.status, 403);
    const mal = await fetch(`${e.base}/fc/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{no es json' });
    assert.equal(mal.status, 400);
    const idx = await fetch(`${e.base}/`);
    assert.equal(idx.status, 200);
    // consultas parametrizadas: un area maliciosa no rompe nada
    const t = await e.tokenDe('A-01');
    const s = await e.api('GET', "/api/auditorias?area=' OR 1=1 --", { token: t });
    assert.equal(s.status, 200);
    assert.equal(s.json.length, 0);
  } finally { await e.close(); }
});

test('los datos persisten al reiniciar (misma base en disco)', async () => {
  const base = await crearBaseTemporal();
  const cfg = configReal();
  let e = await iniciar({ base });
  try {
    const admin = (await e.api('POST', '/api/login', { body: { admin: true, password: 'admin-test' } })).json.token;
    assert.equal((await e.api('PUT', '/api/config', { token: admin, body: cfg })).status, 200);
    await e.api('PUT', '/api/usuarios/A-04/pin', { token: admin, body: { pin: '4321' } });
    const t = (await e.api('POST', '/api/login', { body: { area: 'A-04', pin: '4321' } })).json.token;
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A04', { token: t, body: cuerpoFinal(cfg, 'CL-05') })).status, 200);
  } finally { await e.close(); }
  e = await iniciar({ base });
  try {
    const t = (await e.api('POST', '/api/login', { body: { area: 'A-04', pin: '4321' } })).json.token;
    const r = await e.api('GET', '/api/auditorias/S01-A04', { token: t });
    assert.equal(r.status, 200);
    assert.equal(r.json.estado, 'final');
    assert.equal((await e.api('GET', '/api/config', { token: t })).json.config.areas.length, 36);
  } finally { await e.close(); await base.borrar(); }
});

test('finalizaciones simultáneas de la misma auditoría: exactamente una gana', async () => {
  const e = await entornoListo();
  try {
    const t = await e.tokenDe('A-04');
    const envios = Array.from({ length: 6 }, (_, i) => e.api('PUT', '/api/auditorias/S01-A04', {
      token: t, body: cuerpoFinal(e.cfg, 'CL-05', { dispositivo: `equipo-${i}`, persona_audita: `Persona ${i}` }),
    }));
    const r = await Promise.all(envios);
    const estados = r.map((x) => x.status).sort();
    assert.deepEqual(estados, [200, 409, 409, 409, 409, 409]);
    const ganadora = r.find((x) => x.status === 200).json;
    for (const x of r.filter((y) => y.status === 409)) assert.equal(x.json.auditoria.persona_audita, ganadora.persona_audita);
    const filas = await e.db.q("SELECT COUNT(*) c FROM respuestas WHERE auditoria_id = 'S01-A04'");
    assert.equal(filas[0].c, 22);
  } finally { await e.close(); }
});

test('cambiar la fecha de inicio del ciclo: validación, confirmación y recálculo de plazos', async () => {
  const e = await entornoListo();
  try {
    const t4 = await e.tokenDe('A-04');
    // solo admin; fecha válida
    assert.equal((await e.api('PUT', '/api/config/inicio', { token: t4, body: { inicio: '2026-11-02' } })).status, 403);
    assert.equal((await e.api('PUT', '/api/config/inicio', { token: e.admin, body: { inicio: '2026-02-30' } })).status, 422);
    assert.equal((await e.api('PUT', '/api/config/inicio', { token: e.admin, body: {} })).status, 422);
    assert.equal((await e.api('PUT', '/api/config/inicio', { token: e.admin, body: { inicio: '2026-10-12' } })).json.sinCambios, true);

    // con una auditoría capturada pide confirmación
    assert.equal((await e.api('PUT', '/api/auditorias/S01-A04', { token: t4, body: cuerpoFinal(e.cfg, 'CL-05') })).status, 200);
    let r = await e.api('PUT', '/api/config/inicio', { token: e.admin, body: { inicio: '2026-10-05' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'confirmar_inicio');
    assert.equal(r.json.cantidad, 1);
    assert.equal((await e.api('GET', '/api/config', { token: e.admin })).json.config.inicio, '2026-10-12', 'sin confirmar no cambia nada');

    // con confirmación: la semana 1 pasa a iniciar el 5 de octubre (límite 11 oct) y la auditoría se conserva
    r = await e.api('PUT', '/api/config/inicio?confirmar=1', { token: e.admin, body: { inicio: '2026-10-05' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.auditorias, 1);
    const cfgNueva = (await e.api('GET', '/api/config', { token: e.admin })).json;
    assert.equal(cfgNueva.config.inicio, '2026-10-05');
    assert.equal(cfgNueva.semana.semana, 2, 'el miércoles 14 ya es la semana 2');
    const a = await e.api('GET', '/api/auditorias/S01-A04', { token: t4 });
    assert.equal(a.json.estado, 'final');
    assert.equal(a.json.fecha_limite, '2026-10-11');
    assert.equal(a.json.entrega, 'Fuera de tiempo', 'el plazo se recalcula con la nueva fecha');
    const s1 = (await e.api('GET', '/api/semana/1', { token: e.admin })).json;
    assert.equal(s1.inicio, '2026-10-05');
    assert.equal(s1.asignaciones.find((x) => x.auditora === 'A-10').estatus, 'Atrasada');

    // mover el inicio hacia adelante: la semana 1 aún no inicia y la captura sigue guardada
    assert.equal((await e.api('PUT', '/api/config/inicio?confirmar=1', { token: e.admin, body: { inicio: '2026-11-02' } })).status, 200);
    const s = (await e.api('GET', '/api/semana/1', { token: e.admin })).json;
    assert.equal(s.asignaciones.find((x) => x.auditora === 'A-04').estatus, 'Completada');
    assert.equal(s.asignaciones.find((x) => x.auditora === 'A-10').estatus, 'Programada');
    const bit = await e.api('GET', '/api/bitacora', { token: e.admin });
    assert.ok(bit.json.some((x) => x.accion === 'inicio_cambiado'));
  } finally { await e.close(); }
});
