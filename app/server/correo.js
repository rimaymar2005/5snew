'use strict';
// Envío de correo con Microsoft Graph (flujo de aplicación: client credentials + POST /users/{remitente}/sendMail).
// Requiere un registro de aplicación en Entra ID con el permiso de aplicación Mail.Send (con consentimiento del administrador)
// y un buzón remitente. Sin esas variables el correo queda desactivado y la app funciona igual.
const EMAIL_OK = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const esCorreo = (s) => typeof s === 'string' && s.length <= 200 && EMAIL_OK.test(s.trim());
const listaCorreos = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(esCorreo);

class CorreoError extends Error {}

function crearGraph({ tenant, clientId, secret, remitente, fetchImpl = fetch, ahora = Date.now }) {
  let token = null;
  let expira = 0;

  async function obtenerToken(forzar) {
    if (!forzar && token && ahora() < expira - 60000) return token;
    const r = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new CorreoError(`Microsoft no entregó el token (${r.status}): ${j.error_description || j.error || 'sin detalle'}`.slice(0, 300));
    token = j.access_token;
    expira = ahora() + (Number(j.expires_in) || 3600) * 1000;
    return token;
  }

  // adjuntos: [{ nombre, tipo, base64 }]
  async function enviar({ to, subject, html, adjuntos = [] }) {
    const destinos = (Array.isArray(to) ? to : [to]).filter(esCorreo);
    if (!destinos.length) throw new CorreoError('No hay destinatarios válidos.');
    const cuerpo = JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: destinos.map((a) => ({ emailAddress: { address: a.trim() } })),
        attachments: adjuntos.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.nombre, contentType: a.tipo, contentBytes: a.base64 })),
      },
      saveToSentItems: false,
    });
    for (let intento = 0; intento < 2; intento++) {
      const t = await obtenerToken(intento > 0);
      const r = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(remitente)}/sendMail`, {
        method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: cuerpo, signal: AbortSignal.timeout(30000),
      });
      if (r.status === 401 && intento === 0) continue; // token vencido o revocado: se pide otro y se reintenta
      if (r.status === 202 || r.ok) return { ok: true };
      const j = await r.json().catch(() => ({}));
      throw new CorreoError(`Graph respondió ${r.status}: ${(j.error && (j.error.message || j.error.code)) || 'sin detalle'}`.slice(0, 300));
    }
    throw new CorreoError('No se pudo autenticar con Microsoft Graph.');
  }
  return { activo: true, remitente, enviar };
}

const INACTIVO = { activo: false, remitente: null, async enviar() { throw new CorreoError('El correo no está configurado.'); } };

// Variables: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER (buzón o UPN que envía)
function desdeEntorno(env = process.env, opciones = {}) {
  const { GRAPH_TENANT_ID: tenant, GRAPH_CLIENT_ID: clientId, GRAPH_CLIENT_SECRET: secret, GRAPH_SENDER: remitente } = env;
  if (!(tenant && clientId && secret && remitente)) return INACTIVO;
  return crearGraph({ tenant, clientId, secret, remitente, ...opciones });
}

module.exports = { crearGraph, desdeEntorno, INACTIVO, esCorreo, listaCorreos, CorreoError };
