'use strict';

/**
 * JavaScript API for pre-request scripts (`< {% %}`) and response handlers (`> {% %}`),
 * modelled after the IntelliJ HTTP Client:
 *   client.global.set/get/isEmpty/clear/clearAll, client.global.headers.set/clear,
 *   client.variables.global/file/request/environment, client.test, client.assert, client.log, client.exit
 *   request.variables.set/get, request.environment.get, request.url/method/headers/body
 *   response.status, response.body, response.headers.valueOf/valuesOf, response.contentType,
 *   response.cookies(), response.cookiesByName()
 *   $random, $uuid, $timestamp, $isoTimestamp, $randomInt, $env, crypto (hashes, sha3, hmac),
 *   jwt.sign/verify/decode, jsonPath(), btoa/atob, URLSearchParams, console.log
 */

const vm = require('vm');
const nodeCrypto = require('crypto');
const { random, resolveDynamic } = require('./variables');

const EXIT = Symbol('client.exit');

function formatArg(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// ---------- crypto helper (IntelliJ-style builder API) ----------
function hashBuilder(alg, isHmac) {
  const parts = [];
  let secret = null;
  const api = {
    updateWithText(text, encoding = 'utf8') {
      parts.push(Buffer.from(String(text), encoding === 'UTF-8' ? 'utf8' : encoding));
      return api;
    },
    updateWithHex(hex) { parts.push(Buffer.from(hex, 'hex')); return api; },
    updateWithBase64(b64, urlSafe) {
      parts.push(Buffer.from(b64, urlSafe ? 'base64url' : 'base64'));
      return api;
    },
    withTextSecret(t) { secret = Buffer.from(String(t), 'utf8'); return api; },
    withHexSecret(h) { secret = Buffer.from(h, 'hex'); return api; },
    withBase64Secret(b, urlSafe) { secret = Buffer.from(b, urlSafe ? 'base64url' : 'base64'); return api; },
    digest() {
      const h = isHmac ? nodeCrypto.createHmac(alg, secret || Buffer.alloc(0)) : nodeCrypto.createHash(alg);
      parts.forEach(p => h.update(p));
      const out = h.digest();
      return {
        toHex: () => out.toString('hex'),
        toBase64: urlSafe => out.toString(urlSafe ? 'base64url' : 'base64'),
        bytes: () => Array.from(out)
      };
    }
  };
  return api;
}

const ALGS = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' };
const cryptoApi = { hmac: {} };
for (const [k, alg] of Object.entries(ALGS)) {
  cryptoApi[k] = () => hashBuilder(alg, false);
  cryptoApi.hmac[k] = () => hashBuilder(alg, true);
}
// SHA-3 takes the bit length as parameter: crypto.hmac.sha3('512')
const sha3 = bits => {
  if (!['224', '256', '384', '512'].includes(String(bits))) throw new Error(`Unsupported SHA-3 length: ${bits}`);
  return `sha3-${bits}`;
};
cryptoApi.sha3 = (bits = '256') => hashBuilder(sha3(bits), false);
cryptoApi.hmac.sha3 = (bits = '256') => hashBuilder(sha3(bits), true);

// ---------- JWT (HS*, RS*, PS*, ES*) ----------
const b64url = buf => Buffer.from(buf).toString('base64url');
const JWT_HASH = { 256: 'sha256', 384: 'sha384', 512: 'sha512' };

function jwtAlgorithm(alg) {
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg || '');
  if (!m) throw new Error(`Unsupported JWT algorithm: ${alg}`);
  return { family: m[1], hash: JWT_HASH[m[2]] };
}

function keyBytes(key) {
  return typeof key === 'string' || Buffer.isBuffer(key) || key instanceof Uint8Array ? Buffer.from(key) : key;
}

function jwtSignature(alg, input, key) {
  const { family, hash } = jwtAlgorithm(alg);
  if (family === 'HS') return nodeCrypto.createHmac(hash, keyBytes(key)).update(input).digest();
  const opts = { key };
  if (family === 'PS') Object.assign(opts, { padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST });
  if (family === 'ES') opts.dsaEncoding = 'ieee-p1363';
  return nodeCrypto.sign(hash, Buffer.from(input), opts);
}

/** "1h", "30m", "10s", "2d" or a number of seconds. */
function seconds(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(String(v).trim());
  if (!m) throw new Error(`Invalid time span: ${v}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
}

const jwtApi = {
  sign(payload, key, options = {}) {
    const alg = options.algorithm || 'HS256';
    const header = { alg, typ: 'JWT', ...(options.keyid ? { kid: options.keyid } : {}), ...options.header };
    const claims = typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(String(payload)) : { ...payload };
    const now = Math.floor(Date.now() / 1000);
    if (!options.noTimestamp && claims.iat === undefined) claims.iat = now;
    if (options.expiresIn !== undefined) claims.exp = now + seconds(options.expiresIn);
    if (options.notBefore !== undefined) claims.nbf = now + seconds(options.notBefore);
    for (const [opt, claim] of [['issuer', 'iss'], ['subject', 'sub'], ['audience', 'aud'], ['jwtid', 'jti']]) {
      if (options[opt] !== undefined) claims[claim] = options[opt];
    }
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${input}.${b64url(jwtSignature(alg, input, key))}`;
  },
  decode(token) {
    const [h, p, signature] = String(token).split('.');
    if (signature === undefined) throw new Error('Not a JWT');
    return {
      header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
      signature
    };
  },
  verify(token, key, options = {}) {
    const { header, payload, signature } = jwtApi.decode(token);
    const alg = options.algorithm || (options.algorithms && options.algorithms[0]) || header.alg;
    if (header.alg !== alg) throw new Error(`JWT algorithm ${header.alg} does not match ${alg}`);
    const input = String(token).split('.').slice(0, 2).join('.');
    const sig = Buffer.from(signature, 'base64url');
    const { family, hash } = jwtAlgorithm(alg);
    let valid;
    if (family === 'HS') {
      const expected = jwtSignature(alg, input, key);
      valid = expected.length === sig.length && nodeCrypto.timingSafeEqual(expected, sig);
    } else {
      const opts = { key };
      if (family === 'PS') Object.assign(opts, { padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_AUTO });
      if (family === 'ES') opts.dsaEncoding = 'ieee-p1363';
      valid = nodeCrypto.verify(hash, Buffer.from(input), opts, sig);
    }
    if (!valid) throw new Error('Invalid JWT signature');
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && now >= payload.exp) throw new Error('JWT expired');
    if (payload.nbf !== undefined && now < payload.nbf) throw new Error('JWT not active yet');
    if (options.issuer !== undefined && payload.iss !== options.issuer) throw new Error('JWT issuer invalid');
    if (options.subject !== undefined && payload.sub !== options.subject) throw new Error('JWT subject invalid');
    if (options.audience !== undefined) {
      const expected = [].concat(options.audience);
      const actual = [].concat(payload.aud === undefined ? [] : payload.aud);
      if (!expected.some(a => actual.includes(a))) throw new Error('JWT audience invalid');
    }
    return payload;
  }
};

// ---------- jsonPath (subset: $.a.b[0]['c']) ----------
function jsonPath(obj, path) {
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return undefined; }
  }
  const tokens = String(path).replace(/^\$\.?/, '').match(/\[\d+\]|\['[^']*'\]|\["[^"]*"\]|[^.[\]]+/g) || [];
  let cur = obj;
  for (const t of tokens) {
    if (cur === undefined || cur === null) return undefined;
    const key = t.startsWith('[') ? t.slice(1, -1).replace(/^['"]|['"]$/g, '') : t;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

// ---------- headers helper ----------
/**
 * Request headers: elements have `name`, `getRawValue()`, `tryGetSubstitutedValue()` (pre-request
 * scripts) and `value()` (response handlers). Response headers only need valueOf/valuesOf.
 */
function headersApi(list, resolve = v => v) {
  const find = n => list.filter(h => h.name.toLowerCase() === String(n).toLowerCase());
  const header = h => ({
    name: h.name,
    getRawValue: () => h.value,
    tryGetSubstitutedValue: () => resolve(h.value),
    value: () => resolve(h.value)
  });
  return {
    valueOf: n => { const f = find(n); return f.length ? resolve(f[0].value) : null; },
    valuesOf: n => find(n).map(h => resolve(h.value)),
    all: () => list.map(header),
    findByName: n => { const f = find(n); return f.length ? header(f[0]) : null; }
  };
}

/** Cookies from Set-Cookie headers, for response.cookies(). */
function parseSetCookies(headers) {
  return headers.filter(h => h.name.toLowerCase() === 'set-cookie').map(h => {
    const [pair, ...attrs] = h.value.split(';');
    const eq = pair.indexOf('=');
    const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    for (const a of attrs) {
      const [k, ...v] = a.split('=');
      const key = k.trim().toLowerCase();
      const val = v.join('=').trim();
      if (key === 'domain') cookie.domain = val;
      else if (key === 'path') cookie.path = val;
      else if (key === 'expires') cookie.expires = val;
      else if (key === 'max-age') cookie.maxAge = Number(val);
      else if (key === 'samesite') cookie.sameSite = val;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'httponly') cookie.httpOnly = true;
    }
    return cookie;
  }).filter(c => c.name);
}

/** get/set/… over a plain object, as used by client.global and client.variables.*. */
function storeApi(store, writable = true) {
  const api = { get: n => (Object.prototype.hasOwnProperty.call(store, n) ? store[n] : null) };
  if (writable) {
    Object.assign(api, {
      set: (n, v) => { store[n] = v; },
      isEmpty: () => Object.keys(store).length === 0,
      clear: n => { delete store[n]; },
      clearAll: () => { Object.keys(store).forEach(k => delete store[k]); }
    });
  }
  return api;
}

/** A value that can be called (`request.url()`) and has getRaw()/tryGetSubstituted(). */
function textApi(raw, resolve) {
  const fn = () => resolve(raw);
  fn.getRaw = () => raw;
  fn.tryGetSubstituted = () => resolve(raw);
  fn.toString = () => resolve(raw);
  return fn;
}

/**
 * @param {object} opts
 *   globals      – mutable object for client.global
 *   globalHeaders – mutable object for client.global.headers (name → value)
 *   requestVars  – mutable object for request.variables
 *   fileVars     – in-place variables of the file (read-only)
 *   envVars      – environment variables (read-only)
 *   envName      – selected environment name
 *   request      – { method, url, headers, body, resolve(text) }
 *   response     – parsed response or undefined (pre-request)
 *   tests        – array to push test results into
 *   log          – function(line)
 */
function createSandbox(opts) {
  const { globals, requestVars, envVars, request, response, tests, log } = opts;
  const globalHeaders = opts.globalHeaders || {};
  const logFn = (...args) => log(args.map(formatArg).join(' '));
  const requestVariables = { set: (n, v) => { requestVars[n] = v; }, get: storeApi(requestVars).get };
  const environment = storeApi(envVars || {}, false);

  const client = {
    global: {
      ...storeApi(globals),
      headers: {
        set: (n, v) => { if (v === null || v === undefined) delete globalHeaders[n]; else globalHeaders[n] = String(v); },
        clear: n => { delete globalHeaders[n]; }
      }
    },
    variables: {
      global: storeApi(globals),
      file: storeApi(opts.fileVars || {}, false),
      request: requestVariables,
      environment
    },
    test: (name, fn) => {
      try {
        fn();
        tests.push({ name: String(name), passed: true });
      } catch (e) {
        if (e === EXIT) throw e;
        tests.push({ name: String(name), passed: false, error: e && e.message ? e.message : String(e) });
      }
    },
    assert: (condition, message) => {
      if (!condition) throw new Error(message || 'Assertion failed');
    },
    log: logFn,
    exit: () => { throw EXIT; }
  };

  const req = {
    method: request.method,
    variables: requestVariables,
    environment,
    url: textApi(request.url, request.resolve),
    headers: headersApi(request.headers, request.resolve),
    body: textApi(request.rawBody || '', request.resolve),
    environmentName: opts.envName || null
  };

  const btoa = s => Buffer.from(String(s), 'latin1').toString('base64');
  const atob = s => Buffer.from(String(s), 'base64').toString('latin1');
  const sandbox = {
    client,
    request: req,
    $random: random,
    $env: { ...process.env },
    crypto: cryptoApi,
    jwt: jwtApi,
    jsonPath,
    btoa,
    atob,
    Window: { btoa, atob },
    URLSearchParams,
    console: { log: logFn, info: logFn, warn: logFn, error: logFn, debug: logFn },
    Buffer,
    setTimeout: undefined
  };
  // Dynamic variables without curly braces: a new value on every access.
  for (const name of ['uuid', 'timestamp', 'isoTimestamp', 'randomInt']) {
    Object.defineProperty(sandbox, `$${name}`, { get: () => resolveDynamic(`$${name}`), enumerable: true });
  }

  if (response) {
    const cookies = () => parseSetCookies(response.headers);
    sandbox.response = {
      status: response.status,
      body: response.parsedBody,
      headers: headersApi(response.headers),
      contentType: {
        mimeType: response.mimeType || null,
        charset: response.charset || null
      },
      cookies,
      cookiesByName: name => cookies().filter(c => c.name === name)
    };
  }
  return sandbox;
}

function runScript(code, sandbox, filename = 'script.js') {
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { timeout: 5000, filename });
  } catch (e) {
    if (e === EXIT) return;
    throw e;
  }
}

module.exports = { createSandbox, runScript, jsonPath, cryptoApi, jwtApi };
