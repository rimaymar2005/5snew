'use strict';
const { createMulti } = require('./multi');
const { desdeEntorno, listaCorreos } = require('./correo');
const { configuracionBase } = require('./azure');

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  // local: variables de entorno; Azure: Key Vault con Managed Identity (ver azure.js)
  const cfg = await configuracionBase();
  if (!cfg.base.password) console.warn('[aviso] contraseña de la base de datos no definida.');
  const correo = desdeEntorno();
  const hora = parseInt(process.env.MAIL_HORA, 10);
  const horaDeAvisos = hora >= 0 && hora <= 23 ? hora : 8; // hora local a partir de la cual se mandan los avisos diarios
  console.log(correo.activo ? `Correo: Microsoft Graph activo (remitente ${correo.remitente}).` : 'Correo: desactivado (faltan variables GRAPH_*).');
  const base = cfg.base;
  // una base de datos por planta (mismo servidor y usuario). PLANTAS=fc deja activa solo FC (por omisión: fc,pmc)
  const activas = new Set((process.env.PLANTAS || 'fc,pmc').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));
  const todas = {
    fc: { nombre: 'FC', conexion: { ...base, database: cfg.nombres.fc }, adminCorreos: listaCorreos(process.env.MAIL_ADMIN_FC || process.env.MAIL_ADMIN) },
    pmc: { nombre: 'PMC', conexion: { ...base, database: cfg.nombres.pmc }, adminCorreos: listaCorreos(process.env.MAIL_ADMIN_PMC || process.env.MAIL_ADMIN) },
  };
  if (!Object.keys(todas).some((id) => activas.has(id))) throw new Error('PLANTAS no incluye ninguna planta válida (fc, pmc).');
  const { app, close } = await createMulti({
    plantas: Object.fromEntries(Object.entries(todas).filter(([id]) => activas.has(id))),
    correo, // Microsoft Graph (GRAPH_*); sin esas variables el correo queda desactivado
    urlApp: process.env.APP_URL || '',
    programar: true,
    horaCorreo: horaDeAvisos,
    adminPassword: process.env.ADMIN_PASSWORD || cfg.secretos.adminPassword,
    jwtSecret: process.env.JWT_SECRET || cfg.secretos.jwtSecret,
    trustProxy: process.env.TRUST_PROXY || '1',
  });
  const server = app.listen(PORT, () => console.log(`Auditorías 5S escuchando en el puerto ${PORT}`));
  const apagar = () => {
    server.close(() => close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
