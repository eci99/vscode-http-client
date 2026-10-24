'use strict';

/**
 * Visual editor for .http files: a custom text editor (webview) on the same TextDocument as the
 * text editor, so saving, undo and the dirty state work as usual. The webview sends the changed
 * fields of a block; only that block is written back (see visual-model.js).
 */

const vscode = require('vscode');
const crypto = require('crypto');
const { parse } = require('./parser');
const { toModel, splitBlocks, serializeBlock, applyOperation } = require('./visual-model');
const intellisense = require('./intellisense');

const VIEW_TYPE = 'httpClient.visualEditor';

// Lines git writes into a file with merge conflicts
const CONFLICT_RE = /^(?:<{7}|>{7}|\|{7})(?:\s|$)|^={7}\s*$/m;

/**
 * Why the file is shown as text instead of the form: 'conflict' (merge conflict markers),
 * 'diff' (a comparison or a read-only version, e.g. from git), or null.
 */
function textOnlyReason(document, panel) {
  const scheme = document.uri.scheme;
  if (scheme !== 'untitled' && vscode.workspace.fs.isWritableFileSystem(scheme) === false) return 'diff';
  if (scheme === 'git') return 'diff';
  // In a diff, VS Code shows custom editors on both sides; extensions see the tab without an input.
  const group = vscode.window.tabGroups.all.find(g => g.viewColumn === panel.viewColumn);
  if (group && group.activeTab && panel.active && !group.activeTab.input) return 'diff';
  if (CONFLICT_RE.test(document.getText())) return 'conflict';
  return null;
}

/** Replaces only the lines that differ between the document and the new text. */
function minimalEdit(doc, newText) {
  const oldLines = doc.getText().split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  if (start === oldLines.length && start === newLines.length) return null;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) { endOld--; endNew--; }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  // Whole lines are replaced; the line break before or after them is part of the range.
  if (endOld < start) {
    // Lines are only inserted
    const inserted = newLines.slice(start, endNew + 1).join(eol);
    return start < oldLines.length
      ? { range: new vscode.Range(start, 0, start, 0), text: inserted + eol }
      : { range: new vscode.Range(start - 1, oldLines[start - 1].length, start - 1, oldLines[start - 1].length), text: eol + inserted };
  }
  const replacement = newLines.slice(start, endNew + 1);
  if (!replacement.length) {
    // Lines are only removed
    return endOld + 1 < oldLines.length
      ? { range: new vscode.Range(start, 0, endOld + 1, 0), text: '' }
      : { range: new vscode.Range(start - 1, oldLines[start - 1].length, endOld, oldLines[endOld].length), text: '' };
  }
  return { range: new vscode.Range(start, 0, endOld, oldLines[endOld].length), text: replacement.join(eol) };
}

class VisualEditorProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{ environments(doc): { names: string[], current: string|null },
   *           setEnvironment(name: string|null): Promise<void>,
   *           send(uri: vscode.Uri, line: number): Promise<void>,
   *           runAll(uri: vscode.Uri): Promise<void>,
   *           editEnvironments(uri: vscode.Uri): Promise<void> }} host
   */
  constructor(context, host) {
    this.context = context;
    this.host = host;
    this.panels = new Set();
    // The environment files are read once, not for every change of the document.
    this.environments = new Map();
  }

  /** Shows the current environment (and changed environment files) in all visual editors. */
  refreshAll() {
    this.environments.clear();
    this.panels.forEach(p => p.update());
  }

  resolveCustomTextEditor(document, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);

    const view = {
      update: () => {
        const textOnly = textOnlyReason(document, panel);
        panel.webview.postMessage({ type: 'model', ...this.model(document), textOnly });
        if (textOnly) this.switchToText(document, panel, textOnly);
      }
    };
    this.panels.add(view);

    // Messages are handled one after another, so a "send" sees the edits sent before it.
    let queue = Promise.resolve();
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) view.update();
      }),
      // A diff can only be switched to text while it is the active editor.
      panel.onDidChangeViewState(() => { if (panel.active) view.update(); }),
      panel.webview.onDidReceiveMessage(msg => {
        queue = queue.then(() => this.handle(document, panel, view, msg)).catch(err =>
          vscode.window.showErrorMessage(`HTTP-Client visual editor: ${err.message}`));
      })
    ];
    panel.onDidDispose(() => {
      this.panels.delete(view);
      this.environments.delete(document.uri.toString());
      subscriptions.forEach(s => s.dispose());
    });
  }

  /** Diffs and files with merge conflicts are shown in the text editor (the merge tools work there). */
  async switchToText(document, panel, reason) {
    if (reason === 'diff') {
      if (!panel.active || Date.now() - (this.lastDiffSwitch || 0) < 1000) return;
      this.lastDiffSwitch = Date.now();
      await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
      return;
    }
    if (panel.switchedToText) return;
    panel.switchedToText = true;
    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', panel.viewColumn);
    panel.dispose();
  }

  model(document) {
    const id = document.uri.toString();
    if (!this.environments.has(id)) this.environments.set(id, this.host.environments(document));
    const env = this.environments.get(id);
    return {
      version: document.version,
      fileName: document.uri.path.split('/').pop(),
      blocks: toModel(document.getText()),
      environments: env.names,
      environment: env.current
    };
  }

  async replace(document, newText) {
    const change = minimalEdit(document, newText);
    if (!change) return true;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, change.range, change.text);
    return vscode.workspace.applyEdit(edit);
  }

  async handle(document, panel, view, msg) {
    const post = m => panel.webview.postMessage(m);
    switch (msg.type) {
      case 'ready':
        post({ type: 'init', meta: this.meta() });
        view.update();
        return;
      case 'refresh':
        view.update();
        return;
      case 'edit': {
        // An edit made on an older version of the document is dropped; the webview gets the current one.
        if (msg.version !== document.version) {
          post({ type: 'ack', ok: false, version: document.version });
          view.update();
          return;
        }
        const text = document.getText();
        const lines = text.split(/\r?\n/);
        const blocks = splitBlocks(text);
        // From the last block to the first, so the line numbers of the others stay valid
        const changes = msg.changes.filter(c => blocks[c.index]).sort((a, b) => b.index - a.index);
        for (const c of changes) {
          const b = blocks[c.index];
          lines.splice(b.startLine, b.endLine - b.startLine + 1, ...serializeBlock(c.block));
        }
        const ok = await this.replace(document, lines.join('\n'));
        post({ type: 'ack', ok, version: document.version });
        return;
      }
      case 'op': {
        const r = applyOperation(document.getText(), msg.op, msg.index);
        await this.replace(document, r.text);
        post({ type: 'focus', index: r.index });
        view.update();
        return;
      }
      case 'send': {
        const block = splitBlocks(document.getText())[msg.index];
        const req = block && parse(document.getText()).requests.find(r => r.startLine === block.startLine);
        if (!req) { vscode.window.showWarningMessage('This block contains no request.'); return; }
        await this.host.send(document.uri, req.line);
        return;
      }
      case 'runAll':
        await this.host.runAll(document.uri);
        return;
      case 'environment':
        await this.host.setEnvironment(msg.name || null);
        return;
      case 'editEnvironments':
        await this.host.editEnvironments(document.uri);
        return;
      case 'openText':
        await openWith(document.uri, 'default');
        return;
      case 'textDiff':
        await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
        return;
      case 'docs':
        await vscode.env.openExternal(vscode.Uri.parse(intellisense.docsUrl(msg.anchor || '')));
        return;
    }
  }

  /** Lists for the form: methods, headers, header values, tags. */
  meta() {
    return {
      methods: intellisense.METHODS,
      httpVersions: intellisense.HTTP_VERSIONS,
      headers: intellisense.HEADERS.map(([name, doc]) => ({ name, doc })),
      headerValues: intellisense.HEADER_VALUES,
      tags: intellisense.TAGS.filter(([name]) => name !== 'name').map(([name, example, doc]) => ({ name, example, doc }))
    };
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
<title>HTTP-Client</title>
</head>
<body>
<div id="toolbar"></div>
<div id="blocks"></div>
<script nonce="${nonce}" src="${uri('visual-editor.js')}"></script>
</body>
</html>`;
  }
}

/** Opens the given (or the active) .http file in the visual or the text editor. */
async function openWith(uri, viewType) {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const activeUri = tab && tab.input && tab.input.uri instanceof vscode.Uri ? tab.input.uri : null;
  if (!(uri instanceof vscode.Uri)) uri = activeUri;
  if (!uri) { vscode.window.showWarningMessage('Open a .http file first.'); return; }
  // The active editor of the file is replaced (like "Reopen Editor With…"), so there is no second tab.
  if (activeUri && activeUri.toString() === uri.toString()) {
    try {
      await vscode.commands.executeCommand('reopenActiveEditorWith', viewType);
      return;
    } catch (e) { /* older VS Code: open beside it */ }
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
}

module.exports = { VisualEditorProvider, VIEW_TYPE, openWith, minimalEdit, CONFLICT_RE };
