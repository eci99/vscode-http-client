'use strict';

// Smoke test of extension.js against a mocked VS Code API.
const Module = require('module');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-client-ws-'));
const commands = {};
const providers = {};
const shown = [];
let clipboard = '';
const state = new Map();

class EventEmitter { constructor() { this.l = []; this.event = f => this.l.push(f); } fire(x) { this.l.forEach(f => f(x)); } }
class Uri {
  constructor(o) { Object.assign(this, o); this.fsPath = o.path; }
  static file(p) { return new Uri({ scheme: 'file', path: p }); }
  static from(o) { return new Uri(o); }
  toString() { return `${this.scheme}:${this.path}${this.query ? '?' + this.query : ''}`; }
}
const makeDoc = (file, text) => ({
  uri: Uri.file(file), languageId: 'http-client', getText: () => text,
  lineAt: n => ({ text: text.split('\n')[n] }),
  getWordRangeAtPosition(pos, re) {
    const line = text.split('\n')[pos.line];
    const g = new RegExp(re.source, 'g'); let m;
    while ((m = g.exec(line))) if (m.index <= pos.character && pos.character <= m.index + m[0].length)
      return { s: m.index, e: m.index + m[0].length, line: pos.line, text: m[0] };
    return undefined;
  },
  getText_(r) { return r.text; }
});

const vscode = {
  Uri, EventEmitter,
  Range: class { constructor(...a) { this.a = a; } },
  CodeLens: class { constructor(r, c) { this.range = r; this.command = c; } },
  CompletionItem: class { constructor(l, k) { this.label = l; this.kind = k; } },
  CompletionItemKind: { Variable: 1, Function: 2 },
  MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s) { this.value += s; return this; } },
  Hover: class { constructor(c) { this.contents = c; } },
  StatusBarAlignment: { Right: 2 }, ViewColumn: { Beside: -2, Active: -1 }, ProgressLocation: { Window: 10 },
  env: { clipboard: { writeText: async t => { clipboard = t; } } },
  commands: { registerCommand: (id, f) => { commands[id] = f; return {}; } },
  languages: {
    registerCodeLensProvider: (s, p) => { providers.codeLens = p; return {}; },
    registerCompletionItemProvider: (s, p) => { providers.completion = p; return {}; },
    registerHoverProvider: (s, p) => { providers.hover = p; return {}; },
    setTextDocumentLanguage: async d => d
  },
  window: {
    activeTextEditor: null, visibleTextEditors: [],
    createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showTextDocument: async d => { shown.push(d); },
    withProgress: async (o, f) => f(),
    setStatusBarMessage: () => {}, showWarningMessage: m => { throw new Error('warning: ' + m); },
    showErrorMessage: m => { throw new Error('error: ' + m); }, showInformationMessage: async () => undefined,
    showQuickPick: async items => items.find(i => i.label.endsWith('B')),
    onDidChangeActiveTextEditor: () => ({})
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(dir) }],
    getWorkspaceFolder: () => ({ uri: Uri.file(dir) }),
    getConfiguration: () => ({ get: (k, d) => d }),
    textDocuments: [],
    saveAllCalls: 0,
    saveAll: async () => { vscode.workspace.saveAllCalls++; return true; },
    openTextDocument: async uri => ({ uri, languageId: 'http-client-response', getText: () => providers.content.provideTextDocumentContent(uri) }),
    registerTextDocumentContentProvider: (s, p) => { providers.content = p; return {}; },
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} })
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization || null }));
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port;
    fs.writeFileSync(path.join(dir, 'http-client.env.json'), JSON.stringify({ dev: { host: `127.0.0.1:${port}` } }));
    fs.writeFileSync(path.join(dir, 'http-client.private.env.json'), JSON.stringify({ dev: { secret: 's3' } }));
    const text = '### A\nGET http://{{host}}/a\nAuthorization: {{secret}}\n\n> {%\nclient.test("ok", () => client.assert(response.body.auth === "s3"));\nclient.global.set("p", response.body.path);\n%}\n\n### B\nGET http://{{host}}/{{p}}\n';
    const file = path.join(dir, 'api.http');
    fs.writeFileSync(file, text);
    const doc = makeDoc(file, text);
    vscode.window.activeTextEditor = { document: doc, selection: { active: { line: 1 } } };
    vscode.workspace.textDocuments.push(doc);

    const ext = require('../extension');
    ext.activate({ subscriptions: [], workspaceState: { get: (k, d) => state.has(k) ? state.get(k) : d, update: async (k, v) => state.set(k, v) } });

    // choose environment "dev" directly
    state.set('httpClient.env', 'dev');

    const lenses = providers.codeLens.provideCodeLenses(doc);
    assert.deepStrictEqual(lenses.map(l => l.command.title), ['▶▶ Run all requests', 'Environment: dev', '▶ Send Request', '▶ Send Request']);

    await commands['httpClient.runAll'](doc.uri);
    const content = providers.content.provideTextDocumentContent(shown[0].uri);
    assert.ok(content.includes('✓ ok'), content);
    assert.ok(content.includes('// Environment: dev'), content);
    assert.ok(content.includes('"path": "//a"') || content.includes('"path": "/a"'), content);
    assert.deepStrictEqual(state.get('httpClient.globals'), { p: '/a' });
    assert.strictEqual(vscode.workspace.saveAllCalls, 1);

    assert.deepStrictEqual(state.get('httpClient.lastRun'), { uri: doc.uri.toString(), all: true });
    await commands['httpClient.resendLast']();
    assert.ok(providers.content.provideTextDocumentContent(shown[0].uri).includes('✓ ok'));

    await commands['httpClient.pickRequest']();
    const picked = providers.content.provideTextDocumentContent(shown[0].uri);
    assert.ok(picked.startsWith('// B\n') && !picked.includes('// A\n'), picked);
    assert.strictEqual(state.get('httpClient.lastRun').line, text.split('\n').indexOf('GET http://{{host}}/{{p}}'));

    const items = providers.completion.provideCompletionItems(doc, { line: 1, character: 13 });
    assert.ok(items.some(i => i.label === 'host') && items.some(i => i.label === '$uuid'));

    const hover = providers.hover.provideHover({ ...doc, getText: r => r ? r.text : text }, { line: 1, character: 15 });
    assert.ok(hover.contents.value.includes('environment'), hover.contents.value);

    await commands['httpClient.copyAsCurl']();
    assert.ok(clipboard.includes(`http://127.0.0.1:${port}/a`) && clipboard.includes('Authorization: s3'), clipboard);

    console.log('✓ extension smoke test passed');
    console.log(content.split('\n').slice(0, 12).join('\n'));
  } catch (e) {
    console.error('✗', e); process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
