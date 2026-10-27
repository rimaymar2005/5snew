'use strict';
// Puente local / Azure (equivalente al AppHub.php de la metodología Danfoss).
// Local: toda la configuración sale de variables de entorno (.env).
// Azure App Service: si existe `containerArgs` (o AZURE_KEYVAULT_URL) las credenciales de la base se piden al
// Azure Key Vault con el token de la Managed Identity; nunca van en el repositorio ni en la imagen.
const fs = require('fs');
const path = require('path');

// DigiCert Global Root G2: obligatorio para conectarse a Azure Database for MySQL. Ruta relativa a este archivo
// (en App Service el código vive en /home/site/wwwroot, no en /app).
const CERT_AZURE = path.join(__dirname, 'certs', 'DigiCertGlobalRootG2.crt.pem');

const enAzure = () => !!(process.env.containerArgs || process.env.AZURE_KEYVAULT_URL);

// URL del vault: AZURE_KEYVAULT_URL, o la primera https://<nombre>.vault.azure.net que aparezca en containerArgs.
function urlVault() {
  if (process.env.AZURE_KEYVAULT_URL) return process.env.AZURE_KEYVAULT_URL.replace(/\/+$/, '');
  const m = /https:\/\/[A-Za-z0-9-]+\.vault\.azure\.net/i.exec(process.env.containerArgs || '');
  return m ? m[0] : '';
}

async function pedirJson(url, opciones) {
  const r = await fetch(url, { ...opciones, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${url.split('?')[0]} respondió ${r.status}`);
  return r.json();
}

// Token de Managed Identity para Key Vault (App Service usa IDENTITY_ENDPOINT/IDENTITY_HEADER; VM/ACI usan IMDS).
async function tokenManagedIdentity() {
  const recurso = 'https://vault.azure.net';
  const cliente = process.env.AZURE_CLIENT_ID ? `&client_id=${encodeURIComponent(process.env.AZURE_CLIENT_ID)}` : '';
  if (process.env.IDENTITY_ENDPOINT) {
    const j = await pedirJson(`${process.env.IDENTITY_ENDPOINT}?api-version=2019-08-01&resource=${recurso}${cliente}`, { headers: { 'X-IDENTITY-HEADER': process.env.IDENTITY_HEADER || '' } });
    return j.access_token;
  }
  const j = await pedirJson(`http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${recurso}${cliente}`, { headers: { Metadata: 'true' } });
  return j.access_token;
}

async function secreto(vault, token, nombre) {
  const j = await pedirJson(`${vault}/secrets/${nombre}?api-version=7.4`, { headers: { Authorization: `Bearer ${token}` } });
  return j.value;
}

// Devuelve { base, nombres } para armar la conexión de cada planta.
// Secretos del vault (los nombres de Key Vault no admiten guion bajo): DBHOST, DBUSER, DBPASSWORD, DBNAME (planta FC),
// DBNAMEPMC (opcional, por omisión a5s_pmc), DBCHARSET (opcional) y, si no vienen como configuración de la app,
// ADMINPASSWORD y JWTSECRET.
async function configuracionBase() {
  const env = process.env;
  if (!enAzure()) {
    return {
      azure: false,
      base: { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT) || 3306, user: env.DB_USER || 'a5s', password: env.DB_PASSWORD || '' },
      nombres: { fc: env.DB_NAME || 'a5s', pmc: env.DB_NAME_PMC || 'a5s_pmc' },
      secretos: {},
    };
  }
  const vault = urlVault();
  if (!vault) throw new Error('Azure: falta la URL del Key Vault (AZURE_KEYVAULT_URL o una URL *.vault.azure.net dentro de containerArgs).');
  const token = await tokenManagedIdentity();
  const pedir = async (n, requerido = true) => {
    try { return await secreto(vault, token, n); } catch (e) {
      if (requerido) throw new Error(`Azure: no se pudo leer el secreto ${n} del Key Vault (${e.message}).`);
      return undefined;
    }
  };
  const [host, user, password, name, namePmc, charset, admin, jwt] = await Promise.all([
    pedir('DBHOST'), pedir('DBUSER'), pedir('DBPASSWORD'), pedir('DBNAME'),
    pedir('DBNAMEPMC', false), pedir('DBCHARSET', false),
    env.ADMIN_PASSWORD ? undefined : pedir('ADMINPASSWORD', false), env.JWT_SECRET ? undefined : pedir('JWTSECRET', false),
  ]);
  return {
    azure: true,
    base: { host, port: Number(env.DB_PORT) || 3306, user, password, charset: charset || 'utf8mb4', ssl: { ca: fs.readFileSync(CERT_AZURE, 'utf8'), rejectUnauthorized: true } },
    nombres: { fc: name, pmc: namePmc || env.DB_NAME_PMC || 'a5s_pmc' },
    secretos: { adminPassword: admin, jwtSecret: jwt },
  };
}

module.exports = { configuracionBase, enAzure, CERT_AZURE };
