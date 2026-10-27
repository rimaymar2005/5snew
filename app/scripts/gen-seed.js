'use strict';
// Genera seed/ejemplo-config.json con datos FICTICIOS (no contiene texto de los checklists reales).
const fs = require('fs');
const S = ['Seleccionar', 'Ordenar', 'Limpiar', 'Estandarizar', 'Sostener'];

function checklist(codigo, nombre, porS, valores, umbrales) {
  const puntos = [];
  let n = 0;
  porS.forEach((cant, i) => {
    for (let k = 1; k <= cant; k++) {
      n += 1;
      puntos.push({ n, s: S[i], q: `Punto ficticio ${n} de ${S[i]} (${codigo})`, p: valores[n] ?? 5 });
    }
  });
  return { codigo, nombre, formato: 'FMC-15 Rev. 3 (ejemplo)', umbrales, puntos };
}

const cfg = {
  schema: 'a5s-config-1',
  nombre: 'Auditorías 5S (ejemplo)',
  inicio: '2026-10-12',
  dias: 6,
  areas: [
    { id: 'A-01', nombre: 'Almacén de ejemplo', checklist: 'CL-01' },
    { id: 'A-02', nombre: 'Línea de ejemplo 1', checklist: 'CL-02' },
    { id: 'A-03', nombre: 'Línea de ejemplo 2', checklist: 'CL-02' },
    { id: 'A-04', nombre: 'Oficina de ejemplo', checklist: 'CL-02' },
  ],
  checklists: [
    checklist('CL-01', 'Racks (ejemplo, 20 puntos)', [4, 5, 4, 4, 3], {}, [51, 72, 89, 95]),
    checklist('CL-02', 'Producción (ejemplo, 22 puntos)', [6, 5, 5, 3, 3], { 19: 1, 21: 2, 22: 2 }, [51, 72, 88, 95]),
  ],
  // 4 áreas: con 3 no caben 3 semanas sin repetir pareja (cada área tiene sólo 2 posibles auditadas).
  rotacion: [[1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2]],
};
fs.mkdirSync('seed', { recursive: true });
fs.writeFileSync('seed/ejemplo-config.json', JSON.stringify(cfg, null, 2) + '\n');
console.log('seed/ejemplo-config.json listo');
