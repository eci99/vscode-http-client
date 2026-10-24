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
const opened = [];
let hits = 0;
let clipboard = '';
const state = new Map();

class EventEmitter { constructor() { this.l = []; this.event = f => this.l.push(f); } fire(x) { this.l.forEach(f => f(x)); } }
class Uri {
  constructor(o) { Object.assign(this, o); this.fsPath = o.path; }
  static file(p) { return new Uri({ scheme: 'file', path: p }); }
  static from(o) { return new Uri(o); }
  static joinPath(u, ...p) { return Uri.file(path.join(u.path, ...p)); }
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
  Uri, EventEmitter, TabInputText: class {}, TabInputCustom: class {},
  SnippetString: class { constructor(v) { this.value = v; } },
  Range: class { constructor(...a) { this.a = a; } },
  Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
  DiagnosticSeverity: { Error: 0 },
  DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange }); } },
  SymbolKind: { Function: 11 },
  DocumentLink: class { constructor(range, target) { this.range = range; this.target = target; } },
  CodeLens: class { constructor(r, c) { this.range = r; this.command = c; } },
  CompletionItem: class { constructor(l, k) { this.label = l; this.kind = k; } },
  CompletionItemKind: { Variable: 1, Function: 2 },
  MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s) { this.value += s; return this; } },
  Hover: class { constructor(c) { this.contents = c; } },
  EndOfLine: { LF: 1, CRLF: 2 },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  QuickPickItemKind: { Separator: -1 },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push([uri, range, text]); } },
  StatusBarAlignment: { Right: 2 }, ViewColumn: { Beside: -2, Active: -1 }, ProgressLocation: { Window: 10 },
  env: { clipboard: { writeText: async t => { clipboard = t; } } },
  commands: {
    registerCommand: (id, f) => { commands[id] = f; return {}; },
    executed: [],
    executeCommand: async (id, uri, ...rest) => {
      vscode.commands.executed.push([id, uri, ...rest]);
      if (id !== 'vscode.open') return;
      opened.push(uri.fsPath);
      const group = { viewColumn: 2 };
      vscode.window.tabGroups.all = [{ ...group, tabs: [{ input: { uri }, group }] }];
    }
  },
  languages: {
    registerCodeLensProvider: (s, p) => { providers[s.language === 'http-client' ? 'codeLens' : 'responseLens'] = p; return {}; },
    registerCompletionItemProvider: (s, p) => { providers.completion = p; return {}; },
    registerHoverProvider: (s, p) => { providers.hover = p; return {}; },
    registerDocumentLinkProvider: (s, p) => { providers.links = p; return {}; },
    registerDocumentSymbolProvider: (s, p) => { providers.symbols = p; return {}; },
    createDiagnosticCollection: () => {
      providers.diagnostics = new Map();
      return { set: (u, d) => providers.diagnostics.set(u.path, d), delete: u => providers.diagnostics.delete(u.path), dispose() {} };
    },
    setTextDocumentLanguage: async d => d
  },
  window: {
    activeTextEditor: null, visibleTextEditors: [], tabGroups: { all: [], onDidChangeTabs: () => ({}) },
    createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showTextDocument: async d => { shown.push(d); },
    withProgress: async (o, f) => f(),
    setStatusBarMessage: () => {}, showWarningMessage: m => { throw new Error('warning: ' + m); },
    showErrorMessage: m => { throw new Error('error: ' + m); }, showInformationMessage: async () => undefined,
    showQuickPick: async items => items.find(i => i.label.endsWith('B')),
    onDidChangeActiveTextEditor: () => ({}),
    registerCustomEditorProvider: (type, p) => { providers.visual = p; return {}; },
    createWebviewPanel: () => {
      let onMsg;
      const panel = {
        posted: [], send: m => onMsg(m), reveal() {}, onDidDispose() {},
        webview: {
          html: '', cspSource: 'csp', asWebviewUri: u => u,
          postMessage: async m => { panel.posted.push(m); },
          onDidReceiveMessage: f => { onMsg = f; return { dispose() {} }; }
        }
      };
      providers.envPanel = panel;
      return panel;
    },
    onDidChangeWindowState: () => ({})
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(dir) }],
    getWorkspaceFolder: () => ({ uri: Uri.file(dir) }),
    getConfiguration: () => ({ get: (k, d) => d }),
    textDocuments: [],
    fs: {
      isWritableFileSystem: scheme => scheme === 'file',
      writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data)
    },
    saveAllCalls: 0,
    saveAll: async () => { vscode.workspace.saveAllCalls++; return true; },
    applyEdit: async edit => {
      for (const [uri, range, text] of edit.edits) {
        const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === uri.toString());
        const lines = d.text.split('\n');
        const off = (l, c) => lines.slice(0, l).reduce((n, x) => n + x.length + 1, 0) + c;
        const [sl, sc, el, ec] = range.a.length === 2 ? [range.a[0].line, range.a[0].character, range.a[1].line, range.a[1].character] : range.a;
        d.text = d.text.slice(0, off(sl, sc)) + text + d.text.slice(off(el, ec));
        d.version++;
      }
      return true;
    },
    openTextDocument: async uri => {
      if (uri.scheme !== 'file') return { uri, languageId: 'http-client-response', getText: () => providers.content.provideTextDocumentContent(uri) };
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (open) return open;
      const d = {
        uri, version: 1, text: fs.readFileSync(uri.fsPath, 'utf8'), getText() { return this.text; },
        get lineCount() { return this.text.split('\n').length; },
        lineAt(n) { return { range: { end: new vscode.Position(n, this.text.split('\n')[n].length) } }; },
        save: async () => { fs.writeFileSync(uri.fsPath, d.text); return true; }
      };
      vscode.workspace.textDocuments.push(d);
      return d;
    },
    registerTextDocumentContentProvider: (s, p) => { providers.content = p; return {}; },
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    onDidOpenTextDocument: f => { providers.onOpen = f; return {}; },
    onDidCreateFiles: () => ({}),
    onDidDeleteFiles: () => ({}),
    onDidRenameFiles: () => ({}),
    onWillRenameFiles: () => ({}),
    onDidChangeTextDocument: () => ({}),
    onDidCloseTextDocument: () => ({})
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization || null, hit: ++hits }));
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
    ext.activate({ subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..')), workspaceState: { get: (k, d) => state.has(k) ? state.get(k) : d, update: async (k, v) => state.set(k, v) } });

    // choose environment "dev" directly
    state.set('httpClient.env', 'dev');

    // Outline: one symbol per request, from its ### line to its last line
    const symbols = providers.symbols.provideDocumentSymbols(doc);
    assert.deepStrictEqual(symbols.map(s => [s.name, s.detail, s.range.a, s.selectionRange.a]), [
      ['A', 'GET http://{{host}}/a', [0, 0, 8, 0], [1, 0, 1, 21]],
      ['B', 'GET http://{{host}}/{{p}}', [9, 0, 11, 0], [10, 0, 10, 25]]
    ]);

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

    // Methods, headers and the script API
    const isDoc = makeDoc(file, '### X\nPO\n\n### Y\nGET http://x\nContent-Type: \n\n> {%\nclient.global.get("\n%}\n');
    const labels = (line, character) => (providers.completion.provideCompletionItems(isDoc, { line, character }) || []).map(i => i.label);
    assert.ok(labels(1, 2).includes('POST'));
    assert.ok(labels(5, 14).includes('application/json'));
    assert.ok(labels(5, 0).includes('Content-Type'));
    assert.deepStrictEqual(labels(8, 19), ['p'], 'global variables set by the handler above');
    const apiDoc = makeDoc(file, 'GET http://x\n\n> {% client.te %}\n');
    const api = providers.completion.provideCompletionItems(apiDoc, { line: 2, character: 14 });
    assert.ok(api.some(i => i.label === 'test' && i.insertText.value.startsWith('test("')));
    const apiHover = providers.hover.provideHover({ ...apiDoc, getText: r => r ? r.text : apiDoc.getText() }, { line: 2, character: 6 });
    assert.ok(apiHover, 'hover on client');

    // Files after < <@ > and >>
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'body.json'), '{}');
    fs.writeFileSync(path.join(dir, 'handler.js'), '');
    const fileLabels = (line) => {
      const fileDoc = makeDoc(file, `GET http://x\n\n${line}`);
      const found = providers.completion.provideCompletionItems(fileDoc, { line: 2, character: line.length });
      return found && found.map(i => i.label).sort();
    };
    assert.deepStrictEqual(fileLabels('< ./').filter(l => l === 'data/' || l === 'handler.js'), ['data/', 'handler.js']);
    assert.deepStrictEqual(fileLabels('<@ ./data/'), ['body.json']);
    assert.ok(fileLabels('> ./').includes('handler.js') && !fileLabels('> ./').includes('api.http'));
    assert.ok(fileLabels('>> ./').includes('api.http'));
    assert.strictEqual(fileLabels('GET http://x'), undefined);
    assert.deepStrictEqual(fileLabels('< ./missing/'), []);

    // Links for files that exist, errors for those that do not
    const refText = 'POST http://x\n\n< ./data/body.json\n< ./missing.json\n< {{dir}}/x.json\n\n> ./handler.js\n>> ./out/new.json\n';
    const refDoc = makeDoc(path.join(dir, 'refs.http'), refText);
    const links = providers.links.provideDocumentLinks(refDoc);
    assert.deepStrictEqual(links.map(l => l.target.path), [path.join(dir, 'data', 'body.json'), path.join(dir, 'handler.js')]);
    providers.onOpen(refDoc);
    assert.deepStrictEqual(providers.diagnostics.get(refDoc.uri.path).map(d => d.message), ['File not found: ./missing.json']);

    // "Open in viewer" reuses one file; while its tab is open, it follows new runs
    await commands['httpClient.openBody'](0);
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(path.basename(opened[0]), 'response.json');
    const before = fs.readFileSync(opened[0], 'utf8');
    await commands['httpClient.resendLast']();
    assert.strictEqual(opened.length, 1, 'same content type: the open tab is reused');
    assert.notStrictEqual(fs.readFileSync(opened[0], 'utf8'), before);
    await commands['httpClient.openBody'](0);
    assert.deepStrictEqual(opened, [opened[0], opened[0]]);

    await commands['httpClient.copyAsCurl']();
    assert.ok(clipboard.includes(`http://127.0.0.1:${port}/a`) && clipboard.includes('Authorization: s3'), clipboard);

    // Visual editor: the webview gets the blocks, edits change only their block
    const vdoc = {
      uri: Uri.file(path.join(dir, 'visual.http')), languageId: 'http-client', version: 1, eol: 1,
      text: '@v = 1\n\n### A\n# @name a\nGET http://{{host}}/a?x=1\nAccept: */*\n\n### B\nPOST http://{{host}}/b\n\n{"a":1}\n',
      getText() { return this.text; }
    };
    vscode.workspace.textDocuments.push(vdoc);
    const posted = [];
    let onMessage;
    const makePanel = (sink, onMsg) => ({
      viewColumn: 1, active: true,
      webview: {
        options: {}, html: '', cspSource: 'csp', asWebviewUri: u => u,
        postMessage: async m => { sink.push(m); },
        onDidReceiveMessage: f => { onMsg(f); return { dispose() {} }; }
      },
      onDidDispose() {}, onDidChangeViewState() { return { dispose() {} }; },
      dispose() { this.disposed = true; }
    });
    providers.visual.resolveCustomTextEditor(vdoc, makePanel(posted, f => { onMessage = f; }));
    const message = async m => { onMessage(m); await new Promise(r => setTimeout(r, 50)); };
    await message({ type: 'ready' });
    assert.ok(posted.find(m => m.type === 'init').meta.methods.includes('PATCH'));
    const vmodel = posted.find(m => m.type === 'model');
    assert.deepStrictEqual(vmodel.environments, ['dev']);
    assert.strictEqual(vmodel.environment, 'dev');
    assert.deepStrictEqual(vmodel.blocks.map(b => b.request && b.request.method), [null, 'GET', 'POST']);
    assert.deepStrictEqual(vmodel.blocks[1].request.query, [{ name: 'x', value: '1', eq: true }]);
    const edited = vmodel.blocks[1];
    edited.request.method = 'PUT';
    edited.request.query.push({ name: 'y', value: '{{v}}', eq: true });
    edited.request.headers.push({ name: 'X-Test', value: 'yes' });
    await message({ type: 'edit', version: 1, changes: [{ index: 1, block: edited }] });
    assert.strictEqual(vdoc.text, '@v = 1\n\n### A\n# @name a\nPUT http://{{host}}/a?x=1&y={{v}}\nAccept: */*\nX-Test: yes\n\n### B\nPOST http://{{host}}/b\n\n{"a":1}\n');
    assert.deepStrictEqual(posted[posted.length - 1], { type: 'ack', ok: true, version: 2 });
    await message({ type: 'edit', version: 1, changes: [{ index: 1, block: vmodel.blocks[2] }] });
    assert.strictEqual(posted.filter(m => m.type === 'ack').pop().ok, false, 'an edit of an old version is dropped');
    await message({ type: 'op', op: 'duplicate', index: 2 });
    assert.strictEqual(vdoc.text.split('### B').length, 3);
    assert.deepStrictEqual(posted.filter(m => m.type === 'focus').pop(), { type: 'focus', index: 3 });
    const hitsBefore = hits;
    await message({ type: 'send', index: 1 });
    assert.strictEqual(hits, hitsBefore + 1);
    const sent = providers.content.provideTextDocumentContent(shown[0].uri);
    assert.ok(sent.includes('/a?x=1&y=1'), sent);

    // A file with merge conflicts is shown in the text editor
    const cdoc = {
      uri: Uri.file(path.join(dir, 'conflict.http')), languageId: 'http-client', version: 1, eol: 1,
      text: '### A\n<<<<<<< HEAD\nGET http://a\n=======\nGET http://b\n>>>>>>> branch\n', getText() { return this.text; }
    };
    const cposted = [];
    let conMessage;
    const cpanel = makePanel(cposted, f => { conMessage = f; });
    providers.visual.resolveCustomTextEditor(cdoc, cpanel);
    conMessage({ type: 'ready' });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(cposted.find(m => m.type === 'model').textOnly, 'conflict');
    assert.ok(vscode.commands.executed.some(([id, uri, type]) => id === 'vscode.openWith' && uri === cdoc.uri && type === 'default'));
    assert.ok(cpanel.disposed);
    // A version from git (left side of a diff) is not shown as a form either
    const gposted = [];
    let gitMessage;
    const gdoc = { ...vdoc, uri: Uri.from({ scheme: 'git', path: vdoc.uri.path }) };
    providers.visual.resolveCustomTextEditor(gdoc, makePanel(gposted, f => { gitMessage = f; }));
    gitMessage({ type: 'ready' });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(gposted.find(m => m.type === 'model').textOnly, 'diff');
    assert.ok(vscode.commands.executed.some(([id]) => id === 'workbench.action.reopenTextEditor'));

    // Environment editor: both files as one table; changes are written to the files
    await commands['httpClient.editEnvironments'](Uri.file(path.join(dir, 'http-client.env.json')));
    const envPanel = providers.envPanel;
    const envMessage = async m => { envPanel.send(m); await new Promise(r => setTimeout(r, 50)); };
    await envMessage({ type: 'ready' });
    const envTable = envPanel.posted.pop();
    assert.deepStrictEqual([envTable.environments, envTable.variables, envTable.active], [['dev'], ['host', 'secret'], 'dev']);
    assert.strictEqual(envTable.cells.secret.dev.private, true);
    await envMessage({ type: 'op', change: { op: 'set', env: 'dev', name: 'token', value: 't1', private: true } });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'http-client.private.env.json'), 'utf8')), { dev: { secret: 's3', token: 't1' } });
    await envMessage({ type: 'op', change: { op: 'renameEnvironment', from: 'dev', to: 'local' } });
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'http-client.env.json'), 'utf8'))), ['local']);
    assert.strictEqual(state.get('httpClient.env'), 'local', 'the selected environment follows the rename');
    assert.deepStrictEqual(envPanel.posted.pop().environments, ['local']);

    console.log('✓ extension smoke test passed');
    console.log(content.split('\n').slice(0, 12).join('\n'));
  } catch (e) {
    console.error('✗', e); process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
