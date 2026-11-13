'use strict';

const crypto = require('crypto');
const http = require('http');

function endpoint(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`OAuth2: invalid ${name}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`OAuth2: ${name} must use HTTPS (HTTP is allowed only on loopback)`);
  }
  if (url.username || url.password) throw new Error(`OAuth2: credentials in ${name} are not supported`);
  return url;
}

async function authorize(config, openExternal, timeoutMs, externalizeRedirect, forceLogin) {
  const authUrl = endpoint(config['Auth URL'], 'Auth URL');
  const redirect = endpoint(config['Redirect URL'] || 'http://localhost:0/', 'Redirect URL');
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
    || redirect.search || redirect.hash) {
    throw new Error('OAuth2: Redirect URL must be an HTTP loopback URL without query or fragment');
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  let timer;
  let rejectCode;
  let resolveCode;
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  codePromise.catch(() => {});
  const server = http.createServer((req, res) => {
    const callback = new URL(req.url, redirect);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || callback.pathname !== redirect.pathname) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (callback.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid OAuth2 state');
      return;
    }
    if (callback.searchParams.has('error')) {
      res.writeHead(400).end('Authorization failed. Return to VS Code.');
      rejectCode(new Error('OAuth2: authorization was denied by the provider'));
      return;
    }
    const code = callback.searchParams.get('code');
    if (!code) { res.writeHead(400).end('Missing authorization code'); return; }
    res.end('Authorization received. You can close this tab and return to VS Code.');
    resolveCode(code);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      const host = redirect.hostname === 'localhost' ? '127.0.0.1' : redirect.hostname.replace(/^\[|\]$/g, '');
      server.listen(redirect.port ? Number(redirect.port) : 80, host, resolve);
    });
    redirect.port = String(server.address().port);
    const browserRedirect = endpoint(await externalizeRedirect(redirect.toString()), 'forwarded Redirect URL');
    if (browserRedirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(browserRedirect.hostname)
      || browserRedirect.pathname !== redirect.pathname || browserRedirect.search || browserRedirect.hash) {
      throw new Error('OAuth2: callback forwarding must preserve the path and use an HTTP loopback URL');
    }
    const configuredRedirect = config['Redirect URL'] && new URL(config['Redirect URL']);
    if (configuredRedirect && configuredRedirect.port !== '0' && browserRedirect.toString() !== redirect.toString()) {
      throw new Error('OAuth2: configured Redirect URL could not be forwarded unchanged; free its local port or use port 0');
    }
    const redirectUri = browserRedirect.toString();
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config['Client ID']);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (forceLogin) authUrl.searchParams.set('prompt', 'login');
    if (config.Scope) authUrl.searchParams.set('scope', config.Scope);
    timer = setTimeout(() => rejectCode(new Error('OAuth2: browser login timed out')), timeoutMs);
    if (!await openExternal(authUrl.toString())) throw new Error('OAuth2: could not open the login URL');
    return { code: await codePromise, verifier, redirectUri };
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('OAuth2: callback port is in use; configure a different Redirect URL');
    throw error;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

function createAuthProvider({ openExternal, fetch: doFetch = fetch, timeoutMs = 180000, externalizeRedirect = url => url }) {
  const cache = new Map();
  const pending = new Map();
  const reauthRequired = new Set();
  let generation = 0;
  const provider = async (id, envVars, scope = '') => {
    const profiles = envVars && envVars.Security && envVars.Security.Auth;
    const config = profiles && Object.prototype.hasOwnProperty.call(profiles, id) && profiles[id];
    if (!config) throw new Error(`OAuth2: Security.Auth profile "${id}" not found in the selected environment`);
    if (config.Type !== 'OAuth2' || config['Grant Type'] !== 'Authorization Code') {
      throw new Error(`OAuth2: profile "${id}" requires Type "OAuth2" and Grant Type "Authorization Code"`);
    }
    if (typeof config['Client ID'] !== 'string' || !config['Client ID'].trim()) {
      throw new Error(`OAuth2: profile "${id}" is missing Client ID`);
    }
    const tokenUrl = endpoint(config['Token URL'], 'Token URL');
    const key = JSON.stringify([scope, id, config]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    if (pending.has(key)) return pending.get(key);
    const loginGeneration = generation;
    const login = (async () => {
      const { code, verifier, redirectUri } = await authorize(config, openExternal, timeoutMs, externalizeRedirect, reauthRequired.has(key));
      if (loginGeneration !== generation) throw new Error('OAuth2: token cache was cleared during login; send the request again');
      const body = new URLSearchParams({
        grant_type: 'authorization_code', client_id: config['Client ID'],
        code, redirect_uri: redirectUri, code_verifier: verifier
      });
      if (config['Client Secret']) body.set('client_secret', config['Client Secret']);
      const response = await doFetch(tokenUrl.toString(), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body, redirect: 'error', signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error(`OAuth2: token exchange failed (HTTP ${response.status})`);
      const data = await response.json();
      if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('OAuth2: token response has no access_token');
      if (loginGeneration !== generation) throw new Error('OAuth2: token cache was cleared during login; send the request again');
      const expiresIn = Number(data.expires_in);
      cache.set(key, {
        token: data.access_token,
        expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.max(0, expiresIn - 30) * 1000 : 0)
      });
      reauthRequired.delete(key);
      return data.access_token;
    })();
    pending.set(key, login);
    try { return await login; } finally { if (pending.get(key) === login) pending.delete(key); }
  };
  provider.clear = () => {
    for (const key of [...cache.keys(), ...pending.keys()]) reauthRequired.add(key);
    generation++;
    cache.clear();
    pending.clear();
  };
  return provider;
}

module.exports = { createAuthProvider };