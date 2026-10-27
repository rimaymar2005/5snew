'use strict';
// Pruebas de la interfaz: se ejecuta public/index.html (el real, servido por el backend real) dentro de jsdom.
// Cada JSDOM es un "equipo" distinto (su propio almacenamiento local). No mide diseño visual: ver README.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { configReal, entornoListo, iniciar, FIRMA } = require('./helpers');

const MIERCOLES_S1 = '2026-10-14T10:00:00';
process.env.FAKE_NOW = MIERCOLES_S1;

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function abrirEquipo(base, planta = 'fc') {
  const errores = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errores.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a) => errores.push(`console.error: ${a.join(' ')}`));
  const estado = { offline: false };
  const html = await (await fetch(`${base}/`)).text();
  const dom = new JSDOM(html, {
    url: `${base}/`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (planta) w.localStorage.setItem('a5s.planta', JSON.stringify(planta)); // planta ya elegida en este equipo
      w.fetch = (u, o) => {
        if (estado.cerrado) return new Promise(() => {});
        if (estado.offline) return Promise.reject(new TypeError('Failed to fetch'));
        estado.enVuelo = (estado.enVuelo || 0) + 1; // peticiones en curso: al cerrar se espera a que terminen
        return fetch(new URL(u, base), o).finally(() => { estado.enVuelo -= 1; });
      };
      w.scrollTo = () => {};
      w.print = () => { estado.imprimio = true; };
      w.URL.createObjectURL = () => 'blob:x';
      w.URL.revokeObjectURL = () => {};
      w.Element.prototype.setPointerCapture = () => {};
    },
  });
  const w = dom.window;
  const eq = {
    w, errores, estado,
    // solo el contenido visible (el código del <script> también es textContent del body)
    texto: () => `${w.document.getElementById('app').textContent} ${w.document.getElementById('toasts').textContent}`.replace(/\s+/g, ' '),
    async esperar(fn, msg, ms = 15000) {
      const t0 = Date.now();
      for (;;) {
        let r = false;
        try { r = fn(); } catch (e) { /* aún no */ }
        if (r) return r;
        if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado esperando: ${msg}\nTexto: ${eq.texto().slice(0, 700)}\nErrores: ${errores.join(' | ')}`);
        await pausa(40);
      }
    },
    esperarTexto: (t, ms) => eq.esperar(() => eq.texto().includes(t), `"${t}"`, ms),
    // el login elige el área en una lista desplegable
    async elegirArea(area) {
      const sel = await eq.esperar(() => { const x = w.document.querySelector('select[aria-label="Elige tu área"]'); return x && [...x.options].some((o) => o.value === area) ? x : null; }, `lista de áreas con ${area}`);
      sel.value = area;
      sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    buscar(sel, texto) { return [...w.document.querySelectorAll(sel)].find((e) => (!texto || e.textContent.includes(texto)) && !e.disabled) || null; },
    async clic(sel, texto) {
      const el = await eq.esperar(() => eq.buscar(sel, texto), `${sel} con "${texto}"`);
      el.click();
    },
    escribir(el, valor) { el.value = valor; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    pill: () => w.document.querySelector('.pill[data-sync]').textContent.trim(),
    irA(hash) { w.location.hash = hash; },
    async sinRed(v) { estado.offline = v; w.dispatchEvent(new w.Event(v ? 'offline' : 'online')); await pausa(50); },
    // deja terminar lo que esté en vuelo antes de cerrar la ventana (si no, sus callbacks tocan un documento cerrado)
    async cerrar() {
      estado.cerrado = true; // no se inician peticiones nuevas
      const t0 = Date.now();
      while ((estado.enVuelo || 0) > 0 && Date.now() - t0 < 8000) await pausa(25);
      await pausa(250); // deja ejecutar lo que dispararon esas respuestas antes de cerrar la ventana
      w.close();
    },
  };
  return eq;
}

async function entrar(eq, area, pin = '1234') {
  await eq.elegirArea(area);
  await eq.esperar(() => eq.w.document.querySelector('input.pin'), 'campo PIN');
  eq.escribir(eq.w.document.querySelector('input.pin'), pin);
  await eq.clic('button', 'Entrar');
  await eq.esperarTexto('Esta semana');
}

// Contesta todo con el máximo salvo `bajar` ({n: valor})
async function capturar(eq, { persona = 'Ana Pérez', responsable = 'Luis Gómez', bajar = { 2: 3 }, hallazgos = true } = {}) {
  await eq.esperar(() => eq.w.document.querySelector('.item'), 'lista de puntos');
  eq.escribir(eq.w.document.querySelector('input[placeholder="Nombre completo"]'), persona);
  eq.escribir(eq.w.document.querySelector('input[placeholder^="Responsable de"]'), responsable);
  for (const it of eq.w.document.querySelectorAll('.item')) {
    const n = it.dataset.n;
    const opts = [...it.querySelectorAll('.opt')];
    const v = bajar[n] !== undefined ? bajar[n] : opts.length - 1;
    opts[v].click();
  }
  for (const n of hallazgos ? Object.keys(bajar) : []) {
    const tas = eq.w.document.querySelectorAll(`.item[data-n="${n}"] textarea`);
    if (+bajar[n] < +eq.w.document.querySelector(`.item[data-n="${n}"] .opt:last-child`).dataset.v) {
      eq.escribir(tas[0], `Hallazgo en punto ${n}`);
      eq.escribir(tas[1], `Acción para punto ${n}`);
    }
  }
}
async function finalizarUI(eq) {
  await eq.clic('button', 'Revisar y continuar');
  await eq.esperarTexto('Resumen de la auditoría');
  // sin número de nómina del auditado no se puede finalizar
  assert.equal(eq.w.document.querySelector('.footer-act .btn.primary').disabled, true);
  const nom = eq.w.document.querySelector('input[aria-label="Número de nómina del auditado"]');
  eq.escribir(nom, '12ab34');
  assert.equal(nom.value, '1234', 'solo se aceptan dígitos');
  eq.escribir(nom, '7654321');
  await eq.clic('button', 'Finalizar y guardar');
  await eq.esperar(() => eq.w.document.querySelector('.overlay'), 'diálogo de confirmación');
  await eq.clic('.overlay button', 'Finalizar y guardar');
  await eq.esperarTexto('Reporte de auditoría 5S');
}

test('flujo completo: login, auditoría con marcador en vivo, nómina del auditado, reporte y tablero', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-04');
    await eq.esperarTexto('Debes auditar');
    assert.match(eq.texto(), /Debes auditar\s*Área 5/);
    assert.match(eq.texto(), /Semana 1 de 35/);
    assert.match(eq.texto(), /Fecha límite: 18 oct 2026/);
    await eq.clic('a.btn', 'Iniciar auditoría');
    await capturar(eq);
    const score = eq.w.document.querySelector('.aud-head .score').textContent.replace(/\s+/g, ' ');
    assert.match(score, /98/);
    assert.match(score, /Nivel 5S/);
    assert.match(score, /22 de 22 puntos contestados/);
    // subtotal por S del encabezado de sección
    assert.match(eq.texto(), /Seleccionar.*Ordenar/);
    // los campos de hallazgo solo aparecen cuando el puntaje < máximo
    assert.equal(eq.w.document.querySelector('.item[data-n="2"] .hall').classList.contains('hidden'), false);
    assert.equal(eq.w.document.querySelector('.item[data-n="1"] .hall').classList.contains('hidden'), true);
    await finalizarUI(eq);
    assert.match(eq.texto(), /Reporte de auditoría 5S · S01-A04/);
    assert.match(eq.texto(), /Nivel 5S/);
    assert.match(eq.texto(), /Hallazgo en punto 2/);
    assert.match(eq.texto(), /Acción para punto 2/);
    await eq.clic('button', 'Imprimir');
    assert.equal(eq.estado.imprimio, true);
    await eq.esperar(() => eq.pill() === 'Sincronizado', 'sincronización');
    const srv = await e.api('GET', '/api/auditorias/S01-A04', { token: e.admin });
    assert.equal(srv.json.estado, 'final');
    assert.equal(srv.json.calificacion, 98);
    assert.equal(srv.json.responsable, 'Luis Gómez');
    assert.equal(srv.json.nomina_auditado, '7654321');
    assert.match(eq.texto(), /Nómina del auditados*7654321/);
    assert.equal(srv.json.respuestas.find((x) => x.n === 2).puntos, 3);

    // Inicio ahora ofrece "Ver reporte"
    eq.irA('#/inicio');
    await eq.clic('a.btn', 'Ver reporte');
    await eq.esperarTexto('Reporte de auditoría 5S');
    // Tablero
    eq.irA('#/tablero');
    await eq.esperarTexto('Mis métricas');
    // "Completada" también aparece en el filtro de estatus: se espera la fila de la tabla, no la palabra suelta
    await eq.esperar(() => /Área 4.*Área 5.*CL-05.*Completada.*5S 98\.0.*A tiempo/.test(eq.texto()), 'fila completada en el tablero');
    // filtro segmentado por estatus
    await eq.clic('.seg-filtro button', 'Atrasada');
    await eq.esperarTexto('Sin resultados.');
    assert.equal(eq.w.document.querySelector('.seg-filtro button[aria-pressed="true"]').textContent, 'Atrasada');
    await eq.clic('.seg-filtro button', 'Completada');
    await eq.esperar(() => /Área 4.*Área 5.*Completada/.test(eq.texto()) && !eq.texto().includes('Sin resultados.'), 'solo completadas');
    await eq.clic('.tabs button', 'Acumulado');
    await eq.esperarTexto('Como auditora');
    assert.match(eq.texto(), /Área 4.*1.*1.*1.*0.*0.*100%.*Verde/);
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('sin conexión: se captura una auditoría completa y se sincroniza al volver', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-10');
    await eq.esperar(() => eq.pill() === 'Sincronizado', 'primera sincronización');
    await eq.sinRed(true);
    await eq.esperar(() => /Sin conexión/.test(eq.pill()), 'indicador sin conexión');
    await eq.clic('a.btn', 'Iniciar auditoría');
    await capturar(eq, { persona: 'Rosa Sin Red', bajar: { 4: 0 } });
    await finalizarUI(eq);
    assert.match(eq.pill(), /Sin conexión · 1 pendiente/);
    assert.equal((await e.api('GET', '/api/auditorias/S01-A10', { token: e.admin })).status, 404);
    // el reporte funciona sin red
    assert.match(eq.texto(), /Rosa Sin Red/);
    await eq.sinRed(false);
    await eq.esperar(() => eq.pill() === 'Sincronizado', 'sincronización al reconectar', 20000);
    const r = await e.api('GET', '/api/auditorias/S01-A10', { token: e.admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.estado, 'final');
    assert.equal(r.json.persona_audita, 'Rosa Sin Red');
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('borrador: el autoguardado sobrevive a recargar y se sube al servidor', async () => {
  const e = await entornoListo(configReal());
  let eq = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-04');
    await eq.clic('a.btn', 'Iniciar auditoría');
    await eq.esperar(() => eq.w.document.querySelector('.item'), 'puntos');
    eq.w.document.querySelector('.item[data-n="1"] .opt:last-child').click();
    eq.escribir(eq.w.document.querySelector('input[placeholder="Nombre completo"]'), 'Borrador Pérez');
    const local = eq.w.localStorage.getItem('a5s.fc.a.S01-A04');
    assert.ok(local, 'el borrador se guarda localmente en cada cambio');
    assert.equal(JSON.parse(local).respuestas['1'].p, 5);
    await eq.esperar(() => eq.pill() === 'Sincronizado', 'subida del borrador', 20000);
    const srv = await e.api('GET', '/api/auditorias/S01-A04', { token: e.admin });
    assert.equal(srv.json.estado, 'borrador');
    assert.equal(srv.json.respuestas.length, 1);
    assert.match(eq.texto(), /1 de 22 puntos contestados/);
  } finally { await eq.cerrar(); await e.close(); }
});

test('dos equipos finalizan la misma auditoría: gana la primera y el segundo recibe un aviso', async () => {
  const e = await entornoListo(configReal());
  const a = await abrirEquipo(e.base);
  const b = await abrirEquipo(e.base);
  try {
    await entrar(a, 'A-20');
    await entrar(b, 'A-20');
    await a.esperar(() => a.pill() === 'Sincronizado', 'A sincronizado');
    await b.esperar(() => b.pill() === 'Sincronizado', 'B sincronizado');
    await b.sinRed(true);
    await b.clic('a.btn', 'Iniciar auditoría');
    await capturar(b, { persona: 'Segundo Equipo', bajar: { 1: 1 } });
    await finalizarUI(b);
    await a.clic('a.btn', 'Iniciar auditoría');
    await capturar(a, { persona: 'Primer Equipo', bajar: { 3: 2 } });
    await finalizarUI(a);
    await a.esperar(() => a.pill() === 'Sincronizado', 'A envía primero');
    await b.sinRed(false);
    b.irA('#/inicio');
    await b.esperarTexto('ya la finalizó otro equipo', 20000);
    assert.match(b.texto(), /Primer Equipo/);
    const srv = await e.api('GET', '/api/auditorias/S01-A20', { token: e.admin });
    assert.equal(srv.json.persona_audita, 'Primer Equipo');
    // B conserva la versión ganadora
    b.irA('#/inicio');
    await b.clic('a.btn', 'Ver reporte');
    await b.esperarTexto('Primer Equipo');
    assert.ok(b.w.localStorage.getItem('a5s.fc.descartada.S01-A20'), 'la captura descartada queda guardada aparte');
  } finally { await a.cerrar(); await b.cerrar(); await e.close(); }
});

test('cambia la fecha: Pendiente → Atrasada, semana vigente y semáforo rojo', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-30');
    assert.match(eq.texto(), /Pendiente/);
    assert.doesNotMatch(eq.texto(), /Pendientes de semanas anteriores/);
    // pasa una semana y dos días
    process.env.FAKE_NOW = '2026-10-21T09:00:00';
    eq.irA('#/tablero');
    await eq.clic('button', 'Cerrar sesión').catch(() => {});
    await eq.w.close();
    const eq2 = await abrirEquipo(e.base);
    try {
      await entrar(eq2, 'A-30');
      await eq2.esperarTexto('Pendientes de semanas anteriores');
      assert.match(eq2.texto(), /Semana 2 de 35/);
      assert.match(eq2.texto(), /Semana 1: Área 31.*Atrasada/);
      eq2.irA('#/tablero');
      await eq2.clic('.tabs button', 'Acumulado');
      await eq2.esperarTexto('Como auditora');
      assert.match(eq2.texto(), /Área 30.*Rojo/);
      assert.match(eq2.texto(), /Auditorías programadas a la fecha/);
      assert.deepEqual(eq2.errores, []);
    } finally { await eq2.cerrar(); }
  } finally { process.env.FAKE_NOW = MIERCOLES_S1; await e.close(); }
});

test('administrador: la importación de archivo (avanzada) rechaza configuración inválida y, aparte, restablece PIN', async () => {
  const buena = configReal();
  const e = await entornoListo(buena);
  const eq = await abrirEquipo(e.base);
  try {
    await eq.clic('button', 'Soy administrador');
    await eq.esperar(() => eq.w.document.querySelector('input[type="password"]'), 'campo contraseña');
    eq.escribir(eq.w.document.querySelector('input[type="password"]'), 'mala');
    await eq.clic('button', 'Entrar como administrador');
    await eq.esperarTexto('Contraseña de administrador incorrecta');
    eq.escribir(eq.w.document.querySelector('input[type="password"]'), 'admin-test');
    await eq.clic('button', 'Entrar como administrador');
    await eq.esperarTexto('Administración');
    await eq.esperarTexto('Áreas (36 activas de 36)');
    await eq.clic('.tabs button', 'Servidor');
    await eq.esperar(() => eq.w.document.querySelector('input[type="file"]'), 'selector de archivo');

    const subir = (obj) => {
      const inp = eq.w.document.querySelector('input[type="file"]');
      Object.defineProperty(inp, 'files', { value: [{ text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) }], configurable: true });
    };
    subir('{esto no es json');
    await eq.clic('button', 'Importar configuración');
    await eq.esperarTexto('no es un JSON válido');
    const mala = configReal();
    mala.rotacion[3] = JSON.parse(JSON.stringify(mala.rotacion[0]));
    mala.checklists[2].puntos[0].p = 4;
    subir(mala);
    await eq.clic('button', 'Importar configuración');
    await eq.esperarTexto('se repite en las semanas 1 y 4');
    assert.match(eq.texto(), /CL-03.*suman 99/);
    subir(buena);
    await eq.clic('button', 'Importar configuración');
    await eq.esperarTexto('Configuración importada: 36 áreas, 12 checklists, 35 semanas');
    await eq.clic('.tabs button', 'Áreas y usuarios');

    // PIN: todas las áreas ya tienen (los puso el entorno); restablecer todos muestra la lista una sola vez
    await eq.clic('button', 'Restablecer todos');
    await eq.esperar(() => eq.w.document.querySelector('.overlay'), 'confirmación');
    await eq.clic('.overlay button', 'Restablecer todos');
    await eq.esperarTexto('se muestran una sola vez');
    const pins = [...eq.w.document.querySelectorAll('table.pins tbody tr')].map((tr) => tr.lastChild.textContent);
    assert.equal(pins.length, 36);
    assert.ok(pins.every((p) => /^\d{4}$/.test(p)));
    // el PIN generado funciona para entrar
    const l = await e.api('POST', '/api/login', { body: { area: 'A-01', pin: pins[0] } });
    assert.equal(l.status, 200);
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('las áreas no tienen la pestaña Datos; el administrador sí y desde ahí borra los datos locales', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-04');
    await eq.esperar(() => eq.pill() === 'Sincronizado', 'sincronizado');
    assert.ok(!eq.buscar('.nav a', 'Datos'), 'sin pestaña Datos para un área');
    eq.irA('#/datos');
    await eq.esperarTexto('Esta semana');
    assert.ok(!eq.texto().includes('Borrar datos locales'), 'un área no llega a la pantalla Datos');
    await eq.clic('.chip-area');
    await eq.clic('.overlay button', 'Continuar');
    await eq.clic('button', 'Soy administrador');
    await eq.esperar(() => eq.w.document.querySelector('input[type="password"]'), 'campo contraseña');
    eq.escribir(eq.w.document.querySelector('input[type="password"]'), 'admin-test');
    await eq.clic('button', 'Entrar como administrador');
    await eq.esperarTexto('Administración');
    assert.ok(eq.buscar('.nav a', 'Datos'), 'el administrador sí ve Datos');
    eq.irA('#/datos');
    await eq.esperarTexto('Borrar datos locales');
    await eq.clic('button', 'Borrar datos locales');
    await eq.esperar(() => eq.w.document.querySelector('.overlay'), 'diálogo');
    assert.match(eq.w.document.querySelector('.overlay').textContent, /ya está en el servidor/);
    await eq.clic('.overlay button', 'Sí, borrar datos locales');
    await eq.esperarTexto('Elige tu área');
    assert.equal(eq.w.localStorage.getItem('a5s.fc.cfg'), null);
    assert.equal(eq.w.localStorage.getItem('a5s.fc.session'), null);
    assert.ok(eq.w.localStorage.getItem('a5s.dev'), 'se conserva el ID del equipo');
  } finally { await eq.cerrar(); await e.close(); }
});

test('index.html es autocontenido: sin recursos externos ni alert/confirm/prompt', async () => {
  const fs = require('fs');
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg|schemas\.openxmlformats\.org\/)/i, 'sin URLs externas (CDN, fuentes); los espacios de nombres XML no se descargan');
  assert.doesNotMatch(html, /\b(alert|confirm|prompt)\s*\(/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /prefers-color-scheme: dark/, 'la app es solo de tema claro');
  assert.match(html, /env\(safe-area-inset-bottom\)/);
});

test('administrador: cambia la fecha de inicio del ciclo desde la pantalla', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await eq.clic('button', 'Soy administrador');
    await eq.esperar(() => eq.w.document.querySelector('input[type="password"]'), 'campo contraseña');
    eq.escribir(eq.w.document.querySelector('input[type="password"]'), 'admin-test');
    await eq.clic('button', 'Entrar como administrador');
    await eq.esperarTexto('Administración');
    await eq.clic('.tabs button', 'Ciclo y rotación');
    await eq.esperarTexto('Fecha de inicio del ciclo');
    const fecha = eq.w.document.querySelector('input[aria-label="Nueva fecha de inicio del ciclo"]');
    assert.equal(fecha.value, '2026-10-12');
    eq.escribir(fecha, '2026-10-21'); // miércoles
    await eq.esperarTexto('no es lunes');
    assert.match(eq.texto(), /La semana 1 comenzaría el 21 oct 2026/);
    await eq.clic('button', 'Cambiar fecha de inicio');
    await eq.esperarTexto('Inicio del ciclo cambiado a 21 oct 2026');
    assert.equal((await e.api('GET', '/api/config', { token: e.admin })).json.config.inicio, '2026-10-21');
    await eq.clic('.tabs button', 'Ciclo y rotación');
    await eq.esperarTexto('Hoy el ciclo inicia el 21 oct 2026');
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('instalación nueva: el administrador da de alta checklist, preguntas, áreas y cambia un PIN, todo desde la interfaz', async () => {
  const e = await iniciar(); // base vacía: sin importar ningún archivo
  const eq = await abrirEquipo(e.base);
  try {
    await eq.clic('button', 'Soy administrador');
    await eq.esperar(() => eq.w.document.querySelector('input[type="password"]'), 'campo contraseña');
    eq.escribir(eq.w.document.querySelector('input[type="password"]'), 'admin-test');
    await eq.clic('button', 'Entrar como administrador');
    await eq.esperarTexto('Primero crea al menos un checklist');

    // checklist con sus preguntas
    await eq.clic('.tabs button', 'Checklists y preguntas');
    await eq.clic('button', 'Nuevo checklist');
    await eq.esperarTexto('Nuevo checklist');
    const d = eq.w.document;
    eq.escribir(d.querySelector('input[aria-label="Código del checklist"]'), 'CL-T');
    eq.escribir(d.querySelector('input[aria-label="Nombre del checklist"]'), 'Checklist de prueba');
    eq.escribir(d.querySelector('textarea[aria-label="Preguntas para pegar, una por línea"]'), Array.from({ length: 20 }, (_, i) => `¿Pregunta número ${i + 1}?`).join('\n'));
    await eq.clic('button', 'Agregar a la lista');
    await eq.esperarTexto('Suma 100 / 100');
    // quitar una pregunta rompe la suma y el servidor lo rechaza con un mensaje claro
    await eq.clic('button', 'Quitar');
    await eq.esperarTexto('faltan 5');
    await eq.clic('button', 'Guardar checklist');
    await eq.esperarTexto('suman 95');
    await eq.clic('button', 'Agregar pregunta a Sostener');
    const valores = d.querySelectorAll('input[aria-label^="Valor de la pregunta"]');
    eq.escribir(valores[valores.length - 1], '5');
    const textos = d.querySelectorAll('textarea[aria-label^="Pregunta "]');
    eq.escribir(textos[textos.length - 1], '¿Pregunta de reemplazo?');
    await eq.esperarTexto('Suma 100 / 100');
    await eq.clic('button', 'Guardar checklist');
    await eq.esperarTexto('Checklist CL-T guardado');
    await eq.esperar(() => /CL-T.*Checklist de prueba.*20.*100/.test(eq.texto()), 'checklist en la lista');

    // áreas: se crean con su PIN y la rotación se genera sola
    const tokenAdmin = (await e.api('POST', '/api/login', { body: { admin: true, password: 'admin-test' } })).json.token;
    await e.api('PUT', '/api/config/inicio', { token: tokenAdmin, body: { inicio: '2026-10-12' } });
    await eq.clic('.tabs button', 'Áreas y usuarios');
    await eq.esperar(() => d.querySelector('input[aria-label="Nombre del área nueva 1"]'), 'formulario de áreas');
    eq.escribir(d.querySelector('input[aria-label="Nombre del área nueva 1"]'), 'Almacén');
    await eq.clic('button', '+ Agregar fila');
    await eq.clic('button', '+ Agregar fila');
    eq.escribir(d.querySelector('input[aria-label="Nombre del área nueva 2"]'), 'Línea 1');
    eq.escribir(d.querySelector('input[aria-label="Nombre del área nueva 3"]'), 'Oficinas');
    // una fila de más se puede quitar y las filas vacías se ignoran
    await eq.clic('button', '+ Agregar fila');
    await eq.clic('button[aria-label="Quitar la fila 4"]', 'Quitar');
    assert.equal(d.querySelectorAll('input[aria-label^="Nombre del área nueva"]').length, 3);
    await eq.clic('button', 'Guardar áreas');
    await eq.esperarTexto('3 área(s) creada(s) con su PIN');
    assert.match(eq.texto(), /Rotación generada: 2 semanas para 3 áreas activas/);
    const pins = [...d.querySelectorAll('table.pins tbody tr')].map((tr) => tr.lastChild.textContent);
    assert.equal(pins.length, 3);
    assert.ok(pins.every((p) => /^\d{4}$/.test(p)));
    assert.equal((await e.api('GET', '/api/areas')).json.areas.length, 3);

    // el administrador cambia la contraseña de un área
    const campo = await eq.esperar(() => d.querySelector('input[aria-label="Nuevo PIN para Línea 1"]'), 'campo de PIN');
    eq.escribir(campo, '654321');
    [...campo.closest('tr').querySelectorAll('button')].find((b) => b.textContent.includes('Cambiar PIN') || b.textContent.includes('Poner PIN')).click();
    await eq.esperarTexto('PIN de A-02 guardado');
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-02', pin: pins[1] } })).status, 401, 'el PIN anterior ya no sirve');
    assert.equal((await e.api('POST', '/api/login', { body: { area: 'A-02', pin: '654321' } })).status, 200);

    // un equipo de piso entra con el PIN nuevo y ve su auditoría
    const piso = await abrirEquipo(e.base);
    try {
      await piso.elegirArea('A-02');
      await piso.esperar(() => piso.w.document.querySelector('input.pin'), 'PIN');
      piso.escribir(piso.w.document.querySelector('input.pin'), '654321');
      await piso.clic('button', 'Entrar');
      await piso.esperarTexto('Debes auditar');
      assert.deepEqual(piso.errores, []);
    } finally { await piso.cerrar(); }
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('lobby: entra con su contraseña y solo ve el dashboard con el semáforo de las áreas', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    assert.equal((await e.api('PUT', '/api/lobby/password', { token: e.admin, body: { password: 'lobby-ui' } })).status, 200);
    // A-04 ya hizo su auditoría
    const cl05 = configReal().checklists.find((c) => c.codigo === 'CL-05');
    const put = await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: {
      estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '1234567', dispositivo: 'd',
      respuestas: cl05.puntos.map((p) => ({ n: p.n, puntos: p.p })),
    } });
    assert.equal(put.status, 200, put.texto);

    await eq.clic('button', 'Pantalla lobby');
    await eq.esperar(() => eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'campo de contraseña');
    eq.escribir(eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'mala');
    await eq.clic('button', 'Entrar al dashboard');
    await eq.esperarTexto('Contraseña de lobby incorrecta');
    eq.escribir(eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'lobby-ui');
    await eq.clic('button', 'Entrar al dashboard');
    await eq.esperar(() => eq.w.document.querySelectorAll('.lobby-tbl tbody tr').length === 36, 'una fila por área');
    assert.doesNotMatch(eq.texto(), /null|undefined/, 'el dashboard de lobby no debe mostrar "null"');
    assert.match(eq.texto(), /1 de 36/);
    const d = eq.w.document;
    // columnas = semanas del año del mes elegido (octubre 2026: semanas 42, 43 y 44)
    const heads = [...d.querySelectorAll('.lobby-tbl th.col-sem')].map((th) => th.querySelector('.sem-n').textContent);
    assert.deepEqual(heads, ['Semana 42', 'Semana 43', 'Semana 44']);
    assert.equal(d.querySelector('select[aria-label="Valor del periodo"]').value, '2026-10');
    const fila = (nombre) => [...d.querySelectorAll('.lobby-tbl tbody tr')].find((tr) => tr.querySelector('th').textContent === nombre);
    const luces = (nombre) => [...fila(nombre).querySelectorAll('.luz')].map((s) => s.className.replace('luz ', ''));
    assert.deepEqual(luces('Área 4'), ['ok', 'mute', 'mute'], 'hecha esta semana; las siguientes aún no inician');
    assert.deepEqual(luces('Área 10'), ['warn', 'mute', 'mute'], 'pendiente en plazo');
    assert.equal(d.querySelectorAll('.lobby-tbl tbody tr:first-child .luz').length, 3);
    // calificación que recibió cada área: junto al semáforo de la semana y en la columna "Recibido"
    assert.ok(d.querySelector('.lobby-tbl th.col-rec'), 'columna Recibido');
    const celdaA5 = [...d.querySelectorAll('.lobby-tbl tbody tr')].find((tr) => tr.querySelector('th').textContent === 'Área 5');
    assert.match(celdaA5.querySelector('td.celda').textContent, /5S 100\.0/, 'Área 5 recibió 5S (100.0) esta semana');
    assert.match(celdaA5.querySelector('td.col-rec').textContent, /5S 100\.0/);
    assert.match(fila('Área 4').querySelector('td.col-rec').textContent, /—/, 'sin calificación recibida todavía');
    assert.match(eq.texto(), /Calificación que recibió el área/);
    // cambiar de mes desde el encabezado
    const sel = d.querySelector('select[aria-label="Valor del periodo"]');
    sel.value = '2026-11'; sel.dispatchEvent(new eq.w.Event('change', { bubbles: true }));
    await eq.esperar(() => d.querySelectorAll('.lobby-tbl th.col-sem').length === 4, 'columnas de noviembre');
    assert.deepEqual([...d.querySelectorAll('.lobby-tbl th.col-sem .sem-n')].map((x) => x.textContent), ['Semana 45', 'Semana 46', 'Semana 47', 'Semana 48']);
    assert.ok([...d.querySelectorAll('.lobby-tbl tbody .luz')].every((s) => s.classList.contains('mute')), 'semanas futuras en gris');
    d.querySelector('button[aria-label="Periodo anterior"]').click();
    await eq.esperar(() => d.querySelector('select[aria-label="Valor del periodo"]').value === '2026-10', 'mes anterior');
    // filtro anual: todas las semanas del año en columnas compactas
    await eq.clic('.seg-filtro button', 'Anual');
    await eq.esperar(() => d.querySelectorAll('.lobby-tbl th.col-sem').length === 12, 'columnas del año 2026 (semanas 42 a 53)');
    assert.ok(d.querySelector('.lobby-tbl table.compacta'));
    // filtro semanal: una sola columna
    await eq.clic('.seg-filtro button', 'Semanal');
    await eq.esperar(() => d.querySelectorAll('.lobby-tbl th.col-sem').length === 1, 'una semana');
    // sin navegación a otras secciones ni capturas
    assert.equal(eq.w.document.querySelector('nav.nav'), null);
    assert.equal(eq.buscar('a, button', 'Iniciar auditoría'), null);
    // aunque intente ir a otra ruta, vuelve al dashboard
    eq.irA('#/tablero');
    await eq.esperar(() => eq.w.location.hash === '#/lobby', 'regreso al lobby');
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('lobby: el botón lleva al dashboard ejecutivo con métricas, gráfica y vista de tabla', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    assert.equal((await e.api('PUT', '/api/lobby/password', { token: e.admin, body: { password: 'lobby-ui' } })).status, 200);
    const cl05 = configReal().checklists.find((c) => c.codigo === 'CL-05');
    const put = await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: {
      estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '1234567', dispositivo: 'd',
      respuestas: cl05.puntos.map((p) => (p.n === 2 ? { n: p.n, puntos: 3, hallazgo: 'h', accion: 'a' } : { n: p.n, puntos: p.p })),
    } });
    assert.equal(put.status, 200, put.texto);

    await eq.clic('button', 'Pantalla lobby');
    await eq.esperar(() => eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'campo de contraseña');
    eq.escribir(eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'lobby-ui');
    await eq.clic('button', 'Entrar al dashboard');
    await eq.esperar(() => eq.w.document.querySelectorAll('.lobby-tbl tbody tr').length === 36, 'tabla del lobby');
    await eq.clic('a', 'Dashboard ejecutivo');
    await eq.esperarTexto('Dashboard ejecutivo');
    const d = eq.w.document;
    await eq.esperar(() => d.querySelector('.kpis-ejec'), 'indicadores');
    assert.doesNotMatch(eq.texto(), /null|undefined/, 'el dashboard ejecutivo no debe mostrar "null"');
    const kp = [...d.querySelectorAll('.kpis-ejec .kpi')].map((k) => k.querySelector('.l').textContent + '=' + k.querySelector('.v').textContent);
    assert.ok(kp.includes('Cumplimiento de auditorías=100%'), kp.join(' | '));
    assert.ok(kp.includes('Nivel promedio de la planta=5S'), kp.join(' | '));
    assert.match(eq.texto(), /promedio 98\.0/, 'la calificación va chica junto al nivel');
    assert.ok(!kp.some((x) => /Calificación promedio/.test(x)), 'ya no se muestra la calificación promedio de 0 a 100 como indicador');
    assert.ok(kp.includes('Auditorías realizadas=1 de 36'), kp.join(' | '));
    assert.ok(kp.includes('Áreas activas=36'), kp.join(' | '));
    // gráfica de tendencia: dos series, leyenda y etiquetas directas
    assert.ok(d.querySelector('.ch svg path.ch-l1'), 'serie 1');
    assert.ok(d.querySelector('.ch svg path.ch-l2'), 'serie 2');
    assert.equal(d.querySelectorAll('.ch-leg .ley').length, 2);
    assert.match(d.querySelector('.ch svg').textContent, /Cumplimiento 100/);
    assert.deepEqual([...d.querySelectorAll('.periodo-ctl .seg-filtro button')].map((b) => b.textContent), ['Semanal', 'Mensual', 'Anual', 'Ciclo']);
    await eq.clic('.periodo-ctl .seg-filtro button', 'Mensual');
    await eq.esperarTexto('Octubre 2026');
    await eq.esperar(() => d.querySelector('.kpis-ejec'), 'indicadores del mes');
    assert.match(eq.texto(), /Distribución de auditorías por nivel 5S/);
    assert.match(eq.texto(), /Desempeño de la planta en cada S/);
    assert.match(eq.texto(), /Promedio de la planta\s*5S 98\.0/);
    // resultados por S en nivel (1S a 5S) con el porcentaje chico, no en puntos de 0 a 100
    const filasS = [...d.querySelectorAll('.hb-row')].map((r) => r.textContent.replace(/\s+/g, ' '));
    assert.ok(filasS.some((f) => /^Ordenar[1-5]S \d+(\.\d)?%/.test(f)), filasS.join(' | '));
    assert.ok(!filasS.some((f) => /\d+(\.\d)? \/ \d+/.test(f)), 'ya no se muestran puntos "x / y"');
    const luces = [...d.querySelectorAll('.kpis-luz .kpi')].map((k) => k.textContent.replace(/\s+/g, ' ').trim());
    assert.match(luces[0], /1s*Áreas al corriente/);
    assert.match(luces[1], /35s*Áreas con auditoría pendiente en plazo/);
    assert.match(eq.texto(), /Puntos del checklist con menor cumplimiento/);
    // vista de tabla de la gráfica
    await eq.clic('button', 'Ver como tabla');
    assert.equal(d.querySelector('.ch').hidden, true);
    const filasTabla = [...d.querySelectorAll('.tbl-wrap')].find((w) => !w.hidden && w.querySelector('th') && w.textContent.includes('Cumplimiento') && w.textContent.includes('Nivel') && w.textContent.includes('Asignadas'));
    assert.ok(filasTabla, 'tabla de la tendencia visible');
    assert.match(filasTabla.textContent, /S42/);
    // volver al semáforo
    await eq.clic('a', 'Semáforo por área');
    await eq.esperar(() => d.querySelectorAll('.lobby-tbl tbody tr').length === 36, 'regreso a la tabla');
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('auditoría: la fecha no se edita, los hallazgos son obligatorios y el tiempo de captura solo lo ve el administrador', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  const adm = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-04');
    await eq.clic('a.btn', 'Iniciar auditoría');
    const d = eq.w.document;
    await eq.esperar(() => d.querySelector('.item'), 'puntos');
    // la fecha es de solo lectura y muestra el día de hoy
    const fecha = d.querySelector('input[aria-readonly="true"]');
    assert.equal(fecha.readOnly, true);
    assert.match(fecha.value, /14 oct 2026/);
    assert.equal(d.querySelector('input[type="date"]'), null, 'no hay campo de fecha editable');

    // punto 2 con 3 de 5 pero sin hallazgo ni acción: no se puede continuar
    await capturar(eq, { bajar: { 2: 3 }, hallazgos: false });
    const boton = () => d.querySelector('.footer-act .btn.primary');
    assert.equal(boton().disabled, true);
    assert.match(d.querySelector('.footer-act').textContent, /falta el hallazgo en 1 punto \(2\)/);
    const [taH, taA] = d.querySelectorAll('.item[data-n="2"] textarea');
    assert.ok(taH.classList.contains('falta'), 'hallazgo marcado como faltante');
    assert.ok(!taA.classList.contains('falta'), 'la acción correctiva no es obligatoria');
    assert.equal(taH.required, true);
    assert.equal(taA.required, false);
    assert.match(d.querySelector('.item[data-n="2"]').textContent, /Hallazgo \(obligatorio\)/);
    assert.match(d.querySelector('.item[data-n="2"]').textContent, /Acción correctiva \(opcional\)/);
    // con el hallazgo basta: la acción correctiva es opcional
    eq.escribir(taH, 'Material fuera de su lugar');
    assert.equal(boton().disabled, false);
    assert.ok(!taH.classList.contains('falta'));
    // un punto en máximo nunca exige hallazgo
    assert.equal(d.querySelector('.item[data-n="1"] .hall').classList.contains('hidden'), true);
    await finalizarUI(eq);
    assert.match(eq.texto(), /Reporte de auditoría 5S/);
    assert.doesNotMatch(eq.texto(), /tiempo de captura|duración/i, 'la auditora no ve el tiempo');
    await eq.esperar(() => eq.pill() === 'Sincronizado', 'sincronizado');

    // el servidor lo guardó: la fecha es la de hoy y el tiempo existe, pero solo el administrador lo recibe
    const comoArea = await e.api('GET', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04') });
    assert.equal(comoArea.json.fecha, '2026-10-14');
    assert.ok(!('duracion_seg' in comoArea.json));
    const comoAdmin = await e.api('GET', '/api/auditorias/S01-A04', { token: e.admin });
    assert.equal(typeof comoAdmin.json.duracion_seg, 'number');
    assert.ok(comoAdmin.json.duracion_seg >= 0 && comoAdmin.json.duracion_seg < 600);

    // el administrador lo ve en su pestaña
    await adm.clic('button', 'Soy administrador');
    await adm.esperar(() => adm.w.document.querySelector('input[type="password"]'), 'campo contraseña');
    adm.escribir(adm.w.document.querySelector('input[type="password"]'), 'admin-test');
    await adm.clic('button', 'Entrar como administrador');
    await adm.esperarTexto('Administración');
    await adm.clic('.tabs button', 'Tiempos de captura');
    await adm.esperarTexto('exclusivo del administrador');
    await adm.esperar(() => /S01-A04/.test(adm.texto()), 'la auditoría en la tabla de tiempos');
    assert.match(adm.texto(), /Tiempo promedio/);
    assert.match(adm.texto(), /Semanal.*Mensual.*Anual.*Ciclo/, 'filtro de periodo en el dashboard del administrador');
    assert.deepEqual(eq.errores, []);
    assert.deepEqual(adm.errores, []);
  } finally { await eq.cerrar(); await adm.cerrar(); await e.close(); }
});

test('el tablero y el dashboard ejecutivo traen el filtro semanal, mensual, anual y de ciclo', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await entrar(eq, 'A-04');
    eq.irA('#/tablero');
    await eq.clic('.tabs button', 'Acumulado');
    await eq.esperarTexto('Como auditora');
    const d = eq.w.document;
    await eq.esperar(() => d.querySelector('.periodo-ctl'), 'filtro de periodo');
    assert.deepEqual([...d.querySelectorAll('.periodo-ctl .seg-filtro button')].map((b) => b.textContent), ['Semanal', 'Mensual', 'Anual', 'Ciclo']);
    await eq.clic('.periodo-ctl .seg-filtro button', 'Anual');
    await eq.esperar(() => d.querySelector('select[aria-label="Valor del periodo"]') && d.querySelector('select[aria-label="Valor del periodo"]').value === '2026', 'año 2026');
    assert.match(eq.texto(), /Auditorías programadas a la fecha/);
    await eq.clic('.periodo-ctl .seg-filtro button', 'Semanal');
    await eq.esperar(() => /Semana 42/.test(d.querySelector('select[aria-label="Valor del periodo"]').selectedOptions[0].textContent), 'semana 42');
    // los botones no cambian de lugar al elegir otra opción: misma estructura en Semanal, Mensual, Anual y Ciclo
    const estructura = () => {
      const ctl = d.querySelector('.periodo-ctl');
      return [...ctl.children].map((x) => x.className).join('|') + '#' + [...ctl.querySelectorAll('.seg-filtro button')].map((b) => b.textContent).join(',')
        + '#' + ctl.querySelectorAll('.periodo-valor > *').length;
    };
    const base = estructura();
    for (const modo of ['Mensual', 'Anual', 'Ciclo', 'Semanal']) {
      await eq.clic('.periodo-ctl .seg-filtro button', modo);
      await eq.esperar(() => d.querySelector('.seg-filtro button[aria-pressed="true"]') && d.querySelector('.seg-filtro button[aria-pressed="true"]').textContent === modo, 'modo ' + modo);
      assert.equal(estructura(), base, 'la estructura del filtro no cambia en ' + modo);
    }
    await eq.clic('.periodo-ctl .seg-filtro button', 'Ciclo');
    await eq.esperar(() => d.querySelector('.periodo-valor select').disabled === true, 'lista deshabilitada en Ciclo');
    assert.ok([...d.querySelectorAll('.periodo-valor button')].every((b) => b.disabled), 'flechas deshabilitadas en Ciclo');
    assert.match(d.querySelector('.periodo-valor select').textContent, /Todo el ciclo/);
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('barra superior de los dashboards: una sola fila y tabla con desplazamiento interno', async () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // la barra nunca se parte en dos filas: no hay áreas de cuadrícula de dos renglones para .barra-dash
  assert.doesNotMatch(html, /grid-template-areas:\s*"marca acc"/);
  assert.match(html, /\.top\.barra-dash \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(html, /\.barra-dash \.lbl \{ display: none; \}/, 'los botones se compactan en vez de pasar a otra fila');
  // la tabla se desplaza por dentro y no ensancha la página
  assert.match(html, /\.lobby-tbl \{ max-width: 100%; max-height: calc\(100dvh - 156px\);[^}]*overflow: auto;/);
  assert.match(html, /\.shell \{ grid-template-columns: minmax\(0, 1fr\); \}/);

  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    await e.api('PUT', '/api/lobby/password', { token: e.admin, body: { password: 'lobby-ui' } });
    await eq.clic('button', 'Pantalla lobby');
    await eq.esperar(() => eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'campo de contraseña');
    eq.escribir(eq.w.document.querySelector('input[aria-label="Contraseña de lobby"]'), 'lobby-ui');
    await eq.clic('button', 'Entrar al dashboard');
    await eq.esperar(() => eq.w.document.querySelector('.barra-dash'), 'barra superior');
    const barra = eq.w.document.querySelector('.barra-dash');
    assert.deepEqual([...barra.children].map((x) => x.className), ['brand', 'ctl-slot', 'acciones'], 'tres bloques en una sola fila');
    // el ciclo completo (35 semanas) cabe en una tabla con desplazamiento interno
    await eq.clic('.periodo-ctl .seg-filtro button', 'Ciclo');
    await eq.esperar(() => eq.w.document.querySelectorAll('.lobby-tbl th.col-sem').length === 35, '35 columnas');
    assert.ok(eq.w.document.querySelector('.lobby-tbl table.compacta'));
    assert.equal(eq.w.document.querySelectorAll('.barra-dash').length, 1);
    // el lobby ocupa la pantalla y solo se desplaza la tabla (un único scroll); al salir se restablece
    assert.ok(eq.w.document.documentElement.classList.contains('pantalla'));
    assert.ok(eq.w.document.querySelector('.shell.pantalla .tabla-caja .lobby-tbl'));
    await eq.clic('a', 'Dashboard ejecutivo');
    await eq.esperar(() => eq.w.document.querySelector('.ejec'), 'vista del dashboard ejecutivo');
    assert.ok(!eq.w.document.documentElement.classList.contains('pantalla'), 'el dashboard ejecutivo sí se desplaza con la página');
    assert.deepEqual(eq.errores, []);
  } finally { await eq.cerrar(); await e.close(); }
});

test('cumplimiento y calificación por mes: dos columnas por área (cumplimiento y calificación) con selector de mes y vista de tabla, con botón para regresar', async () => {
  const e = await entornoListo(configReal());
  const eq = await abrirEquipo(e.base);
  try {
    const cl05 = configReal().checklists.find((c) => c.codigo === 'CL-05');
    const put = await e.api('PUT', '/api/auditorias/S01-A04', { token: await e.tokenDe('A-04'), body: {
      estado: 'final', persona_audita: 'Ana', responsable: 'Luis', nomina_auditado: '1234567', dispositivo: 'd',
      respuestas: cl05.puntos.map((p) => ({ n: p.n, puntos: p.p })),
    } });
    assert.equal(put.status, 200, put.texto);
    await eq.clic('button', 'Soy administrador');
    await eq.esperar(() => eq.w.document.querySelector('input[type="password"]'), 'campo contraseña');
    eq.escribir(eq.w.document.querySelector('input[type="password"]'), 'admin-test');
    await eq.clic('button', 'Entrar como administrador');
    await eq.esperarTexto('Administración');
    eq.w.location.hash = '#/mensual';
    const d = eq.w.document;
    await eq.esperar(() => d.querySelectorAll('.ch svg').length === 1, 'la gráfica');
    assert.ok(d.querySelectorAll('.ch svg rect.ap-c').length > 0, 'columnas de cumplimiento');
    assert.ok(d.querySelectorAll('.ch svg rect.ap-k').length > 0, 'columnas de calificación junto a las de cumplimiento');
    assert.doesNotMatch(eq.texto(), /null|undefined/);
    assert.equal(d.querySelectorAll('.ch-leg .ley').length, 2, 'leyenda de las dos variables');
    await eq.clic('button', 'Ver como tabla');
    assert.ok(!d.querySelector('table').closest('[hidden]'), 'la tabla se muestra');
    await eq.clic('a', 'Tablero');
    await eq.esperarTexto('Tablero de cumplimiento');
  } finally { await eq.cerrar(); await e.close(); }
});
