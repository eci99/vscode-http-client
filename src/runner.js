'use strict';

const fs = require('fs');
const path = require('path');
const { substitute, makeResolver } = require('./variables');
const { createSandbox, runScript } = require('./scripting');

const STRIPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive']);

function parseDuration(v, fallbackMs) {
  if (v === undefined || v === true) return fallbackMs;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return unit === 'ms' ? n : unit === 'm' ? n * 60000 : n * 1000;
}

function loadScript(script, baseDir) {
  if (script.code !== undefined) return { code: script.code, filename: `inline-script:${script.line + 1}` };
  const file = path.resolve(baseDir, script.file);
  return { code: fs.readFileSync(file, 'utf8'), filename: file };
}

function rawBodyText(req) {
  return req.body.map(p => (p.type === 'text' ? p.value : `< ${p.path}`)).join('\n');
}

/**
 * Turn a parsed request into a concrete HTTP request (variables substituted, files included).
 * `missing` collects unresolved variable names.
 */
function buildRequest(req, state, baseDir, missing = new Set()) {
  const resolve = makeResolver(state);
  const sub = t => substitute(t, n => {
    const v = resolve(n);
    if (v === undefined || v === null) missing.add(n);
    return v;
  });

  let method = req.method;
  let url = sub(req.url);
  const headers = req.headers.map(h => ({ name: sub(h.name), value: sub(h.value) }));
  const getHeader = n => headers.find(h => h.name.toLowerCase() === n);

  const contentType = (getHeader('content-type') || {}).value || '';
  const sep = /multipart\//i.test(contentType) ? '\r\n' : '\n';

  const chunks = [];
  req.body.forEach((part, idx) => {
    if (idx > 0) chunks.push(Buffer.from(sep));
    if (part.type === 'text') {
      chunks.push(Buffer.from(sub(part.value), 'utf8'));
    } else {
      const file = path.resolve(baseDir, sub(part.path));
      const data = fs.readFileSync(file);
      chunks.push(part.substitute ? Buffer.from(sub(data.toString('utf8')), 'utf8') : data);
    }
  });
  let body = chunks.length ? Buffer.concat(chunks) : undefined;

  if (method === 'GRAPHQL') {
    method = 'POST';
    const text = body ? body.toString('utf8') : '';
    let query = text;
    let variables;
    const split = text.split(/\n\s*\n/);
    if (split.length > 1) {
      const last = split[split.length - 1].trim();
      try {
        variables = JSON.parse(last);
        query = split.slice(0, -1).join('\n\n');
      } catch { /* the whole body is the query */ }
    }
    body = Buffer.from(JSON.stringify(variables ? { query: query.trim(), variables } : { query: query.trim() }));
    if (!getHeader('content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
  }

  // Path-only URL with Host header, or URL without scheme
  const host = getHeader('host');
  if (url.startsWith('/') && host) url = `http://${host.value}${url}`;
  else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `http://${url}`;

  url = encodeQuery(url, !req.tags || !req.tags['no-auto-encoding']);
  basicAuth(headers);
  return { method, url, headers, body };
}

/**
 * Percent-encodes characters in the query that are not allowed there (e.g. space, @, #, $),
 * keeping existing %XX escapes, like the IntelliJ HTTP Client. `# @no-auto-encoding` turns it off.
 */
function encodeQuery(url, enabled) {
  const q = url.indexOf('?');
  if (!enabled || q < 0) return url;
  const encode = s => s.replace(/%(?![0-9a-f]{2})|[^A-Za-z0-9\-._~%!*'()+,;:/?]/gi, c => encodeURIComponent(c));
  const query = url.slice(q + 1).split('&').map(pair => pair.split('=').map(encode).join('=')).join('&');
  return `${url.slice(0, q)}?${query}`;
}

/** "Authorization: Basic user password" is sent Base64-encoded, as in the IntelliJ HTTP Client. */
function basicAuth(headers) {
  for (const h of headers) {
    const m = h.name.toLowerCase() === 'authorization' && h.value.match(/^Basic\s+(\S+)\s+(.+)$/i);
    if (m) h.value = `Basic ${Buffer.from(`${m[1]}:${m[2]}`).toString('base64')}`;
  }
}

function parseContentType(value) {
  if (!value) return { mimeType: null, charset: null };
  const [mime, ...params] = value.split(';');
  const cs = params.map(p => p.trim()).find(p => /^charset=/i.test(p));
  return { mimeType: mime.trim().toLowerCase(), charset: cs ? cs.split('=')[1].replace(/"/g, '') : null };
}

function isJsonMime(mime) {
  return !!mime && (/[/+]json$/.test(mime) || mime === 'application/json');
}

function decodeBody(buf, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Execute one request including pre-request scripts and response handlers.
 * ctx: { fileVars, envVars, envName, globals, globalHeaders?, projectRoot?, baseDir, cookieJar,
 *        timeoutMs, followRedirects, fetch? }
 */
async function runRequest(req, ctx) {
  const result = {
    title: req.name || req.title || `${req.method} ${req.url}`,
    tests: [],
    logs: [],
    missing: [],
    request: null,
    response: null,
    error: null,
    savedTo: null
  };
  const log = line => result.logs.push(line);
  const requestVars = {};
  const state = {
    requestVars, fileVars: ctx.fileVars, globals: ctx.globals, envVars: ctx.envVars, projectRoot: ctx.projectRoot
  };
  const globalHeaders = ctx.globalHeaders || {};
  const sandboxOpts = {
    globals: ctx.globals, globalHeaders, requestVars, fileVars: ctx.fileVars, envVars: ctx.envVars, envName: ctx.envName
  };
  const resolveText = t => substitute(t, n => makeResolver(state)(n));
  const scriptRequest = {
    method: req.method, url: req.url, headers: req.headers, rawBody: rawBodyText(req), resolve: resolveText
  };

  try {
    // 1. Pre-request scripts
    for (const s of req.preScripts) {
      const { code, filename } = loadScript(s, ctx.baseDir);
      runScript(code, createSandbox({ ...sandboxOpts, request: scriptRequest, tests: result.tests, log }), filename);
    }

    // 2. Build
    const missing = new Set();
    const built = buildRequest(req, state, ctx.baseDir, missing);
    // Headers from client.global.headers.set(), unless the request sets them itself
    for (const [name, value] of Object.entries(globalHeaders)) {
      if (!built.headers.some(h => h.name.toLowerCase() === name.toLowerCase())) built.headers.push({ name, value });
    }
    result.missing = [...missing];
    result.request = built;

    // 3. Send
    const headers = new Headers();
    for (const h of built.headers) {
      if (STRIPPED_HEADERS.has(h.name.toLowerCase())) continue;
      headers.append(h.name, h.value);
    }
    const useJar = ctx.cookieJar && !req.tags['no-cookie-jar'];
    if (useJar && !headers.has('cookie')) {
      const c = ctx.cookieJar.header(built.url);
      if (c) headers.set('Cookie', c);
    }
    let body = built.body;
    if (body && (built.method === 'GET' || built.method === 'HEAD')) {
      log(`Note: body is ignored for ${built.method} requests.`);
      body = undefined;
    }
    const followRedirects = req.tags['no-redirect'] ? false : ctx.followRedirects !== false;
    const timeoutMs = parseDuration(req.tags.timeout, ctx.timeoutMs || 60000);
    // fetch cannot limit the connection phase alone; @connection-timeout limits the time
    // until the response headers arrive.
    const connectionMs = req.tags['connection-timeout'] !== undefined
      ? parseDuration(req.tags['connection-timeout'], timeoutMs) : undefined;
    const signals = [AbortSignal.timeout(timeoutMs)];
    const connection = new AbortController();
    const connectionTimer = connectionMs !== undefined &&
      setTimeout(() => connection.abort(Object.assign(new Error('Connection timed out'), { name: 'TimeoutError' })), connectionMs);
    if (connectionTimer) signals.push(connection.signal);

    const doFetch = ctx.fetch || fetch;
    const started = performance.now();
    let res;
    try {
      res = await doFetch(built.url, {
        method: built.method,
        headers,
        body,
        redirect: followRedirects ? 'follow' : 'manual',
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      });
    } finally {
      clearTimeout(connectionTimer);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round(performance.now() - started);

    const resHeaders = [];
    res.headers.forEach((value, name) => { if (name !== 'set-cookie') resHeaders.push({ name, value }); });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    setCookies.forEach(value => resHeaders.push({ name: 'set-cookie', value }));
    if (useJar && setCookies.length) ctx.cookieJar.store(res.url || built.url, setCookies);

    const ct = parseContentType(res.headers.get('content-type'));
    const text = decodeBody(buf, ct.charset);
    let parsedBody = text;
    if (isJsonMime(ct.mimeType)) {
      try { parsedBody = JSON.parse(text); } catch { /* keep text */ }
    }
    result.response = {
      status: res.status,
      statusText: res.statusText,
      url: res.url || built.url,
      headers: resHeaders,
      bodyBuffer: buf,
      text,
      parsedBody,
      mimeType: ct.mimeType,
      charset: ct.charset,
      durationMs
    };

    // 4. Response handlers
    for (const s of req.handlers) {
      const { code, filename } = loadScript(s, ctx.baseDir);
      try {
        runScript(code, createSandbox({
          ...sandboxOpts, request: scriptRequest, response: result.response, tests: result.tests, log
        }), filename);
      } catch (e) {
        result.tests.push({ name: 'Response handler', passed: false, error: e.message || String(e) });
      }
    }

    // 5. Save response body
    if (req.responseFile) {
      const target = path.resolve(ctx.baseDir, substitute(req.responseFile.path, makeResolver(state)));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const file = req.responseFile.overwrite ? target : uniquePath(target);
      fs.writeFileSync(file, buf);
      result.savedTo = file;
    }
  } catch (e) {
    const cause = e && e.cause && e.cause.message ? ` (${e.cause.message})` : '';
    result.error = (e && e.name === 'TimeoutError') ? 'Request timed out' : `${e && e.message ? e.message : e}${cause}`;
  }
  return result;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function toCurl(built) {
  const parts = ['curl'];
  if (built.method !== 'GET') parts.push('-X', built.method);
  parts.push(shellQuote(built.url));
  for (const h of built.headers) parts.push('-H', shellQuote(`${h.name}: ${h.value}`));
  if (built.body && built.body.length) parts.push('--data-raw', shellQuote(built.body.toString('utf8')));
  return parts.join(' \\\n  ');
}

module.exports = { runRequest, buildRequest, toCurl, parseDuration };
