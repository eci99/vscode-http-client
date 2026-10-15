'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parse, findRequestAt } = require('./src/parser');
const { runRequest, buildRequest, toCurl } = require('./src/runner');
const { CookieJar } = require('./src/cookies');
const { formatResults } = require('./src/format');
const { DYNAMIC_VARIABLES, describeVariable } = require('./src/variables');

const LANG = 'http-client';
const RESPONSE_SCHEME = 'http-client-response';
const ENV_FILE = 'http-client.env.json';
const PRIVATE_ENV_FILE = 'http-client.private.env.json';
const NO_ENV = '<no environment>';

let ctxGlobal;
let output;
let statusBar;
let cookieJar;
let globals;
let lastRun; // { uri, line } for a single request, { uri, all: true } for "run all"

// ------------------------------------------------------------------ environments

function workspaceRootFor(uri) {
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (folder) return folder.uri.fsPath;
  const first = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return first ? first.uri.fsPath : null;
}

function baseDirFor(doc) {
  if (doc.uri.scheme === 'file') return path.dirname(doc.uri.fsPath);
  return workspaceRootFor(doc.uri) || process.cwd();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fs.existsSync(file)) vscode.window.showWarningMessage(`Cannot read ${path.basename(file)}: ${e.message}`);
    return null;
  }
}

/** Search the directory of the .http file and its parents (up to the workspace root) for env files. */
function findEnvFiles(doc) {
  const root = workspaceRootFor(doc.uri);
  let dir = baseDirFor(doc);
  while (dir) {
    const pub = path.join(dir, ENV_FILE);
    const priv = path.join(dir, PRIVATE_ENV_FILE);
    if (fs.existsSync(pub) || fs.existsSync(priv)) return { dir, pub, priv };
    if (!root || dir === root || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return null;
}

function loadEnvironments(doc) {
  const files = findEnvFiles(doc);
  if (!files) return { names: [], get: () => ({}), files: null };
  const pub = readJson(files.pub) || {};
  const priv = readJson(files.priv) || {};
  const names = [...new Set([...Object.keys(pub), ...Object.keys(priv)])].filter(n => !n.startsWith('$'));
  const get = name => ({
    ...(pub.$shared || {}), ...(priv.$shared || {}),
    ...(name ? pub[name] || {} : {}), ...(name ? priv[name] || {} : {})
  });
  return { names, get, files };
}

function selectedEnv() {
  return ctxGlobal.workspaceState.get('httpClient.env', null);
}

function updateStatusBar() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANG) { statusBar.hide(); return; }
  const env = selectedEnv();
  statusBar.text = `$(globe) ${env || 'No Environment'}`;
  statusBar.tooltip = 'HTTP-Client: select environment';
  statusBar.show();
}

/**
 * Where to look for env files when no .http editor is active: the active .http editor,
 * the file of the last run, any open .http file, then the workspace root.
 * Only `uri` is needed by findEnvFiles/baseDirFor.
 */
function envAnchor() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === LANG) return editor.document;
  if (lastRun) return { uri: lastRun.uri };
  const open = vscode.workspace.textDocuments.find(d => d.languageId === LANG);
  if (open) return open;
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? { uri: vscode.Uri.joinPath(folder.uri, 'requests.http') } : null;
}

async function selectEnvironment() {
  const doc = envAnchor();
  const envs = doc ? loadEnvironments(doc) : { names: [], files: null };
  if (!envs.names.length) {
    const choice = await vscode.window.showInformationMessage(
      `No environments found. Create ${ENV_FILE}?`, 'Create');
    if (choice) await createEnvFile();
    return;
  }
  const current = selectedEnv();
  const picked = await vscode.window.showQuickPick(
    [NO_ENV, ...envs.names].map(n => ({ label: n, description: n === current ? '(active)' : '' })),
    { placeHolder: `Environment (${path.relative(workspaceRootFor(doc.uri) || '', envs.files.dir) || '.'})` });
  if (!picked) return;
  await ctxGlobal.workspaceState.update('httpClient.env', picked.label === NO_ENV ? null : picked.label);
  updateStatusBar();
  codeLensEmitter.fire();
}

async function createEnvFile() {
  const editor = vscode.window.activeTextEditor;
  const dir = editor && editor.document.uri.scheme === 'file'
    ? path.dirname(editor.document.uri.fsPath)
    : workspaceRootFor(editor && editor.document.uri);
  if (!dir) { vscode.window.showErrorMessage('Open a folder first.'); return; }
  const pub = path.join(dir, ENV_FILE);
  const priv = path.join(dir, PRIVATE_ENV_FILE);
  if (!fs.existsSync(pub)) {
    fs.writeFileSync(pub, JSON.stringify({
      dev: { host: 'localhost:8080' },
      prod: { host: 'api.example.com' }
    }, null, 2) + '\n');
  }
  if (!fs.existsSync(priv)) {
    fs.writeFileSync(priv, JSON.stringify({
      dev: { password: 'secret' },
      prod: { password: '' }
    }, null, 2) + '\n');
  }
  await vscode.window.showTextDocument(vscode.Uri.file(pub));
  vscode.window.showInformationMessage(`Created ${ENV_FILE}. Keep ${PRIVATE_ENV_FILE} out of version control.`);
}

// ------------------------------------------------------------------ response view

const responses = new Map();
const responseEmitter = new vscode.EventEmitter();
const responseProvider = {
  onDidChange: responseEmitter.event,
  provideTextDocumentContent: uri => responses.get(uri.toString()) || ''
};

const RESPONSE_URI = vscode.Uri.from({ scheme: RESPONSE_SCHEME, path: '/HTTP-Client: response' });

function responseUriFor() {
  return RESPONSE_URI;
}

async function showResponse(doc, content, reveal = false) {
  const uri = responseUriFor(doc);
  responses.set(uri.toString(), content);
  responseEmitter.fire(uri);
  const group = vscode.window.tabGroups.all.find(g => g.tabs.some(t =>
    t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()));
  if (group && !reveal) return;
  let rdoc = await vscode.workspace.openTextDocument(uri);
  if (rdoc.languageId !== 'http-client-response') {
    rdoc = await vscode.languages.setTextDocumentLanguage(rdoc, 'http-client-response');
  }
  const cfg = vscode.workspace.getConfiguration('httpClient');
  await vscode.window.showTextDocument(rdoc, {
    viewColumn: group ? group.viewColumn
      : cfg.get('responseViewColumn') === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: false
  });
}

// ------------------------------------------------------------------ running

function persistState() {
  ctxGlobal.workspaceState.update('httpClient.globals', globals);
  ctxGlobal.workspaceState.update('httpClient.cookies', cookieJar.toJSON());
}

function resolveTarget(uriArg, lineArg) {
  let editor = vscode.window.activeTextEditor;
  let doc = editor && editor.document;
  if (uriArg instanceof vscode.Uri) {
    doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriArg.toString()) || doc;
  }
  if (!doc || doc.languageId !== LANG) {
    vscode.window.showWarningMessage('Open a .http file to send a request.');
    return null;
  }
  const line = typeof lineArg === 'number' ? lineArg
    : editor && editor.document === doc ? editor.selection.active.line : 0;
  return { doc, line };
}

function makeContext(doc, parsed) {
  const cfg = vscode.workspace.getConfiguration('httpClient');
  const envName = selectedEnv();
  const envs = loadEnvironments(doc);
  if (envName && !envs.names.includes(envName)) {
    output.appendLine(`Environment "${envName}" not found – running without environment.`);
  }
  return {
    fileVars: parsed.fileVariables,
    envVars: envs.get(envs.names.includes(envName) ? envName : null),
    envName,
    envFound: envs.names.includes(envName),
    globals,
    baseDir: baseDirFor(doc),
    cookieJar,
    timeoutMs: cfg.get('timeoutSeconds', 60) * 1000,
    followRedirects: cfg.get('followRedirects', true)
  };
}

function logResult(r) {
  const ts = new Date().toLocaleTimeString();
  const status = r.error ? `ERROR ${r.error}` : `${r.response.status} ${r.response.statusText} (${r.response.durationMs} ms)`;
  output.appendLine(`[${ts}] ${r.request ? `${r.request.method} ${r.request.url}` : r.title} → ${status}`);
  r.logs.forEach(l => output.appendLine(`    ${l}`));
  r.tests.forEach(t => output.appendLine(`    ${t.passed ? '✓' : '✗'} ${t.name}${t.passed ? '' : `: ${t.error}`}`));
}

async function execute(doc, requests) {
  const cfg = vscode.workspace.getConfiguration('httpClient');
  if (cfg.get('saveAllBeforeRequest', true)) await vscode.workspace.saveAll(false);
  const parsed = parse(doc.getText());
  const ctx = makeContext(doc, parsed);
  const results = [];
  const environment = !ctx.envName ? 'none' : ctx.envFound ? ctx.envName : `${ctx.envName} (not found – none used)`;
  const pending = requests.map(r => `// Sending ${r.name || r.title || `${r.method} ${r.url}`} …`).join('\n');
  await showResponse(doc, pending + '\n');

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'HTTP-Client: sending request' },
    async () => {
      for (const req of requests) {
        const r = await runRequest(req, ctx);
        results.push(r);
        logResult(r);
        responses.set(responseUriFor(doc).toString(),
          formatResults(results, { prettyJson: cfg.get('prettyPrintJson', true), environment }));
        responseEmitter.fire(responseUriFor(doc));
      }
    });
  persistState();

  const failed = results.flatMap(r => r.tests).filter(t => !t.passed).length;
  const errors = results.filter(r => r.error).length;
  const badStatus = results.filter(r => !r.error && r.response && r.response.status >= 400).length;
  if (errors || badStatus) {
    await showResponse(doc, responses.get(responseUriFor(doc).toString()), true);
  }
  if (errors) vscode.window.setStatusBarMessage(`$(error) HTTP-Client: ${errors} request(s) failed`, 5000);
  else if (failed) vscode.window.setStatusBarMessage(`$(warning) HTTP-Client: ${failed} test(s) failed`, 5000);
}

async function sendRequest(uriArg, lineArg) {
  const t = resolveTarget(uriArg, lineArg);
  if (!t) return;
  const parsed = parse(t.doc.getText());
  const req = findRequestAt(parsed, t.line);
  if (!req) { vscode.window.showWarningMessage('No request found at cursor.'); return; }
  rememberLastRun({ uri: t.doc.uri, line: t.line });
  await execute(t.doc, [req]);
}

async function runAll(uriArg) {
  const t = resolveTarget(uriArg, 0);
  if (!t) return;
  const parsed = parse(t.doc.getText());
  if (!parsed.requests.length) { vscode.window.showWarningMessage('No requests in this file.'); return; }
  rememberLastRun({ uri: t.doc.uri, all: true });
  await execute(t.doc, parsed.requests);
}

/** The .http file to pick a request from: the active one, else the file of the last run, else any open one. */
async function requestFileAnchor() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === LANG) return editor.document;
  if (lastRun) {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === lastRun.uri.toString());
    if (open) return open;
    try { return await vscode.workspace.openTextDocument(lastRun.uri); } catch (e) { /* fall through */ }
  }
  return vscode.workspace.textDocuments.find(d => d.languageId === LANG) || null;
}

async function pickRequest() {
  const doc = await requestFileAnchor();
  if (!doc) { vscode.window.showWarningMessage('Open a .http file to pick a request from.'); return; }
  const parsed = parse(doc.getText());
  if (!parsed.requests.length) { vscode.window.showWarningMessage('No requests in this file.'); return; }
  const last = lastRun && !lastRun.all && lastRun.uri.toString() === doc.uri.toString()
    ? findRequestAt(parsed, lastRun.line) : null;
  const items = parsed.requests.map(req => {
    const target = `${req.method} ${req.url}`;
    const label = req.name || req.title || target;
    return {
      label: req === last ? `$(history) ${label}` : label,
      description: label === target ? '' : target,
      detail: `line ${req.line + 1}`,
      req
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Send a request from ${path.basename(doc.uri.path)}`,
    matchOnDescription: true
  });
  if (!picked) return;
  rememberLastRun({ uri: doc.uri, line: picked.req.line });
  await execute(doc, [picked.req]);
}

function rememberLastRun(run) {
  lastRun = run;
  ctxGlobal.workspaceState.update('httpClient.lastRun', { ...run, uri: run.uri.toString() });
}

async function resendLast() {
  if (!lastRun) { vscode.window.showWarningMessage('No request has been sent yet.'); return; }
  let doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === lastRun.uri.toString());
  if (!doc) {
    try {
      doc = await vscode.workspace.openTextDocument(lastRun.uri);
    } catch (e) {
      vscode.window.showWarningMessage(`Cannot open ${lastRun.uri.fsPath}: ${e.message}`);
      return;
    }
  }
  const parsed = parse(doc.getText());
  const requests = lastRun.all ? parsed.requests : [findRequestAt(parsed, lastRun.line)].filter(Boolean);
  if (!requests.length) { vscode.window.showWarningMessage('The last request no longer exists.'); return; }
  await execute(doc, requests);
}

async function copyAsCurl() {
  const t = resolveTarget();
  if (!t) return;
  const parsed = parse(t.doc.getText());
  const req = findRequestAt(parsed, t.line);
  if (!req) return;
  const ctx = makeContext(t.doc, parsed);
  try {
    const built = buildRequest(req, {
      requestVars: {}, fileVars: ctx.fileVars, globals: ctx.globals, envVars: ctx.envVars
    }, ctx.baseDir);
    await vscode.env.clipboard.writeText(toCurl(built));
    vscode.window.setStatusBarMessage('$(check) cURL command copied', 3000);
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot build request: ${e.message}`);
  }
}

// ------------------------------------------------------------------ editor features

const codeLensEmitter = new vscode.EventEmitter();
const codeLensProvider = {
  onDidChangeCodeLenses: codeLensEmitter.event,
  provideCodeLenses(doc) {
    const parsed = parse(doc.getText());
    const lenses = [];
    if (parsed.requests.length) {
      const top = new vscode.Range(0, 0, 0, 0);
      lenses.push(new vscode.CodeLens(top, { title: '▶▶ Run all requests', command: 'httpClient.runAll', arguments: [doc.uri] }));
      lenses.push(new vscode.CodeLens(top, {
        title: `Environment: ${selectedEnv() || 'none'}`, command: 'httpClient.selectEnvironment'
      }));
    }
    for (const r of parsed.requests) {
      const range = new vscode.Range(r.line, 0, r.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: '▶ Send Request', command: 'httpClient.sendRequest', arguments: [doc.uri, r.line]
      }));
    }
    return lenses;
  }
};

function variableState(doc) {
  const parsed = parse(doc.getText());
  const envs = loadEnvironments(doc);
  const envName = selectedEnv();
  return {
    parsed, envs,
    state: {
      requestVars: {}, fileVars: parsed.fileVariables, globals,
      envVars: envs.get(envs.names.includes(envName) ? envName : null)
    }
  };
}

const completionProvider = {
  provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (!/\{\{[^}]*$/.test(before)) return undefined;
    const { envs, state } = variableState(doc);
    const items = [];
    const add = (name, detail, kind) => {
      const it = new vscode.CompletionItem(name, kind);
      it.detail = detail;
      items.push(it);
    };
    const envKeys = new Set();
    envs.names.forEach(n => Object.keys(envs.get(n)).forEach(k => envKeys.add(k)));
    Object.keys(envs.get(null)).forEach(k => envKeys.add(k));
    envKeys.forEach(k => add(k, 'environment variable', vscode.CompletionItemKind.Variable));
    Object.keys(state.fileVars).forEach(k => add(k, 'file variable', vscode.CompletionItemKind.Variable));
    Object.keys(globals).forEach(k => add(k, 'global variable (client.global)', vscode.CompletionItemKind.Variable));
    DYNAMIC_VARIABLES.forEach(([n, d]) => add(n, d, vscode.CompletionItemKind.Function));
    return items;
  }
};

const hoverProvider = {
  provideHover(doc, pos) {
    const range = doc.getWordRangeAtPosition(pos, /\{\{\s*[^{}]+?\s*\}\}/);
    if (!range) return undefined;
    const name = doc.getText(range).slice(2, -2).trim();
    const { state } = variableState(doc);
    const info = describeVariable(state, name);
    const md = new vscode.MarkdownString();
    if (!info) md.appendMarkdown(`**${name}** — _unresolved_ (environment: ${selectedEnv() || 'none'})`);
    else if (info.source === 'dynamic') md.appendMarkdown(`**${name}** — dynamic variable`);
    else md.appendMarkdown(`**${name}** (${info.source})\n\n`).appendCodeblock(String(info.value), 'text');
    return new vscode.Hover(md, range);
  }
};

// ------------------------------------------------------------------ activation

function activate(context) {
  ctxGlobal = context;
  output = vscode.window.createOutputChannel('HTTP-Client');
  globals = { ...context.workspaceState.get('httpClient.globals', {}) };
  cookieJar = new CookieJar(context.workspaceState.get('httpClient.cookies', []));
  const savedRun = context.workspaceState.get('httpClient.lastRun');
  lastRun = savedRun ? { ...savedRun, uri: vscode.Uri.parse(savedRun.uri) } : undefined;

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'httpClient.selectEnvironment';
  updateStatusBar();

  const selector = { language: LANG };
  const envWatcher = vscode.workspace.createFileSystemWatcher('**/http-client*.env.json');
  envWatcher.onDidChange(() => codeLensEmitter.fire());
  envWatcher.onDidCreate(() => codeLensEmitter.fire());

  context.subscriptions.push(
    output, statusBar, envWatcher,
    vscode.workspace.registerTextDocumentContentProvider(RESPONSE_SCHEME, responseProvider),
    vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
    vscode.languages.registerCompletionItemProvider(selector, completionProvider, '{'),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
    vscode.commands.registerCommand('httpClient.sendRequest', sendRequest),
    vscode.commands.registerCommand('httpClient.runAll', runAll),
    vscode.commands.registerCommand('httpClient.resendLast', resendLast),
    vscode.commands.registerCommand('httpClient.pickRequest', pickRequest),
    vscode.commands.registerCommand('httpClient.selectEnvironment', selectEnvironment),
    vscode.commands.registerCommand('httpClient.copyAsCurl', copyAsCurl),
    vscode.commands.registerCommand('httpClient.createEnvFile', createEnvFile),
    vscode.commands.registerCommand('httpClient.showGlobals', () => {
      output.appendLine('Global variables (client.global):');
      output.appendLine(JSON.stringify(globals, null, 2));
      output.show(true);
    }),
    vscode.commands.registerCommand('httpClient.clearGlobals', () => {
      Object.keys(globals).forEach(k => delete globals[k]);
      persistState();
      vscode.window.setStatusBarMessage('$(check) Global variables cleared', 3000);
    }),
    vscode.commands.registerCommand('httpClient.clearCookies', () => {
      cookieJar.clear();
      persistState();
      vscode.window.setStatusBarMessage('$(check) Cookies cleared', 3000);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
