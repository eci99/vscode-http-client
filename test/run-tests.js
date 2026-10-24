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
const { fileReferences, movedReferenceEdits } = require('../src/file-references');
const visual = require('../src/visual-model');
const envs = require('../src/env-model');

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

test('moving files updates the paths in .http files', () => {
  const api = [
    '< ./scripts/pre.js',
    'POST https://example.com',
    '',
    '<@ ./data/payload.json',
    '',
    '> ../shared/check.js',
    '>> ./out/{{name}}.json',
    '>>! /tmp/abs/result.json'
  ].join('\n');
  assert.deepStrictEqual(fileReferences(api).map(r => [r.line, r.start, r.path]), [
    [0, 2, './scripts/pre.js'], [3, 3, './data/payload.json'], [5, 2, '../shared/check.js'], [7, 4, '/tmp/abs/result.json']
  ]);
  const files = [
    { fsPath: '/ws/api/api.http', text: api },
    { fsPath: '/ws/api/other.http', text: 'POST https://example.com\n\n< data/payload.json' }
  ];
  const edits = renames => movedReferenceEdits(files, renames.map(([oldPath, newPath]) => ({ oldPath, newPath })))
    .map(e => [e.fsPath, e.line, e.start, e.end, e.newText]);

  // A referenced file is renamed: ./ and the form without it are kept.
  assert.deepStrictEqual(edits([['/ws/api/data/payload.json', '/ws/api/data/body.json']]), [
    ['/ws/api/api.http', 3, 3, 22, './data/body.json'],
    ['/ws/api/other.http', 2, 2, 19, 'data/body.json']
  ]);
  // A referenced folder is moved; absolute paths stay absolute.
  assert.deepStrictEqual(edits([['/ws/shared', '/ws/lib/shared'], ['/tmp/abs', '/tmp/new']]), [
    ['/ws/api/api.http', 5, 2, 20, '../lib/shared/check.js'],
    ['/ws/api/api.http', 7, 4, 24, '/tmp/new/result.json']
  ]);
  // The .http file itself is moved, under its new name; paths that still fit, absolute ones and those with variables stay.
  assert.deepStrictEqual(edits([['/ws/api/api.http', '/ws/tests/api.http']]), [
    ['/ws/tests/api.http', 0, 2, 18, '../api/scripts/pre.js'],
    ['/ws/tests/api.http', 3, 3, 22, '../api/data/payload.json']
  ]);
  // A folder that is moved together with what it refers to needs no edits.
  assert.deepStrictEqual(edits([['/ws/api', '/ws/v2/api']]).map(e => e[4]), ['../../shared/check.js']);
  assert.deepStrictEqual(edits([['/ws/unrelated.json', '/ws/x.json']]), []);
});

test('visual editor: blocks are written back unchanged', () => {
  // Written from its fields, every block of the examples gives the same requests and almost the same text.
  const examples = path.join(__dirname, '..', 'examples');
  const comparable = text => {
    const p = parse(text);
    const noLines = o => o && Object.fromEntries(Object.entries(o).filter(([k]) => !/line$/i.test(k)));
    return p.requests.map(r => ({
      ...noLines(r), body: r.body.map(noLines), handlers: r.handlers.map(noLines),
      preScripts: r.preScripts.map(noLines), responseFile: noLines(r.responseFile)
    })).concat([p.fileVariables]);
  };
  for (const f of fs.readdirSync(examples).filter(f => f.endsWith('.http'))) {
    const text = fs.readFileSync(path.join(examples, f), 'utf8');
    const written = visual.toModel(text).flatMap(b => visual.serializeBlock(b)).join('\n');
    assert.deepStrictEqual(comparable(written), comparable(text), f);
    const changedLines = written.split('\n').filter((l, i) => l !== text.split('\n')[i]);
    // "{{baseUrl}}/uuid" gets its GET, "# @name = getUuid" becomes "# @name getUuid"
    assert.ok(changedLines.length <= 1, `${f}: ${changedLines}`);
  }
});

test('visual editor: fields of a block', () => {
  const text = '# file comment\n@host = localhost\n\n### Login\n# @name login\n# @no-log\n# @timeout 5 s\n< {%\n  request.variables.set("a", 1);\n%}\n' +
    'POST https://{{host}}/login\n    ?debug\n    &lang=de HTTP/1.1\nContent-Type: application/json\n# a comment\n\n{"user": "x"}\n\n' +
    '> {% client.global.set("token", response.body.token); %}\n>>! ./out.json\n\n### Empty\n';
  const blocks = visual.toModel(text);
  assert.strictEqual(blocks.length, 3);
  assert.deepStrictEqual(blocks[0].variables, [{ name: 'host', value: 'localhost' }]);
  assert.strictEqual(blocks[0].request, null);
  const b = blocks[1];
  assert.deepStrictEqual([b.title, b.name, b.tags], ['Login', 'login', [{ name: 'no-log', value: '' }, { name: 'timeout', value: '5 s' }]]);
  assert.strictEqual(b.preScript, '< {%\n  request.variables.set("a", 1);\n%}');
  assert.deepStrictEqual(b.request.query, [{ name: 'debug', value: '', eq: false }, { name: 'lang', value: 'de', eq: true }]);
  assert.deepStrictEqual([b.request.method, b.request.url, b.request.httpVersion, b.request.multilineQuery],
    ['POST', 'https://{{host}}/login', 'HTTP/1.1', true]);
  assert.deepStrictEqual(b.request.headers, [{ name: 'Content-Type', value: 'application/json' }]);
  assert.strictEqual(b.request.headerExtra, '# a comment');
  assert.strictEqual(b.request.body, '{"user": "x"}');
  assert.strictEqual(b.request.handlers, '> {% client.global.set("token", response.body.token); %}');
  assert.deepStrictEqual(b.request.responseFile, { path: './out.json', overwrite: true });
  assert.strictEqual(visual.serializeBlock(b).join('\n'), text.slice(text.indexOf('### Login'), text.indexOf('### Empty') - 1));
  assert.strictEqual(blocks[2].title, 'Empty');

  // Changed fields
  b.request.method = 'PUT';
  b.request.multilineQuery = false;
  b.request.query[0].value = '1';
  b.request.body = '';
  b.request.responseFile = { path: '', overwrite: false };
  b.tags = b.tags.filter(t => t.name !== 'no-log');
  b.variables.push({ name: 'x', value: '2' });
  assert.deepStrictEqual(visual.serializeBlock(b), [
    '### Login', '# @name login', '# @timeout 5 s', '@x = 2', '< {%', '  request.variables.set("a", 1);', '%}',
    'PUT https://{{host}}/login?debug=1&lang=de HTTP/1.1', 'Content-Type: application/json', '# a comment', '',
    '> {% client.global.set("token", response.body.token); %}', ''
  ]);
});

test('visual editor: add, delete, duplicate and move blocks', () => {
  const text = '@a = 1\n\n### A\n# @name a\nGET http://a\n\n### B\nGET http://b\n';
  const op = (o, i) => visual.applyOperation(text, o, i);
  assert.deepStrictEqual(op('add', 0), { text: `${text}\n### New request\nGET https://\n`, index: 3 });
  assert.deepStrictEqual(op('delete', 1), { text: '@a = 1\n\n### B\nGET http://b\n', index: -1 });
  assert.deepStrictEqual(op('duplicate', 1), {
    text: '@a = 1\n\n### A\n# @name a\nGET http://a\n\n### A\n# @name a-copy\nGET http://a\n\n### B\nGET http://b\n', index: 2
  });
  const swapped = { text: '@a = 1\n\n### B\nGET http://b\n\n### A\n# @name a\nGET http://a\n' };
  assert.deepStrictEqual(op('up', 2), { ...swapped, index: 1 });
  assert.deepStrictEqual(op('down', 1), { ...swapped, index: 2 });
  assert.deepStrictEqual(op('down', 2), { text, index: 2 });
  // The first request of a file without ### gets one when it is moved.
  assert.strictEqual(visual.applyOperation('GET http://x\n\n### B\nGET y\n', 'down', 0).text, '### B\nGET y\n\n###\nGET http://x\n');
  assert.deepStrictEqual(visual.applyOperation('', 'add', 0), { text: '### New request\nGET https://\n', index: 0 });
});

test('environment editor: table of the public and private file', () => {
  const pub = { $shared: { user: 'u', size: 10 }, dev: { host: 'localhost', ssl: { verify: false } }, prod: { host: 'api' } };
  const priv = { dev: { password: 'p', host: 'secret-host' }, prod: { password: 'q' } };
  const m = envs.envModel(pub, priv);
  assert.deepStrictEqual(m.environments, ['$shared', 'dev', 'prod']);
  assert.deepStrictEqual(m.variables, ['user', 'size', 'host', 'ssl', 'password']);
  assert.deepStrictEqual(m.cells.size.$shared, { value: '10', private: false, kind: 'number', shadowsPublic: false });
  assert.deepStrictEqual(m.cells.host.dev, { value: 'secret-host', private: true, kind: 'string', shadowsPublic: true });
  assert.strictEqual(m.cells.ssl.dev.kind, 'json');
  assert.deepStrictEqual(envs.envModel(null, undefined), { environments: [], variables: [], cells: {} });

  const op = change => envs.applyEnvOperation(pub, priv, change);
  // Values keep their type where they can; the input objects are not changed.
  assert.strictEqual(op({ op: 'set', env: '$shared', name: 'size', value: '20', private: false }).pub.$shared.size, 20);
  assert.strictEqual(op({ op: 'set', env: '$shared', name: 'size', value: 'all', private: false }).pub.$shared.size, 'all');
  assert.strictEqual(pub.$shared.size, 10);
  assert.deepStrictEqual(op({ op: 'set', env: 'prod', name: 'token', value: 't', private: true }).priv.prod, { password: 'q', token: 't' });
  const moved = op({ op: 'move', env: 'prod', name: 'host', private: true });
  assert.deepStrictEqual([moved.pub.prod, moved.priv.prod], [{}, { password: 'q', host: 'api' }]);
  const deleted = op({ op: 'delete', env: 'dev', name: 'host' });
  assert.deepStrictEqual([deleted.pub.dev, deleted.priv.dev], [{ ssl: { verify: false } }, { password: 'p' }]);
  assert.deepStrictEqual(op({ op: 'addVariable', name: 'apiKey' }).pub.prod, { host: 'api', apiKey: '' });
  assert.ok(!('password' in op({ op: 'addVariable', name: 'password' }).pub.dev), 'already private: not added again');
  // A renamed variable or environment keeps its position.
  assert.deepStrictEqual(Object.keys(op({ op: 'renameVariable', from: 'host', to: 'baseUrl' }).pub.dev), ['baseUrl', 'ssl']);
  const renamed = op({ op: 'renameEnvironment', from: 'dev', to: 'local' });
  assert.deepStrictEqual([Object.keys(renamed.pub), Object.keys(renamed.priv)], [['$shared', 'local', 'prod'], ['local', 'prod']]);
  assert.deepStrictEqual(Object.keys(op({ op: 'deleteEnvironment', env: 'prod' }).priv), ['dev']);
  assert.deepStrictEqual(op({ op: 'deleteVariable', name: 'password' }).priv, { dev: { host: 'secret-host' }, prod: {} });
  assert.deepStrictEqual(op({ op: 'addEnvironment', env: 'test' }).pub.test, {});
  // Missing files are created only when something is written to them.
  assert.deepStrictEqual(envs.applyEnvOperation(null, null, { op: 'addVariable', name: 'host' }), { pub: { dev: { host: '' } }, priv: null });
  // JSON in the style of the file
  assert.strictEqual(envs.formatJson({ a: { b: 1 } }, '{\r\n    "x": {}\r\n}\r\n'), '{\r\n    "a": {\r\n        "b": 1\r\n    }\r\n}\r\n');
  assert.strictEqual(envs.formatJson({}, null), '{}\n');
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
