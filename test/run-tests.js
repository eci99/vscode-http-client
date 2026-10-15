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
