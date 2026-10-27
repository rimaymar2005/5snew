'use strict';
// Correo con Microsoft Graph: cliente, correo por área, aviso de Gemba, recordatorios y resumen semanal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearGraph, desdeEntorno, INACTIVO } = require('../server/correo');
const { configReal, entornoListo, FIRMA: FOTO } = require('./helpers');

process.env.FAKE_NOW = '2026-10-14T10:00:00';

// correo falso: guarda lo que se enviaría
const falso = () => ({ activo: true, remitente: 'calidad@empresa.com', enviados: [], async enviar(m) { this.enviados.push(m); return { ok: true }; } });
const hallazgo = (extra = {}) => ({ registrante: 'Ana <b>Pérez</b>', fecha: '2026-10-14', area: 'A-05', lugar: 'Prensa 3', observacion: 'Derrame <script>x</script>', dirigido: 'Luis', foto: FOTO, ...extra });

test('Graph: pide el token y envía con el formato de sendMail; reintenta si el token venció', async () => {
  const llamadas = [];
  let tokens = 0;
  const fetchImpl = async (url, o) => {
    llamadas.push({ url, o });
    if (url.includes('login.microsoftonline.com')) { tokens += 1; return { ok: true, status: 200, json: async () => ({ access_token: `tok${tokens}`, expires_in: 3600 }) }; }
    if (o.headers.authorization === 'Bearer tok1' && tokens === 1 && llamadas.filter((c) => c.url.includes('sendMail')).length === 1) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 202, json: async () => ({}) };
  };
  const g = crearGraph({ tenant: 'mi-tenant', clientId: 'cid', secret: 'sec', remitente: 'calidad@empresa.com', fetchImpl });
  await g.enviar({ to: ['a@x.com', 'no-es-correo'], subject: 'Hola', html: '<p>hi</p>', adjuntos: [{ nombre: 'f.png', tipo: 'image/png', base64: 'AAAA' }] });
  const tok = llamadas[0];
  assert.match(tok.url, /login\.microsoftonline\.com\/mi-tenant\/oauth2\/v2\.0\/token/);
  assert.match(String(tok.o.body), /grant_type=client_credentials/);
  assert.match(String(tok.o.body), /graph\.microsoft\.com%2F\.default/);
  const envios = llamadas.filter((c) => c.url.includes('sendMail'));
  assert.equal(envios.length, 2, 'primer intento 401, reintento con token nuevo');
  assert.match(envios[1].url, /graph\.microsoft\.com\/v1\.0\/users\/calidad%40empresa\.com\/sendMail/);
  assert.equal(envios[1].o.headers.authorization, 'Bearer tok2');
  const cuerpo = JSON.parse(envios[1].o.body);
  assert.deepEqual(cuerpo.message.toRecipients, [{ emailAddress: { address: 'a@x.com' } }], 'solo direcciones válidas');
  assert.equal(cuerpo.message.body.contentType, 'HTML');
  assert.equal(cuerpo.message.attachments[0]['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.equal(cuerpo.message.attachments[0].contentBytes, 'AAAA');
  await assert.rejects(() => g.enviar({ to: 'malo', subject: 's', html: 'h' }), /destinatarios/);
  // error de Graph legible
  const g2 = crearGraph({ tenant: 't', clientId: 'c', secret: 's', remitente: 'r@x.com', fetchImpl: async (u) => (u.includes('login') ? { ok: true, status: 200, json: async () => ({ access_token: 'x' }) } : { ok: false, status: 403, json: async () => ({ error: { message: 'Access is denied' } }) }) });
  await assert.rejects(() => g2.enviar({ to: 'a@x.com', subject: 's', html: 'h' }), /403.*Access is denied/);
  // sin variables de entorno queda desactivado
  assert.equal(desdeEntorno({}), INACTIVO);
  assert.equal(desdeEntorno({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_SENDER: 'r@x.com' }).activo, true);
});

test('correo por área: se captura en Administración, se valida y no se filtra a las demás áreas', async () => {
  const correo = falso();
  const e = await entornoListo(configReal(), { correo, adminCorreos: ['admin@empresa.com'] });
  try {
    assert.equal((await e.api('PUT', '/api/areas/A-05', { token: e.admin, body: { correo: 'area5@empresa.com' } })).status, 200);
    assert.equal((await e.api('PUT', '/api/areas/A-05', { token: e.admin, body: { correo: 'esto no es correo' } })).status, 422);
    const resumen = (await e.api('GET', '/api/admin/resumen', { token: e.admin })).json;
    assert.equal(resumen.areas.find((a) => a.id === 'A-05').correo, 'area5@empresa.com');
    // ni la configuración que baja a las áreas ni el login traen correos
    const t1 = await e.tokenDe('A-01');
    assert.ok(!(await e.api('GET', '/api/config', { token: t1 })).texto.includes('area5@empresa.com'));
    assert.ok(!(await e.api('GET', '/api/areas')).texto.includes('area5@empresa.com'));
    // se conserva al reimportar la configuración
    assert.equal((await e.api('PUT', '/api/config', { token: e.admin, body: e.cfg })).status, 200);
    assert.equal((await e.api('GET', '/api/admin/resumen', { token: e.admin })).json.areas.find((a) => a.id === 'A-05').correo, 'area5@empresa.com');
    // estado del correo y prueba solo para el administrador
    assert.equal((await e.api('GET', '/api/admin/correo', { token: t1 })).status, 403);
    const est = (await e.api('GET', '/api/admin/correo', { token: e.admin })).json;
    assert.deepEqual([est.activo, est.admin], [true, ['admin@empresa.com']]);
    const prueba = await e.api('POST', '/api/admin/correo/prueba', { token: e.admin });
    assert.equal(prueba.status, 200, prueba.texto);
    assert.deepEqual(correo.enviados.at(-1).to, ['admin@empresa.com']);
  } finally { await e.close(); }
});

test('sin configurar, el correo está desactivado y nada se rompe', async () => {
  const e = await entornoListo(configReal());
  try {
    assert.equal((await e.api('GET', '/api/admin/correo', { token: e.admin })).json.activo, false);
    assert.equal((await e.api('POST', '/api/admin/correo/prueba', { token: e.admin })).status, 409);
    assert.equal((await e.api('PUT', '/api/gemba/G-sincorreo1', { body: hallazgo() })).status, 200);
  } finally { await e.close(); }
});

test('Gemba: avisa por correo al área del problema y al administrador, con la foto adjunta y el texto escapado', async () => {
  const correo = falso();
  const e = await entornoListo(configReal(), { correo, adminCorreos: ['admin@empresa.com'] });
  try {
    await e.api('PUT', '/api/areas/A-05', { token: e.admin, body: { correo: 'area5@empresa.com' } });
    assert.equal((await e.api('PUT', '/api/gemba/G-conmail001', { body: hallazgo() })).status, 200);
    await e.instancias.fc.correos.esperar();
    assert.equal(correo.enviados.length, 1);
    const m = correo.enviados[0];
    assert.deepEqual(m.to.sort(), ['admin@empresa.com', 'area5@empresa.com']);
    assert.match(m.subject, /^\[Gemba · FC\] Nuevo hallazgo en Área 5 · Prensa 3/);
    assert.equal(m.adjuntos[0].tipo, 'image/png');
    assert.equal(m.adjuntos[0].base64, FOTO.split(',')[1]);
    assert.ok(!m.html.includes('<script>') && !m.html.includes('<b>Pérez'), 'el HTML de los usuarios se escapa');
    assert.match(m.html, /&lt;script&gt;/);
    // un reintento del mismo envío no manda otro correo
    await e.api('PUT', '/api/gemba/G-conmail001', { body: hallazgo() });
    await e.instancias.fc.correos.esperar();
    assert.equal(correo.enviados.length, 1);
    // si el correo falla, el hallazgo se guarda igual y queda en la bitácora
    correo.enviar = async () => { throw new Error('Graph caído'); };
    assert.equal((await e.api('PUT', '/api/gemba/G-conmail002', { body: hallazgo() })).status, 200);
    await e.instancias.fc.correos.esperar();
    assert.equal((await e.api('GET', '/api/gemba', { token: e.admin })).json.length, 2);
    const bit = (await e.api('GET', '/api/bitacora?limit=20', { token: e.admin })).json;
    assert.ok(bit.some((b) => b.accion === 'correo_error' && /Graph caído/.test(b.detalle)));
  } finally { await e.close(); }
});

test('recordatorios de auditorías por vencer y atrasadas, y resumen semanal; sin repetirse', async () => {
  const previo = process.env.FAKE_NOW; // se restaura al final
  const correo = falso();
  const e = await entornoListo(configReal(), { correo, adminCorreos: ['admin@empresa.com'] });
  try {
    for (const a of ['A-01', 'A-02']) await e.api('PUT', `/api/areas/${a}`, { token: e.admin, body: { correo: `${a.toLowerCase()}@empresa.com` } });
    const c = e.instancias.fc.correos;

    // sábado 17 (el plazo de la semana 1 es el 18): recordatorio solo a las áreas con correo
    process.env.FAKE_NOW = '2026-10-17T10:00:00';
    let r = await c.revisarDiario();
    assert.equal(r.recordatorios, 2);
    assert.deepEqual(correo.enviados.map((m) => m.to[0]).sort(), ['a-01@empresa.com', 'a-02@empresa.com']);
    assert.match(correo.enviados[0].subject, /Recordatorio: tu auditoría vence el 2026-10-18/);
    // se revisa una sola vez al día, y aun forzando no se repite el mismo aviso
    assert.equal((await c.revisarDiario()).recordatorios, 0);
    assert.equal((await c.revisarDiario({ forzar: true })).recordatorios, 0);
    assert.equal(correo.enviados.length, 2);

    // martes 20 (semana 2): la semana 1 quedó atrasada
    correo.enviados.length = 0;
    process.env.FAKE_NOW = '2026-10-20T10:00:00';
    r = await c.revisarDiario();
    assert.equal(r.atrasadas, 36);
    assert.equal(r.resumen, true);
    const para = (a) => correo.enviados.filter((m) => m.to.includes(a));
    assert.equal(para('a-01@empresa.com').length, 1);
    assert.match(para('a-01@empresa.com')[0].subject, /1 auditoría atrasada/);
    const admin = para('admin@empresa.com');
    assert.equal(admin.length, 2, 'lista de atrasadas + resumen semanal');
    assert.ok(admin.some((m) => /36 auditorías atrasadas/.test(m.subject)));
    const res = admin.find((m) => /Resumen de la semana 1/.test(m.subject));
    assert.ok(res, 'resumen de la semana 1');
    assert.match(res.html, /Sin completar/);
    // al día siguiente: otro recordatorio de atrasadas y el resumen NO se repite
    correo.enviados.length = 0;
    process.env.FAKE_NOW = '2026-10-21T10:00:00';
    r = await c.revisarDiario();
    assert.equal(r.resumen, false);
    assert.equal(para('a-01@empresa.com').length, 1);
    assert.ok(!correo.enviados.some((m) => /Resumen de la semana/.test(m.subject)));
  } finally { process.env.FAKE_NOW = previo; await e.close(); }
});
