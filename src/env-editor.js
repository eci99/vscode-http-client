'use strict';

/**
 * Environment editor: http-client.env.json and http-client.private.env.json of one directory as a
 * table (see env-model.js). Every change is written to the files and saved right away.
 */

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { envModel, applyEnvOperation, formatJson, SHARED } = require('./env-model');

const ENV_FILE = 'http-client.env.json';
const PRIVATE_ENV_FILE = 'http-client.private.env.json';

class EnvironmentEditor {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{ current(): string|null, setEnvironment(name: string|null): Promise<void> }} host
   */
  constructor(context, host) {
    this.context = context;
    this.host = host;
    this.panels = new Map(); // directory -> { panel, update }
  }

  /** Opens the editor for the environment files in dir (they do not have to exist yet). */
  open(dir) {
    const existing = this.panels.get(dir);
    if (existing) { existing.panel.reveal(); return; }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('httpClient.environments', 'HTTP-Client Environments',
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon.png');
    panel.webview.html = this.html(panel.webview, media);
    const files = { pub: vscode.Uri.file(path.join(dir, ENV_FILE)), priv: vscode.Uri.file(path.join(dir, PRIVATE_ENV_FILE)) };
    const entry = {
      panel,
      update: async () => panel.webview.postMessage({ type: 'model', ...(await this.model(dir, files)) })
    };
    this.panels.set(dir, entry);

    let queue = Promise.resolve();
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, 'http-client*.env.json'));
    const isOurs = uri => uri.toString() === files.pub.toString() || uri.toString() === files.priv.toString();
    const subscriptions = [
      watcher, watcher.onDidChange(entry.update), watcher.onDidCreate(entry.update), watcher.onDidDelete(entry.update),
      vscode.workspace.onDidChangeTextDocument(e => { if (isOurs(e.document.uri) && e.contentChanges.length) entry.update(); }),
      panel.webview.onDidReceiveMessage(msg => {
        queue = queue.then(() => this.handle(dir, files, entry, msg)).catch(err => {
          vscode.window.showErrorMessage(`HTTP-Client environments: ${err.message}`);
          return entry.update();
        });
      })
    ];
    panel.onDidDispose(() => {
      this.panels.delete(dir);
      subscriptions.forEach(s => s.dispose());
    });
  }

  /** Shows the selected environment in all open editors. */
  refreshAll() {
    this.panels.forEach(p => p.update());
  }

  /** Text and parsed content of a file; the open (possibly unsaved) document counts. */
  async read(uri) {
    let text = null;
    try {
      text = (await vscode.workspace.openTextDocument(uri)).getText();
    } catch (e) {
      return { exists: false, text: null, json: null };
    }
    if (text.trim() === '') return { exists: true, text, json: {} };
    try {
      return { exists: true, text, json: JSON.parse(text) };
    } catch (e) {
      return { exists: true, text, json: null, error: `${path.basename(uri.fsPath)}: ${e.message}` };
    }
  }

  async model(dir, files) {
    const [pub, priv] = await Promise.all([this.read(files.pub), this.read(files.priv)]);
    const root = vscode.workspace.getWorkspaceFolder(files.pub);
    return {
      dir: root ? path.relative(root.uri.fsPath, dir) || '.' : dir,
      files: { pub: pub.exists, priv: priv.exists },
      error: pub.error || priv.error || null,
      active: this.host.current(),
      ...envModel(pub.json, priv.json)
    };
  }

  async write(uri, file, json) {
    if (json === null) return;
    const text = formatJson(json, file.text);
    if (text === file.text) return;
    if (!file.exists) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  async handle(dir, files, entry, msg) {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        await entry.update();
        return;
      case 'op': {
        const [pub, priv] = await Promise.all([this.read(files.pub), this.read(files.priv)]);
        if (pub.error || priv.error) throw new Error(pub.error || priv.error);
        const problem = check(envModel(pub.json, priv.json), msg.change);
        if (problem) {
          vscode.window.showWarningMessage(problem);
          await entry.update();
          return;
        }
        const result = applyEnvOperation(pub.json, priv.json, msg.change);
        await this.write(files.pub, pub, result.pub);
        await this.write(files.priv, priv, result.priv);
        const c = msg.change;
        if (c.op === 'renameEnvironment' && this.host.current() === c.from) await this.host.setEnvironment(c.to);
        if (c.op === 'deleteEnvironment' && this.host.current() === c.env) await this.host.setEnvironment(null);
        await entry.update();
        return;
      }
      case 'use':
        await this.host.setEnvironment(msg.env || null);
        return;
      case 'openFile': {
        const uri = msg.private ? files.priv : files.pub;
        try {
          await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
        } catch (e) {
          vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} does not exist yet.`);
        }
      }
    }
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('visual-editor.css')}" rel="stylesheet">
<link href="${uri('env-editor.css')}" rel="stylesheet">
<title>HTTP-Client Environments</title>
</head>
<body>
<div id="toolbar"></div>
<div id="content"></div>
<script nonce="${nonce}" src="${uri('env-editor.js')}"></script>
</body>
</html>`;
  }
}

const NAME_RE = /^[\w.-]+$/;

/** Why a change cannot be made, or null. */
function check(model, c) {
  if (c.op === 'addVariable' || c.op === 'renameVariable') {
    const name = c.op === 'addVariable' ? c.name : c.to;
    if (!NAME_RE.test(name)) return `"${name}" is not a valid variable name (letters, digits, _ . -).`;
    if (model.variables.includes(name)) return `The variable "${name}" already exists.`;
  }
  if (c.op === 'addEnvironment' || c.op === 'renameEnvironment') {
    const name = c.op === 'addEnvironment' ? c.env : c.to;
    if (!name || !name.trim()) return 'The environment needs a name.';
    if (name.startsWith('$') && name !== SHARED) return `"${name}": names starting with $ are reserved.`;
    if (model.environments.includes(name)) return `The environment "${name}" already exists.`;
  }
  return null;
}

module.exports = { EnvironmentEditor, check };
