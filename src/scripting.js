'use strict';

/**
 * JavaScript API for pre-request scripts (`< {% %}`) and response handlers (`> {% %}`),
 * modelled after the IntelliJ HTTP Client:
 *   client.global.set/get/isEmpty/clear/clearAll, client.test, client.assert, client.log, client.exit
 *   request.variables.set/get, request.environment.get, request.url/method/headers/body
 *   response.status, response.body, response.headers.valueOf/valuesOf, response.contentType
 *   $random, crypto (md5/sha1/sha256/sha384/sha512 + hmac), jsonPath(), console.log
 */

const vm = require('vm');
const nodeCrypto = require('crypto');
const { random } = require('./variables');

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
function headersApi(list) {
  const find = n => list.filter(h => h.name.toLowerCase() === String(n).toLowerCase());
  return {
    valueOf: n => { const f = find(n); return f.length ? f[0].value : null; },
    valuesOf: n => find(n).map(h => h.value),
    all: () => list.map(h => ({ name: h.name, value: h.value, getRawValue: () => h.value })),
    findByName: n => {
      const f = find(n);
      return f.length ? { name: f[0].name, value: f[0].value, getRawValue: () => f[0].value } : null;
    }
  };
}

/**
 * @param {object} opts
 *   globals      – mutable object for client.global
 *   requestVars  – mutable object for request.variables
 *   envVars      – environment variables (read-only)
 *   envName      – selected environment name
 *   request      – { method, url, headers, body, resolve(text) }
 *   response     – parsed response or undefined (pre-request)
 *   tests        – array to push test results into
 *   log          – function(line)
 */
function createSandbox(opts) {
  const { globals, requestVars, envVars, request, response, tests, log } = opts;
  const logFn = (...args) => log(args.map(formatArg).join(' '));

  const client = {
    global: {
      set: (n, v) => { globals[n] = v; },
      get: n => (Object.prototype.hasOwnProperty.call(globals, n) ? globals[n] : null),
      isEmpty: () => Object.keys(globals).length === 0,
      clear: n => { delete globals[n]; },
      clearAll: () => { Object.keys(globals).forEach(k => delete globals[k]); }
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
    variables: {
      set: (n, v) => { requestVars[n] = v; },
      get: n => (Object.prototype.hasOwnProperty.call(requestVars, n) ? requestVars[n] : null)
    },
    environment: {
      get: n => (envVars && Object.prototype.hasOwnProperty.call(envVars, n) ? envVars[n] : null)
    },
    url: {
      getRaw: () => request.url,
      tryGetSubstituted: () => request.resolve(request.url),
      toString: () => request.resolve(request.url)
    },
    headers: headersApi(request.headers),
    body: {
      getRaw: () => request.rawBody || '',
      tryGetSubstituted: () => request.resolve(request.rawBody || '')
    },
    environmentName: opts.envName || null
  };

  const sandbox = {
    client,
    request: req,
    $random: random,
    crypto: cryptoApi,
    jsonPath,
    console: { log: logFn, info: logFn, warn: logFn, error: logFn, debug: logFn },
    Buffer,
    setTimeout: undefined
  };

  if (response) {
    sandbox.response = {
      status: response.status,
      body: response.parsedBody,
      headers: headersApi(response.headers),
      contentType: {
        mimeType: response.mimeType || null,
        charset: response.charset || null
      }
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

module.exports = { createSandbox, runScript, jsonPath, cryptoApi };
