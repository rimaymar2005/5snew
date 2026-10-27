'use strict';
// Plantas FC y PMC: cada una con su propia base de datos, sesiones y capturas locales.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createMulti } = require('../server/multi');
const { configReal, crearBaseTemporal } = require('./helpers');

const DB = {
  host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.TEST_DB_PORT) || 3307,
  user: process.env.TEST_DB_USER || 'root', password: process.env.TEST_DB_PASSWORD || 'root',
};
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function dosPlantas() {
  const bd = { fc: await crearBaseTemporal(), pmc: await crearBaseTemporal() };
  const { app, close } = await createMulti({
    plantas: { fc: { conexion: { ...DB, database: bd.fc.nombre } }, pmc: { conexion: { ...DB, database: bd.pmc.nombre } } },
    adminPassword: 'admin-test', jwtSecret: 'secreto-de-prueba', trustProxy: 'false',
  });
  const server = await new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, ruta, { token, body } = {}) => {
    const r = await fetch(base + ruta, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* no es JSON */ }
    return { status: r.status, json, texto };
  };
  return {
    base, api,
    cerrar: () => new Promise((res) => server.close(async () => { await close(); await bd.fc.borrar(); await bd.pmc.borrar(); res(); })),
  };
}
const loginAdmin = async (e, planta) => (await e.api('POST', `/${planta}/api/login`, { body: { admin: true, password: 'admin-test' } })).json.token;

test('los datos de FC y PMC son independientes', async () => {
  const e = await dosPlantas();
  try {
    const tokFc = await loginAdmin(e, 'fc');
    const tokPmc = await loginAdmin(e, 'pmc');
    const imp = await e.api('PUT', '/fc/api/config', { token: tokFc, body: configReal() });
    assert.equal(imp.status, 200, imp.texto);

    const fc = await e.api('GET', '/fc/api/areas');
    const pmc = await e.api('GET', '/pmc/api/areas');
    assert.equal(fc.json.areas.length, 36);
    assert.equal(pmc.json.areas.length, 0, 'PMC no debe ver las áreas de FC');
    assert.equal(pmc.json.configurada, false);

    // el PIN de un área de FC no existe en PMC
    await e.api('PUT', '/fc/api/usuarios/A-01/pin', { token: tokFc, body: { pin: '1234' } });
    assert.equal((await e.api('POST', '/fc/api/login', { body: { area: 'A-01', pin: '1234' } })).status, 200);
    assert.notEqual((await e.api('POST', '/pmc/api/login', { body: { area: 'A-01', pin: '1234' } })).status, 200);

    // una sesión de una planta no sirve en la otra (ni siquiera la del administrador)
    assert.equal((await e.api('GET', '/pmc/api/usuarios', { token: tokFc })).status, 401);
    assert.equal((await e.api('GET', '/fc/api/usuarios', { token: tokPmc })).status, 401);
    assert.equal((await e.api('GET', '/fc/api/usuarios', { token: tokFc })).status, 200);
  } finally { await e.cerrar(); }
});

test('sin planta no hay API; salud global y página disponibles', async () => {
  const e = await dosPlantas();
  try {
    assert.equal((await e.api('GET', '/api/areas')).status, 404);
    assert.equal((await e.api('POST', '/api/login', { body: { admin: true, password: 'admin-test' } })).status, 404);
    assert.equal((await e.api('GET', '/api/salud')).json.ok, true);
    assert.equal((await e.api('GET', '/pmc/api/salud')).json.ok, true);
    assert.equal((await e.api('GET', '/pmc/api/ruta-que-no-existe')).status, 404);
    const idx = await fetch(`${e.base}/`);
    assert.equal(idx.status, 200);
    assert.match(await idx.text(), /Auditorías 5S/);
  } finally { await e.cerrar(); }
});

async function abrir(base, { almacen = {} } = {}) {
  const errores = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (er) => errores.push(er.message));
  const html = await (await fetch(`${base}/`)).text();
  const dom = new JSDOM(html, {
    url: `${base}/`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(almacen)) w.localStorage.setItem(k, JSON.stringify(v));
      w.fetch = (u, o) => fetch(new URL(u, base), o);
      w.scrollTo = () => {};
    },
  });
  const w = dom.window;
  const texto = () => w.document.getElementById('app').textContent.replace(/\s+/g, ' ');
  const esperar = async (fn, msg) => {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = fn(); } catch (er) { /* aún no */ }
      if (ok) return ok;
      if (Date.now() - t0 > 8000) throw new Error(`Tiempo agotado: ${msg}\n${texto().slice(0, 400)}\n${errores.join(' | ')}`);
      await pausa(40);
    }
  };
  return { w, texto, esperar, errores, cerrar: async () => { await pausa(200); w.close(); } };
}

test('pantalla de planta antes del login; se recuerda y se puede cambiar', async () => {
  const e = await dosPlantas();
  let eq;
  try {
    const tokFc = await loginAdmin(e, 'fc');
    await e.api('PUT', '/fc/api/config', { token: tokFc, body: configReal() });

    eq = await abrir(e.base);
    await eq.esperar(() => eq.texto().includes('Elige la planta'), 'selector de planta');
    assert.ok(eq.w.document.querySelector('[data-planta="fc"]') && eq.w.document.querySelector('[data-planta="pmc"]'));
    assert.ok(!eq.texto().includes('Elige tu área'), 'el login no aparece antes de elegir planta');

    eq.w.document.querySelector('[data-planta="pmc"]').click();
    await eq.esperar(() => eq.texto().includes('Elige tu área'), 'login de PMC');
    assert.ok(eq.texto().includes('Planta PMC'));
    await eq.esperar(() => eq.texto().includes('Aún no hay áreas dadas de alta'), 'PMC sin áreas');
    assert.equal(JSON.parse(eq.w.localStorage.getItem('a5s.planta')), 'pmc');

    eq.w.document.querySelectorAll('button').forEach((b) => { if (b.textContent.includes('Cambiar de planta')) b.click(); });
    await eq.esperar(() => eq.texto().includes('Elige la planta'), 'regreso al selector');
    eq.w.document.querySelector('[data-planta="fc"]').click();
    await eq.esperar(() => eq.texto().includes('Planta FC') && eq.texto().includes('A-01'), 'login de FC con áreas');
    assert.deepEqual(eq.errores, []);
    await eq.cerrar(); eq = null;

    // la planta elegida se recuerda en el equipo
    eq = await abrir(e.base, { almacen: { 'a5s.planta': 'pmc' } });
    await eq.esperar(() => eq.texto().includes('Planta PMC'), 'planta recordada');
  } finally { if (eq) await eq.cerrar(); await e.cerrar(); }
});

test('equipos que ya usaban la app: lo guardado pasa a FC y no se mezcla con PMC', async () => {
  const e = await dosPlantas();
  let eq;
  try {
    // sesión de antes de las plantas (clave sin planta): debe terminar en el espacio de FC
    eq = await abrir(e.base, { almacen: { 'a5s.session': { token: 'x', rol: 'area', area: 'A-01' }, 'a5s.dev': 'dev-abc123' } });
    await eq.esperar(() => eq.w.localStorage.getItem('a5s.fc.session') || eq.w.localStorage.getItem('a5s.planta'), 'migración');
    assert.equal(eq.w.localStorage.getItem('a5s.session'), null);
    assert.equal(JSON.parse(eq.w.localStorage.getItem('a5s.planta')), 'fc');
    assert.equal(JSON.parse(eq.w.localStorage.getItem('a5s.dev')), 'dev-abc123', 'el id del equipo es común');
    assert.equal(eq.w.localStorage.getItem('a5s.pmc.session'), null);
  } finally { if (eq) await eq.cerrar(); await e.cerrar(); }
});
