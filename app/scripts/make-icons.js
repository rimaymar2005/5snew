'use strict';
// Genera public/icon-180.png y public/icon-512.png (sin dependencias).
const fs = require('fs');
const zlib = require('zlib');

const G = {
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
};
const crcTabla = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcTabla[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(tipo, datos) {
  const t = Buffer.from(tipo); const l = Buffer.alloc(4); l.writeUInt32BE(datos.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, datos])));
  return Buffer.concat([l, t, datos, c]);
}
function png(n) {
  const fondo = [0xe2, 0x00, 0x1a], blanco = [255, 255, 255];
  const celda = Math.floor((n * 0.6) / 11);
  const ancho = celda * 11, alto = celda * 7;
  const x0 = Math.floor((n - ancho) / 2), y0 = Math.floor((n - alto) / 2);
  const filas = [];
  for (let y = 0; y < n; y++) {
    const fila = Buffer.alloc(1 + n * 3);
    for (let x = 0; x < n; x++) {
      let col = fondo;
      const cx = Math.floor((x - x0) / celda), cy = Math.floor((y - y0) / celda);
      if (x >= x0 && y >= y0 && cx < 11 && cy < 7) {
        const g = cx < 5 ? G['5'][cy][cx] : cx >= 6 ? G.S[cy][cx - 6] : '0';
        if (g === '1') col = blanco;
      }
      fila[1 + x * 3] = col[0]; fila[2 + x * 3] = col[1]; fila[3 + x * 3] = col[2];
    }
    filas.push(fila);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(filas))), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync('public/icon-180.png', png(180));
fs.writeFileSync('public/icon-512.png', png(512));
console.log('iconos listos');
