'use strict';
// Utilidades de prueba: configuración con la ESTRUCTURA real (36 áreas, 12 checklists, 35 semanas)
// pero con textos ficticios, y un cliente HTTP mínimo.
const crypto = require('crypto');
const http = require('http');
const mysql = require('mysql2/promise');
const { createMulti } = require('../server/multi');

// Las pruebas usan una base temporal por prueba en un MariaDB/MySQL (por omisión el contenedor mariadb104 de
// Podman, puerto 3307). Se configura con TEST_DB_HOST / TEST_DB_PORT / TEST_DB_USER / TEST_DB_PASSWORD
// (usuario con permiso para crear bases).
const DB_ADMIN = {
  host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.TEST_DB_PORT) || 3307,
  user: process.env.TEST_DB_USER || 'root', password: process.env.TEST_DB_PASSWORD || 'root',
};
async function conAdmin(fn) {
  const c = await mysql.createConnection(DB_ADMIN);
  try { return await fn(c); } finally { await c.end(); }
}
async function crearBaseTemporal() {
  const nombre = `a5s_test_${crypto.randomBytes(5).toString('hex')}`;
  await conAdmin((c) => c.query(`CREATE DATABASE \`${nombre}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`));
  return { nombre, borrar: () => conAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${nombre}\``)) };
}

const S = ['Seleccionar', 'Ordenar', 'Limpiar', 'Estandarizar', 'Sostener'];
const FIRMA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// [codigo, nombre, [porS], tipo de valores, umbrales]
const CL = [
  ['CL-01', 'Racks CEDIS', [4, 5, 4, 4, 3], 'x5', [51, 72, 88, 95]],
  ['CL-02', 'Cuarentena', [6, 6, 4, 3, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-03', 'Inspección Final', [4, 5, 4, 6, 3], { 18: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-04', 'Mantenimiento', [6, 5, 4, 4, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-05', 'Oficinas', [5, 6, 5, 3, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-06', 'Oficinas Almacén', [6, 5, 5, 3, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-07', 'Producción', [6, 5, 5, 3, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-08', 'Producción CEDIS', [5, 6, 4, 4, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-09', 'Prototipos', [5, 6, 4, 4, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-10', 'Racks', [6, 5, 4, 4, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-11', 'Técnicos de Calidad', [6, 5, 4, 4, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]],
  ['CL-12', 'Recibo', [4, 5, 4, 4, 3], 'x5', [51, 72, 89, 95]],
];

// checklist de cada área, en orden A-01..A-36
const AREA_CL = [
  'CL-01', 'CL-02', 'CL-03', 'CL-04', 'CL-05', 'CL-05', 'CL-05', 'CL-05', 'CL-05', 'CL-05', 'CL-05', 'CL-05', 'CL-05', 'CL-05',
  'CL-06', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07', 'CL-07',
  'CL-08', 'CL-09', 'CL-10', 'CL-10', 'CL-10', 'CL-10', 'CL-11', 'CL-12',
];

function configReal() {
  const checklists = CL.map(([codigo, nombre, porS, valores, umbrales]) => {
    const puntos = [];
    let n = 0;
    porS.forEach((cant, i) => {
      for (let k = 0; k < cant; k++) {
        n += 1;
        puntos.push({ n, s: S[i], q: `Punto ficticio ${n}`, p: valores === 'x5' ? 5 : (valores[n] ?? 5) });
      }
    });
    return { codigo, nombre, formato: 'FMC-15 Rev. 3', umbrales, puntos };
  });
  const areas = AREA_CL.map((checklist, i) => ({ id: `A-${String(i + 1).padStart(2, '0')}`, nombre: `Área ${i + 1}`, checklist }));
  const n = areas.length;
  const rotacion = [];
  for (let w = 1; w < n; w++) rotacion.push(areas.map((_, a) => (a + w) % n)); // 35 semanas, sin repetir parejas
  return { schema: 'a5s-config-1', nombre: 'Prueba', inicio: '2026-10-12', dias: 6, areas, checklists, rotacion };
}

// Respuestas de un checklist; fn(punto) -> puntos obtenidos (por omisión, el máximo)
function respuestas(cfg, codigo, fn = (p) => p.p) {
  const c = cfg.checklists.find((x) => x.codigo === codigo);
  return c.puntos.map((p) => {
    const pts = fn(p);
    return pts < p.p ? { n: p.n, puntos: pts, hallazgo: `Hallazgo ${p.n}`, accion: `Acción ${p.n}` } : { n: p.n, puntos: pts };
  });
}

async function iniciar(opts = {}) {
  // opts.base: base ya creada (se conserva al cerrar); si no, se crea una temporal y se borra al cerrar
  const temporal = opts.base ? null : await crearBaseTemporal();
  const nombreBase = opts.base ? opts.base.nombre : temporal.nombre;
  const { app, instancias, close: cerrarApp } = await createMulti({
    plantas: { fc: { nombre: 'FC', conexion: { ...DB_ADMIN, database: nombreBase }, adminCorreos: opts.adminCorreos || [] } }, correo: opts.correo, adminPassword: 'admin-test', jwtSecret: 'secreto-de-prueba', trustProxy: 'false',
  });
  const server = await new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); });
  const db = instancias.fc.db;
  const base = `http://127.0.0.1:${server.address().port}`;
  const PLANTA = '/fc'; // las pruebas ejercen la planta FC; la API de cada planta vive bajo /<planta>
  async function api(method, ruta, { token, body, headers } = {}) {
    const r = await fetch(base + (ruta.startsWith('/api') ? PLANTA : '') + ruta, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* no es JSON */ }
    return { status: r.status, json, texto, headers: r.headers };
  }
  return {
    base, api, db, nombreBase, instancias,
    close: () => new Promise((res) => server.close(async () => { await cerrarApp(); if (temporal) await temporal.borrar(); res(); })),
  };
}

// Inicia el servidor, importa la configuración y crea PIN 1234 en todas las áreas.
async function entornoListo(cfg = configReal(), opts = {}) {
  const e = await iniciar(opts);
  const admin = (await e.api('POST', '/api/login', { body: { admin: true, password: 'admin-test' } })).json.token;
  const imp = await e.api('PUT', '/api/config', { token: admin, body: cfg });
  if (imp.status !== 200) throw new Error(`Importación falló: ${imp.texto}`);
  for (const a of cfg.areas) await e.api('PUT', `/api/usuarios/${a.id}/pin`, { token: admin, body: { pin: '1234' } });
  const tokens = {};
  e.tokenDe = async (area) => {
    if (!tokens[area]) tokens[area] = (await e.api('POST', '/api/login', { body: { area, pin: '1234' } })).json.token;
    return tokens[area];
  };
  e.admin = admin;
  e.cfg = cfg;
  return e;
}

module.exports = { configReal, respuestas, iniciar, entornoListo, crearBaseTemporal, FIRMA, CL };
