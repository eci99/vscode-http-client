'use strict';

// Standalone tests (no VS Code needed): parser, variables, scripts, runner against a local server.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, findRequestAt } = require('../src/parser');
const { runRequest, buildRequest, toCurl } = require('../src/runner');
const { CookieJar } = require('../src/cookies');
const { formatResults } = require('../src/format');
const { resolveDynamic } = require('../src/variables');
const intellisense = require('../src/intellisense');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-client-'));
fs.writeFileSync(path.join(tmp, 'payload.json'), '{"from":"file","user":"{{user}}"}');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/login') {
      res.setHeader('Set-Cookie', 'session=abc123; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ token: 'tok-' + JSON.parse(body).user }));
    }
    if (url.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', '/echo'); return res.end(); }
    if (url.pathname === '/cookie-redirect') {
      res.statusCode = 302;
      res.setHeader('Set-Cookie', 'flash=hi; Path=/');
      res.setHeader('Location', '/echo?from=redirect');
      return res.end();
    }
    if (url.pathname === '/loop') { res.statusCode = 307; res.setHeader('Location', '/loop'); return res.end(); }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      headers: req.headers, body
    }));
  });
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SAMPLE = `
@user = janos
@base = http://{{host}}

### Login
# @name login
POST {{base}}/login
Content-Type: application/json

{"user": "{{user}}"}

> {%
  client.test("status 200", () => client.assert(response.status === 200, "bad status"));
  client.global.set("token", response.body.token);
%}

### Authorized call
< {%
  request.variables.set("rid", "req-42");
%}
GET {{base}}/echo/items
    ?page=2
    &size={{pageSize}}
Authorization: Bearer {{token}}
X-Request-Id: {{rid}}
# a comment in headers

> {%
  client.test("token sent", () => client.assert(response.body.headers.authorization === "Bearer tok-janos"));
  client.test("cookie sent", () => client.assert(response.body.headers.cookie === "session=abc123"));
  client.test("query", () => client.assert(jsonPath(response.body, "$.query.size") === "50"));
  client.test("will fail", () => client.assert(false, "expected failure"));
  client.log("hdr", response.headers.valueOf("content-type"));
%}

### Body from file
POST {{base}}/echo
Content-Type: application/json

<@ ./payload.json

>> ./out/result.json

### No redirect
# @no-redirect
GET {{base}}/redirect

### GraphQL
GRAPHQL {{base}}/graphql

query Q($id: ID!) { item(id: $id) { name } }

{"id": "1"}
`;

test('parser', () => {
  const p = parse(SAMPLE);
  assert.strictEqual(p.requests.length, 5);
  assert.deepStrictEqual(p.fileVariables, { user: 'janos', base: 'http://{{host}}' });
  const [login, auth, file, redir, gql] = p.requests;
  assert.strictEqual(login.name, 'login');
  assert.strictEqual(login.method, 'POST');
  assert.strictEqual(login.handlers.length, 1);
  assert.strictEqual(login.body.length, 1);
  assert.strictEqual(auth.url, '{{base}}/echo/items?page=2&size={{pageSize}}');
  assert.strictEqual(auth.preScripts.length, 1);
  assert.strictEqual(auth.headers.length, 2);
  assert.strictEqual(file.body[0].type, 'file');
  assert.strictEqual(file.body[0].substitute, true);
  assert.deepStrictEqual(file.responseFile, { path: './out/result.json', overwrite: false, line: SAMPLE.split('\n').indexOf('>> ./out/result.json') });
  assert.strictEqual(redir.tags['no-redirect'], true);
  assert.strictEqual(gql.method, 'GRAPHQL');
  const lines = SAMPLE.split('\n');
  assert.ok(lines[auth.line].startsWith('GET'));
  assert.strictEqual(findRequestAt(p, auth.line + 3), auth);
});

test('dynamic variables', () => {
  assert.match(resolveDynamic('$uuid'), /^[0-9a-f-]{36}$/);
  const n = resolveDynamic('$random.integer(5, 6)');
  assert.strictEqual(n, 5);
  assert.strictEqual(resolveDynamic('$random.alphabetic(7)').length, 7);
  assert.strictEqual(typeof resolveDynamic('$timestamp'), 'number');
});

test('variable precedence: environment > global > in-place > request', () => {
  const { makeResolver } = require('../src/variables');
  const all = { envVars: { v: 'env' }, globals: { v: 'global' }, fileVars: { v: 'file' }, requestVars: { v: 'request' } };
  assert.strictEqual(makeResolver(all)('v'), 'env');
  assert.strictEqual(makeResolver({ ...all, envVars: {} })('v'), 'global');
  assert.strictEqual(makeResolver({ ...all, envVars: {}, globals: {} })('v'), 'file');
  assert.strictEqual(makeResolver({ requestVars: { v: 'request' } })('v'), 'request');
});

test('runner end-to-end', async () => {
  const port = server.address().port;
  const p = parse(SAMPLE);
  const globals = {};
  const ctx = {
    fileVars: p.fileVariables,
    envVars: { host: `127.0.0.1:${port}`, pageSize: 50 },
    globals, baseDir: tmp, cookieJar: new CookieJar(), timeoutMs: 5000, followRedirects: true
  };
  const results = [];
  for (const r of p.requests) results.push(await runRequest(r, ctx));
  const [login, auth, file, redir, gql] = results;

  assert.strictEqual(login.error, null, login.error);
  assert.strictEqual(globals.token, 'tok-janos');
  assert.deepStrictEqual(login.tests, [{ name: 'status 200', passed: true }]);

  assert.strictEqual(auth.error, null, auth.error);
  assert.strictEqual(auth.response.parsedBody.headers['x-request-id'], 'req-42');
  const passed = auth.tests.filter(t => t.passed).map(t => t.name);
  assert.deepStrictEqual(passed, ['token sent', 'cookie sent', 'query']);
  assert.strictEqual(auth.tests[3].error, 'expected failure');
  assert.ok(auth.logs[0].startsWith('hdr application/json'));

  assert.strictEqual(file.response.parsedBody.body, '{"from":"file","user":"janos"}');
  assert.ok(fs.existsSync(path.join(tmp, 'out/result.json')));

  assert.strictEqual(redir.response.status, 302);

  const gqlBody = JSON.parse(gql.response.parsedBody.body);
  assert.deepStrictEqual(gqlBody.variables, { id: '1' });
  assert.ok(gqlBody.query.startsWith('query Q'));
  assert.strictEqual(gql.response.parsedBody.method, 'POST');

  const text = formatResults(results);
  assert.ok(text.includes('HTTP/1.1 200 OK'));
  assert.ok(text.includes('✗ will fail: expected failure'));

  // second run of file request must not overwrite (-1 suffix)
  await runRequest(p.requests[2], ctx);
  assert.ok(fs.existsSync(path.join(tmp, 'out/result-1.json')));
});

test('unresolved variables + curl', () => {
  const p = parse('GET https://{{host}}/x\nX-A: {{nope}}\n');
  const missing = new Set();
  const built = buildRequest(p.requests[0], { requestVars: {}, fileVars: {}, globals: {}, envVars: { host: 'h.io' } }, tmp, missing);
  assert.deepStrictEqual([...missing], ['nope']);
  assert.strictEqual(built.url, 'https://h.io/x');
  assert.ok(toCurl(built).includes("'X-A: {{nope}}'"));
});

test('connection error is reported', async () => {
  const p = parse('GET http://127.0.0.1:1/never\n');
  const r = await runRequest(p.requests[0], {
    fileVars: {}, envVars: {}, globals: {}, baseDir: tmp, cookieJar: new CookieJar(), timeoutMs: 2000
  });
  assert.ok(r.error && /fetch failed|ECONNREFUSED/.test(r.error), r.error);
});

test('IntelliJ features: tags, global headers, client.variables, cookies, jwt', async () => {
  const port = server.address().port;
  const text = `@fileVar = from-file

### First
# @name = first
< {%
  client.global.headers.set("X-Global", "g1");
  client.variables.global.set("gv", client.variables.file.get("fileVar"));
  client.log(typeof $uuid, $uuid.length, btoa("hi"), atob("aGk="), new URLSearchParams({ a: 1 }).toString());
  const token = jwt.sign({ sub: "me" }, "secret", { expiresIn: "1h", audience: "x" });
  client.log(jwt.verify(token, "secret", { algorithm: "HS256", audience: "x" }).sub, jwt.decode(token).header.alg);
  client.log(crypto.hmac.sha3("256").withTextSecret("k").updateWithText("m").digest().toHex().length);
%}
POST http://127.0.0.1:${port}/login?q=a b@c&ok=%40
Authorization: Basic user secret
Content-Type: application/json

{"user": "{{gv}}"}

> {%
  client.log(request.url(), request.headers.findByName("content-type").value());
  client.log(response.cookies()[0].name, response.cookiesByName("session")[0].httpOnly);
%}

### Second
# @no-auto-encoding
# @connection-timeout 5 s
GET http://127.0.0.1:${port}/echo?x=a%20b
`;
  const p = parse(text);
  assert.strictEqual(p.requests[0].name, 'first');
  const globalHeaders = {};
  const ctx = {
    fileVars: p.fileVariables, envVars: {}, globals: {}, globalHeaders,
    baseDir: tmp, cookieJar: new CookieJar(), timeoutMs: 5000
  };
  const first = await runRequest(p.requests[0], ctx);
  assert.strictEqual(first.error, null, first.error);
  assert.deepStrictEqual(first.logs.slice(0, 3), ['string 36 aGk= hi a=1', 'me HS256', '64']);
  assert.ok(first.request.url.endsWith('/login?q=a%20b%40c&ok=%40'), first.request.url);
  assert.ok(first.logs[3].endsWith('/login?q=a b@c&ok=%40 application/json'), first.logs[3]);
  assert.strictEqual(first.logs[4], 'session true');
  const auth = first.request.headers.find(h => h.name === 'Authorization').value;
  assert.strictEqual(auth, `Basic ${Buffer.from('user:secret').toString('base64')}`);
  assert.strictEqual(ctx.globals.gv, 'from-file');
  assert.deepStrictEqual(globalHeaders, { 'X-Global': 'g1' });

  const second = await runRequest(p.requests[1], ctx);
  assert.strictEqual(second.error, null, second.error);
  assert.strictEqual(second.response.parsedBody.headers['x-global'], 'g1', 'global header sent');
  assert.strictEqual(second.response.parsedBody.query.x, 'a b');
});

test('redirects: cookies of redirect responses, POST becomes GET, loops', async () => {
  const port = server.address().port;
  const p = parse(`POST http://127.0.0.1:${port}/cookie-redirect
Content-Type: application/json

{"a": 1}

> {% client.log(response.cookies().map(c => c.name).join(",")); %}

###
GET http://127.0.0.1:${port}/echo

###
GET http://127.0.0.1:${port}/loop
`);
  const ctx = { fileVars: {}, envVars: {}, globals: {}, baseDir: tmp, cookieJar: new CookieJar(), timeoutMs: 5000 };
  const first = await runRequest(p.requests[0], ctx);
  assert.strictEqual(first.error, null, first.error);
  assert.strictEqual(first.response.status, 200);
  assert.strictEqual(first.response.parsedBody.method, 'GET', 'POST becomes GET after 302');
  assert.deepStrictEqual(first.response.parsedBody.query, { from: 'redirect' });
  assert.strictEqual(first.response.parsedBody.headers.cookie, 'flash=hi', 'cookie sent to the redirect target');
  assert.ok(first.response.url.endsWith('/echo?from=redirect'));
  assert.deepStrictEqual(first.logs, ['flash']);
  const second = await runRequest(p.requests[1], ctx);
  assert.strictEqual(second.response.parsedBody.headers.cookie, 'flash=hi', 'cookie stored in the jar');
  const loop = await runRequest(p.requests[2], ctx);
  assert.ok(/More than 20 redirects/.test(loop.error), loop.error);
});

test('intellisense: context at the cursor', () => {
  const text = '### A\n# @na\n@host = x\nPO\n\n### B\nGET http://x\n  ?a=1\nContent-Type: appl\nAcc\n\n{"a":1}\n\n> {%\nclient.global.\n%}\n';
  const lines = text.split('\n');
  const at = (no, col = lines[no].length) => intellisense.contextAt(lines, no, col);
  assert.deepStrictEqual(at(1), { kind: 'tag', typed: 'na' });
  assert.deepStrictEqual(at(3), { kind: 'requestStart', typed: 'PO' });
  assert.strictEqual(at(6).kind, 'other', 'request line');
  assert.strictEqual(at(7).kind, 'other', 'URL continuation');
  assert.deepStrictEqual(at(8), { kind: 'headerValue', name: 'Content-Type', typed: 'appl' });
  assert.deepStrictEqual(at(9), { kind: 'headerName', typed: 'Acc' });
  assert.strictEqual(at(11).kind, 'other', 'body');
  assert.deepStrictEqual(at(14), { kind: 'script', scriptKind: 'handler', before: 'client.global.' });
  assert.strictEqual(at(15).kind, 'other', 'after the script');
  assert.deepStrictEqual(intellisense.contextAt(['< {% req'], 0, 8), { kind: 'script', scriptKind: 'pre', before: ' req' });
});

test('intellisense: script API', () => {
  const names = (before, kind = 'handler') => {
    const found = intellisense.scriptCompletions(before, kind);
    return found && (found.members ? Object.keys(found.members) : found);
  };
  assert.ok(names('').includes('response') && !names('', 'pre').includes('response'));
  assert.deepStrictEqual(names('client.global.'), ['set', 'get', 'isEmpty', 'clear', 'clearAll', 'headers']);
  assert.deepStrictEqual(names('request.headers.findByName("a").'), ['name', 'getRawValue', 'tryGetSubstitutedValue', 'value']);
  assert.deepStrictEqual(intellisense.contextAt(['GET http://x H'], 0, 14), { kind: 'httpVersion', typed: 'H' });
  assert.ok(names('const id = response.headers.va').includes('valueOf'));
  assert.ok(names('crypto.hmac.sha256().withTextSecret(key).').includes('digest'));
  assert.deepStrictEqual(names('crypto.sha256().updateWithText("x").digest().'), ['toHex', 'toBase64', 'bytes']);
  assert.deepStrictEqual(names('client.global.get("to'), { names: 'global', typed: 'to' });
  assert.deepStrictEqual(names('request.environment.get(\'ho'), { names: 'environment', typed: 'ho' });
  assert.strictEqual(names('client.log("a.'), undefined, 'inside another string');
  assert.strictEqual(names('foo.'), undefined, 'unknown object');
  assert.strictEqual(intellisense.scriptEntryAt('client.global.set("a", 1)', 15, 'pre').entry.detail, 'set(name, value)');
});

test('intellisense: help and documentation links', () => {
  const lines = ['### A', '# @no-log', '@host = x', 'POST http://x HTTP/2', 'Authorization: Basic u p', '', '>>! out.json'];
  const help = (line, character) => {
    const h = intellisense.helpAt(lines, line, character);
    return h && [h.title, h.anchor];
  };
  assert.deepStrictEqual(help(0, 1), ['Request separator', 'separators-and-titles']);
  assert.deepStrictEqual(help(1, 5), ['`# @no-log`', '4-tags']);
  assert.deepStrictEqual(help(2, 1), ['In-place variable `host`', 'in-place-variables']);
  assert.deepStrictEqual(help(3, 2), ['`POST` (HTTP method)', 'request-line']);
  assert.deepStrictEqual(help(3, 17), ['`HTTP/2`', 'request-line']);
  assert.deepStrictEqual(help(4, 3), ['`Authorization` (header)', 'headers']);
  assert.deepStrictEqual(help(4, 18), ['`Basic`', 'basic-authentication']);
  assert.deepStrictEqual(help(6, 1), ['Save the response body (overwrite)', 'saving-the-response-body']);
  assert.strictEqual(help(3, 8), undefined, 'URL');
  // Every script API entry links to a section that exists in the documentation
  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'documentation.md'), 'utf8');
  const anchors = new Set(docs.split('\n').filter(l => /^#{2,4} /.test(l)).map(l =>
    l.replace(/^#+ /, '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-')));
  const walk = members => Object.values(members).forEach(e => {
    assert.ok(anchors.has(e.anchor), `${e.detail}: #${e.anchor}`);
    if (e.members) walk(e.members);
  });
  walk(intellisense.scriptCompletions('', 'handler').members);
  for (const a of ['request-line', 'headers', 'basic-authentication', '4-tags', 'kinds-of-variables', 'dynamic-variables',
    'separators-and-titles', 'in-place-variables', 'body-from-a-file', 'response-handlers', 'saving-the-response-body',
    'multipart', 'form-data', 'graphql']) assert.ok(anchors.has(a), a);
});

server.listen(0, '127.0.0.1', async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`✓ ${t.name}`); }
    catch (e) { failed++; console.log(`✗ ${t.name}\n  ${e.stack}`); }
  }
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
});
