'use strict';
const crypto = require('crypto');
const express = require('express');
const { createApp } = require('./app');

// Una instancia completa de la app (su propia base de datos, sesiones y PIN) por planta.
// plantas = { fc: { conexion }, pmc: { conexion } }. La API de cada planta vive en /<planta>/api/...;
// la página (única para todas) se sirve en /. Los datos de una planta nunca se mezclan con los de otra.
// correo (Microsoft Graph), urlApp y programar se comparten; cada planta define su nombre y los correos del administrador.
async function createMulti({ plantas, adminPassword, jwtSecret, trustProxy = '1', correo, urlApp, programar = false, horaCorreo }) {
  const ids = Object.keys(plantas);
  const instancias = {};
  try {
    for (const id of ids) {
      // secreto distinto por planta: una sesión de una planta no sirve en la otra
      const secreto = jwtSecret ? crypto.createHmac('sha256', jwtSecret).update(`planta:${id}`).digest('hex') : undefined;
      instancias[id] = await createApp({
        conexion: plantas[id].conexion, adminPassword, jwtSecret: secreto, trustProxy, correo, urlApp, programar, horaCorreo,
        plantaNombre: plantas[id].nombre || id.toUpperCase(), adminCorreos: plantas[id].adminCorreos || [],
      });
    }
  } catch (e) {
    await Promise.all(Object.values(instancias).map((i) => i.close().catch(() => {})));
    throw e;
  }
  const app = express();
  app.disable('x-powered-by');
  const esApi = (url) => /^\/api(?:[/?]|$)/.test(url);
  for (const id of ids) app.use(`/${id}`, (req, res, next) => (esApi(req.url) ? instancias[id].app(req, res, next) : next()));
  // salud global (la usa el HEALTHCHECK del contenedor): todas las bases deben responder
  app.get('/api/salud', async (req, res) => {
    try { await Promise.all(ids.map((id) => instancias[id].db.q('SELECT 1'))); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false, error: 'Base de datos no disponible.' }); }
  });
  // sin planta no hay más API
  app.use('/api', (req, res) => res.status(404).json({ error: 'Elige una planta.' }));
  // página, service worker y archivos estáticos: los atiende la primera instancia (no dependen de la planta)
  const estaticos = instancias[ids[0]].app;
  app.use((req, res, next) => estaticos(req, res, next));
  return { app, instancias, close: () => Promise.all(ids.map((id) => instancias[id].close())) };
}

module.exports = { createMulti };
