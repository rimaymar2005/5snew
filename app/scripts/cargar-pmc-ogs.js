'use strict';
// Carga a la planta PMC los checklists, áreas y subcategorías de seed/pmc-ogs.json usando la API de administración.
// Uso: ADMIN_PASSWORD=... node scripts/cargar-pmc-ogs.js [http://localhost:3000] [salida-pines.txt]
const fs = require('fs');
const path = require('path');
const base = `${process.argv[2] || 'http://localhost:3000'}/pmc/api`;
const salida = process.argv[3] || path.join(__dirname, '..', 'pmc-pines.txt');
const OFICINA = new Set(['IT', 'Finanzas', 'RH', 'GTM', 'EHS', 'CI', 'Proyectos', 'Ingeniería']);
const datos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'pmc-ogs.json'), 'utf8'));

async function api(metodo, url, body, token) {
  const r = await fetch(base + url, { method: metodo, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${metodo} ${url} → ${r.status}: ${j.error || ''} ${(j.errores || []).slice(0, 3).join(' | ')}`);
  return j;
}

(async () => {
  const { token } = await api('POST', '/login', { admin: true, password: process.env.ADMIN_PASSWORD });
  const resumen = await api('GET', '/admin/resumen', null, token);
  if (resumen.areas.length) throw new Error(`PMC ya tiene ${resumen.areas.length} áreas; no se carga encima.`);
  for (const c of datos.checklists) await api('POST', '/checklists', c, token);
  const lista = datos.areas.map((a) => ({ nombre: a.nombre, checklist: OFICINA.has(a.nombre) ? 'OGS-OFI' : 'OGS-PISO' }));
  const r = await api('POST', '/areas', { areas: lista }, token);
  const pines = [];
  for (const a of r.areas) {
    const origen = datos.areas.find((x) => x.nombre === a.nombre);
    await api('PUT', `/areas/${a.id}/subareas`, { subareas: origen.subareas }, token);
    pines.push(`${a.id}\t${a.nombre}\t${a.checklist}\tPIN ${a.pin}`);
  }
  fs.writeFileSync(salida, pines.join('\n') + '\n');
  console.log(`${r.areas.length} áreas, ${datos.areas.reduce((n, a) => n + a.subareas.length, 0)} subcategorías. PIN en ${salida}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
