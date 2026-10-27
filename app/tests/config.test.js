'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validarConfig } = require('../server/configImport');
const { configReal } = require('./helpers');
const ejemplo = require('../seed/ejemplo-config.json');

const clon = (o) => JSON.parse(JSON.stringify(o));

test('acepta la configuración de ejemplo', () => {
  const v = validarConfig(ejemplo);
  assert.deepEqual(v.errores, []);
  assert.equal(v.ok, true);
});

test('acepta una configuración con la estructura real (36 áreas, 12 checklists, 35 semanas)', () => {
  const cfg = configReal();
  assert.equal(cfg.areas.length, 36);
  assert.equal(cfg.checklists.length, 12);
  assert.equal(cfg.rotacion.length, 35);
  assert.deepEqual(validarConfig(cfg).errores, []);
});

test('el seed real, si existe localmente, es válido', () => {
  let real;
  try { real = require('../5S_configuracion.json'); } catch { return; }
  assert.deepEqual(validarConfig(real).errores, []);
});

test('rechaza pareja auditora-auditada repetida', () => {
  const cfg = configReal();
  cfg.rotacion[5] = clon(cfg.rotacion[0]); // semana 6 repite la semana 1
  const v = validarConfig(cfg);
  assert.equal(v.ok, false);
  assert.match(v.errores.join('\n'), /se repite en las semanas 1 y 6/);
});

test('rechaza que un área se audite a sí misma', () => {
  const cfg = configReal();
  const fila = cfg.rotacion[2];
  const k = fila.indexOf(0); // quien audita al área 0
  [fila[0], fila[k]] = [fila[k], fila[0]];
  fila[0] = 0;
  const v = validarConfig(cfg);
  assert.equal(v.ok, false);
  assert.match(v.errores.join('\n'), /se audita a sí misma/);
});

test('rechaza una semana que no es permutación (dos auditoras para la misma área)', () => {
  const cfg = configReal();
  cfg.rotacion[0][3] = cfg.rotacion[0][4];
  assert.match(validarConfig(cfg).errores.join('\n'), /más de un área/);
});

test('rechaza checklist cuyos puntos no suman 100', () => {
  const cfg = configReal();
  cfg.checklists[4].puntos[0].p = 4;
  const v = validarConfig(cfg);
  assert.equal(v.ok, false);
  assert.match(v.errores.join('\n'), /CL-05.*suman 99/);
});

test('rechaza área que apunta a un checklist inexistente', () => {
  const cfg = configReal();
  cfg.areas[7].checklist = 'CL-99';
  assert.match(validarConfig(cfg).errores.join('\n'), /A-08.*CL-99/);
});

test('rechaza esquema, umbrales y estructura inválidos', () => {
  assert.equal(validarConfig(null).ok, false);
  const cfg = configReal();
  cfg.schema = 'otro';
  cfg.checklists[0].umbrales = [90, 80, 70, 60];
  cfg.rotacion[1].pop();
  const t = validarConfig(cfg).errores.join('\n');
  assert.match(t, /schema/);
  assert.match(t, /umbrales/);
  assert.match(t, /semana 2: debe tener 36/);
});

test('no fija número de áreas, checklists ni semanas', () => {
  // ejemplo: 4 áreas, 2 checklists, 3 semanas
  assert.equal(ejemplo.areas.length, 4);
  assert.equal(validarConfig(ejemplo).ok, true);
});

test("acepta un checklist en escala 0–5 (escala: 5, todas valen 5) aunque no sume 100", () => {
  const cfg = configReal();
  cfg.checklists[4].puntos = cfg.checklists[4].puntos.slice(0, 14).map((p) => ({ ...p, p: 5 }));
  assert.equal(validarConfig(cfg).ok, false); // sin la marca "escala" sigue exigiendo 100
  cfg.checklists[4].escala = 5;
  assert.equal(validarConfig(cfg).ok, true, validarConfig(cfg).errores.join('\n'));
});
