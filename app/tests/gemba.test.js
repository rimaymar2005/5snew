'use strict';
// Gemba: hallazgos con foto, visibilidad por área y validaciones.
const test = require('node:test');
const assert = require('node:assert/strict');
const { configReal, entornoListo, FIRMA: FOTO } = require('./helpers');

process.env.FAKE_NOW = '2026-10-14T10:00:00';

const hallazgo = (extra = {}) => ({
  registrante: 'Ana Pérez', fecha: '2026-10-14', area: 'A-05', lugar: 'Prensa 3', observacion: 'Derrame de aceite junto a la máquina',
  dirigido: 'Luis Gómez', foto: FOTO, dispositivo: 'dev-1', ...extra,
});

test('gemba: se registra con foto y cada área ve solo lo suyo', async () => {
  const e = await entornoListo(configReal());
  try {
    const t1 = await e.tokenDe('A-01'); // registra
    const t5 = await e.tokenDe('A-05'); // área del hallazgo
    const t9 = await e.tokenDe('A-09'); // ajena

    const r = await e.api('PUT', '/api/gemba/G-abc12345', { token: t1, body: hallazgo() });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual([r.json.registrante, r.json.area, r.json.lugar, r.json.dirigido, r.json.area_registra, r.json.foto],
      ['Ana Pérez', 'A-05', 'Prensa 3', 'Luis Gómez', 'A-01', true]);

    // reintento del mismo envío: no se duplica
    assert.equal((await e.api('PUT', '/api/gemba/G-abc12345', { token: t1, body: hallazgo() })).status, 200);
    assert.equal((await e.api('GET', '/api/gemba', { token: e.admin })).json.length, 1);
    // otra área no puede reutilizar el ID
    assert.equal((await e.api('PUT', '/api/gemba/G-abc12345', { token: t9, body: hallazgo() })).status, 409);

    // todas las áreas y el administrador ven todos los hallazgos
    for (const t of [t1, t5, t9, await e.tokenDe('A-07'), e.admin]) assert.equal((await e.api('GET', '/api/gemba', { token: t })).json.length, 1);

    // la foto, igual
    for (const t of [t1, t5, t9, e.admin]) {
      const f = await fetch(`${e.base}/fc/api/gemba/G-abc12345/foto`, { headers: { authorization: `Bearer ${t}` } });
      assert.equal(f.status, 200);
      assert.equal(f.headers.get('content-type'), 'image/png');
      assert.ok((await f.arrayBuffer()).byteLength > 20);
    }
        assert.equal((await e.api('GET', '/api/gemba/G-abc12345/foto')).status, 401);

    // lobby no entra; solo el administrador borra
    await e.api('PUT', '/api/lobby/password', { token: e.admin, body: { password: 'lobby-1' } });
    const tl = (await e.api('POST', '/api/login', { body: { lobby: true, password: 'lobby-1' } })).json.token;
    assert.equal((await e.api('GET', '/api/gemba', { token: tl })).status, 403);
    assert.equal((await e.api('DELETE', '/api/gemba/G-abc12345', { token: t1 })).status, 403);
    assert.equal((await e.api('DELETE', '/api/gemba/G-abc12345', { token: e.admin })).status, 200);
    assert.equal((await e.api('GET', '/api/gemba', { token: e.admin })).json.length, 0);
  } finally { await e.close(); }
});

test('gemba: validaciones', async () => {
  const e = await entornoListo(configReal());
  try {
    const t1 = await e.tokenDe('A-01');
    const malo = async (extra, id = 'G-valida001') => e.api('PUT', `/api/gemba/${id}`, { token: t1, body: hallazgo(extra) });
    for (const [campo, valor] of [['registrante', '  '], ['lugar', ''], ['observacion', ''], ['fecha', '14/10/2026'], ['area', 'A-99'], ['dirigido', '  '],
      ['foto', undefined], ['foto', 'data:text/html;base64,PGI+'], ['foto', 'hola']]) {
      const x = await malo({ [campo]: valor });
      assert.equal(x.status, 422, `${campo}=${valor}`);
    }
    assert.equal((await malo({}, 'G-x')).status, 400, 'ID demasiado corto');
    // foto de más de 1.5 MB
    const grande = `data:image/jpeg;base64,${Buffer.alloc(1.6 * 1024 * 1024, 1).toString('base64')}`;
    assert.equal((await malo({ foto: grande })).status, 422);
    assert.equal((await e.api('GET', '/api/gemba', { token: e.admin })).json.length, 0, 'nada se guardó con datos inválidos');
    // el administrador también puede registrar; HTML en la observación se guarda como texto
    const ok = await e.api('PUT', '/api/gemba/G-admin0001', { token: e.admin, body: hallazgo({ observacion: '<b>hola</b>' }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.area_registra, 'admin');
    assert.equal(ok.json.observacion, '<b>hola</b>');
  } finally { await e.close(); }
});

test('gemba: se registra desde la pantalla, con foto, y aparece en la lista', async () => {
  const { JSDOM, VirtualConsole } = require('jsdom');
  const e = await entornoListo(configReal());
  const errores = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (er) => errores.push(er.message));
  const html = await (await fetch(`${e.base}/`)).text();
  const dom = new JSDOM(html, {
    url: `${e.base}/`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('a5s.planta', '"fc"');
      w.fetch = (u, o) => fetch(new URL(u, e.base), o);
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => 'blob:x';
    },
  });
  const w = dom.window;
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  const texto = () => w.document.getElementById('app').textContent.replace(/\s+/g, ' ');
  const esperar = async (fn, msg) => {
    for (let i = 0; i < 300; i++) { let ok = false; try { ok = fn(); } catch (x) { /* aún no */ } if (ok) return ok; await pausa(40); }
    throw new Error(`Tiempo agotado: ${msg}\n${texto().slice(0, 400)}\n${errores.join(' | ')}`);
  };
  const clic = async (sel, t) => (await esperar(() => [...w.document.querySelectorAll(sel)].find((x) => !t || x.textContent.includes(t)), `${sel} ${t || ''}`)).click();
  const escribir = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  try {
    await esperar(() => w.document.querySelector('select[aria-label="Elige tu área"] option[value="A-04"]'), 'lista de áreas');
    const selArea = w.document.querySelector('select[aria-label="Elige tu área"]');
    selArea.value = 'A-04';
    selArea.dispatchEvent(new w.Event('change', { bubbles: true }));
    await esperar(() => w.document.querySelector('input.pin'), 'PIN');
    escribir(w.document.querySelector('input.pin'), '1234');
    await clic('button', 'Entrar');
    await esperar(() => texto().includes('Esta semana'), 'inicio');

    await clic('.nav a', 'Gemba');
    await clic('a.btn', 'Registrar hallazgo');
    await esperar(() => texto().includes('Quién registra el hallazgo'), 'formulario');
    // sin datos: avisa qué falta y no guarda
    await clic('button', 'Guardar hallazgo');
    await esperar(() => texto().includes('Falta: Foto del problema'), 'aviso de faltantes');

    const q = (s) => w.document.querySelector(s);
    escribir(q('[aria-label="Quién registra el hallazgo"]'), 'Ana Pérez');
    escribir(q('[aria-label="Área del hallazgo"]'), 'A-05');
    escribir(q('[aria-label="Lugar o máquina"]'), 'Prensa 3');
    escribir(q('[aria-label="Observación"]'), 'Derrame de aceite');
    escribir(q('[aria-label="A quién va dirigido"]'), 'Luis Gómez');
    const d = new w.Date();
    const hoy = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(q('[aria-label="Fecha"]').value, hoy, 'la fecha por omisión es el día actual');
    const bytes = Buffer.from(FOTO.split(',')[1], 'base64');
    const archivo = new w.File([bytes], 'foto.png', { type: 'image/png' });
    Object.defineProperty(q('input[type="file"]'), 'files', { value: [archivo] });
    q('input[type="file"]').dispatchEvent(new w.Event('change', { bubbles: true }));
    await esperar(() => q('.gprev img'), 'vista previa');
    await clic('button', 'Guardar hallazgo');

    await esperar(() => texto().includes('Prensa 3') && texto().includes('Derrame de aceite'), 'hallazgo en la lista');
    assert.match(texto(), /Dirigido a: Luis Gómez/);
    for (let i = 0; i < 100 && (await e.api('GET', '/api/gemba', { token: e.admin })).json.length === 0; i++) await pausa(50);
    const final = (await e.api('GET', '/api/gemba', { token: e.admin })).json;
    assert.equal(final.length, 1);
    assert.deepEqual([final[0].registrante, final[0].area_registra, final[0].area, final[0].dirigido], ['Ana Pérez', 'A-04', 'A-05', 'Luis Gómez']);
    assert.deepEqual(errores, []);
  } finally { await pausa(300); w.close(); await e.close(); }
});

test('gemba: se registra desde el login, sin sesión, y queda a nombre de "publico"', async () => {
  const e = await entornoListo(configReal());
  try {
    const r = await e.api('PUT', '/api/gemba/G-publico01', { body: hallazgo() });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.area_registra, 'publico');
    // reintento: no se duplica
    assert.equal((await e.api('PUT', '/api/gemba/G-publico01', { body: hallazgo() })).status, 200);
    // sin sesión no se puede leer nada
    assert.equal((await e.api('GET', '/api/gemba')).status, 401);
    assert.equal((await e.api('GET', '/api/gemba/G-publico01/foto')).status, 401);
    // lo ven el administrador y todas las áreas
    assert.equal((await e.api('GET', '/api/gemba', { token: e.admin })).json.length, 1);
    assert.equal((await e.api('GET', '/api/gemba', { token: await e.tokenDe('A-05') })).json.length, 1);
    assert.equal((await e.api('GET', '/api/gemba', { token: await e.tokenDe('A-09') })).json.length, 1);
    // las validaciones siguen aplicando, y un token inválido se rechaza
    assert.equal((await e.api('PUT', '/api/gemba/G-publico02', { body: hallazgo({ foto: undefined }) })).status, 422);
    assert.equal((await e.api('PUT', '/api/gemba/G-publico03', { token: 'basura', body: hallazgo() })).status, 401);
    // límite por equipo
    let ultimo = 200;
    for (let i = 0; i < 45 && ultimo === 200; i++) ultimo = (await e.api('PUT', `/api/gemba/G-masivo${String(i).padStart(3, '0')}`, { body: hallazgo() })).status;
    assert.equal(ultimo, 429);
  } finally { await e.close(); }
});

test('gemba: el login tiene el botón "Registrar Gemba" y el hallazgo llega al servidor', async () => {
  const { JSDOM, VirtualConsole } = require('jsdom');
  const e = await entornoListo(configReal());
  const errores = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (er) => errores.push(er.message));
  const html = await (await fetch(`${e.base}/`)).text();
  const dom = new JSDOM(html, {
    url: `${e.base}/`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('a5s.planta', '"fc"');
      w.fetch = (u, o) => fetch(new URL(u, e.base), o);
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => 'blob:x';
    },
  });
  const w = dom.window;
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  const texto = () => w.document.getElementById('app').textContent.replace(/\s+/g, ' ');
  const esperar = async (fn, msg) => {
    for (let i = 0; i < 300; i++) { let ok = false; try { ok = fn(); } catch (x) { /* aún no */ } if (ok) return ok; await pausa(40); }
    throw new Error(`Tiempo agotado: ${msg}\n${texto().slice(0, 400)}\n${errores.join(' | ')}`);
  };
  const clic = async (sel, t) => (await esperar(() => [...w.document.querySelectorAll(sel)].find((x) => !t || x.textContent.includes(t)), `${sel} ${t || ''}`)).click();
  const escribir = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const q = (s) => w.document.querySelector(s);
  try {
    await esperar(() => texto().includes('Elige tu área'), 'login');
    assert.ok(q('select[aria-label="Elige tu área"]'), 'las áreas están en un dropdown');
    await clic('a.btn', 'Registrar Gemba');
    await esperar(() => texto().includes('Quién registra el hallazgo'), 'formulario sin sesión');
    assert.ok(!w.document.querySelector('.nav'), 'sin barra de navegación: no hay sesión');
    await esperar(() => q('[aria-label="Área del hallazgo"]').options.length > 1, 'áreas en el selector');
    escribir(q('[aria-label="Quién registra el hallazgo"]'), 'Visita Planta');
    escribir(q('[aria-label="Área del hallazgo"]'), 'A-06');
    escribir(q('[aria-label="Lugar o máquina"]'), 'Pasillo B');
    escribir(q('[aria-label="Observación"]'), 'Caja en el paso');
    escribir(q('[aria-label="A quién va dirigido"]'), 'Jefe de turno');
    const bytes = Buffer.from(FOTO.split(',')[1], 'base64');
    Object.defineProperty(q('input[type="file"]'), 'files', { value: [new w.File([bytes], 'foto.png', { type: 'image/png' })] });
    q('input[type="file"]').dispatchEvent(new w.Event('change', { bubbles: true }));
    await esperar(() => q('.gprev img'), 'vista previa');
    await clic('button', 'Guardar hallazgo');
    await esperar(() => texto().includes('Elige tu área'), 'regreso al login');
    let lista = [];
    for (let i = 0; i < 100 && !lista.length; i++) { lista = (await e.api('GET', '/api/gemba', { token: e.admin })).json; await pausa(50); }
    assert.equal(lista.length, 1);
    assert.deepEqual([lista[0].registrante, lista[0].area_registra, lista[0].area, lista[0].dirigido], ['Visita Planta', 'publico', 'A-06', 'Jefe de turno']);
    assert.deepEqual(errores, []);
  } finally { await pausa(300); w.close(); await e.close(); }
});
