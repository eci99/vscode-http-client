// @ts-check
'use strict';

/* Webview of the environment editor: a row per variable, a column per environment. A change is
 * sent when a field is left or Enter is pressed; while a field is being edited, models from the
 * extension wait, so nothing typed is lost. */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const ui = Object.assign({ hidePrivate: true }, vscode.getState() || {});
  const SHARED = '$shared';

  let model = null;
  let stashed = null;
  let editing = false;
  let refocus = null;
  // For a cell without a value: where its value is to be written (key "name:env" -> private)
  const privateChoice = {};

  window.addEventListener('message', e => {
    if (e.data.type !== 'model') return;
    if (editing) stashed = e.data;
    else { model = e.data; render(); }
  });

  function send(change) {
    editing = false;
    vscode.postMessage({ type: 'op', change });
  }

  /** Called when a field is left: a model that arrived meanwhile is shown now. */
  function done() {
    editing = false;
    if (stashed) { model = stashed; stashed = null; render(); }
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') /** @type {any} */ (el).value = v;
      else if (k === 'checked') /** @type {any} */ (el).checked = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function button(text, title, onclick, cls = '') {
    return h('button', { class: `btn ${cls}`, title, type: 'button', onclick: e => { e.stopPropagation(); onclick(e); } }, text);
  }

  /**
   * Text field that reports its value when it is left or Enter is pressed (Escape restores it).
   * @param {string} value
   * @param {(v: string) => void} commit
   */
  function field(value, commit, attrs = {}) {
    const multiline = attrs.multiline === true;
    const fieldAttrs = { ...attrs };
    delete fieldAttrs.multiline;
    const resize = el => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    return h(multiline ? 'textarea' : 'input', {
      ...(multiline ? { rows: 1, wrap: 'soft' } : { type: 'text' }),
      spellcheck: 'false', value, ...fieldAttrs,
      onfocus: e => { if (multiline) resize(e.target); },
      onmouseenter: e => { if (multiline) resize(e.target); },
      onmouseleave: e => {
        if (multiline && document.activeElement !== e.target) e.target.style.height = '';
      },
      oninput: e => { editing = true; if (multiline) resize(e.target); },
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
        if (e.key === 'Escape') { e.target.value = value; editing = false; e.target.blur(); }
      },
      onchange: e => { if (e.target.value !== value) commit(e.target.value); else done(); },
      onblur: e => {
        if (multiline) e.target.style.height = '';
        if (editing === false) done();
      }
    });
  }

  function render() {
    const active = document.activeElement;
    if (!refocus && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.dataset.focus) {
      refocus = { id: active.dataset.focus };
    }
    const scroll = { x: window.scrollX, y: window.scrollY };
    renderToolbar();
    const content = document.getElementById('content');
    content.replaceChildren(model.error ? renderError() : renderTable(), renderHints());
    window.scrollTo(scroll.x, scroll.y);
    if (refocus) {
      const el = document.querySelector(`[data-focus="${CSS.escape(refocus.id)}"]`);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
      refocus = null;
    }
  }

  function renderToolbar() {
    document.getElementById('toolbar').replaceChildren(
      h('input', {
        type: 'search', class: 'filter', placeholder: 'Filter variables',
        'aria-label': 'Filter environment variables', value: ui.filter || '',
        oninput: e => {
          ui.filter = e.target.value;
          vscode.setState(ui);
          refreshTable();
        }
      }),
      h('span', { class: 'spacer' }),
      h('label', { class: 'check', title: 'Show the values of the private file as dots' },
        h('input', { type: 'checkbox', checked: ui.hidePrivate, onchange: e => { ui.hidePrivate = e.target.checked; vscode.setState(ui); render(); } }),
        ' Hide private values'),
      button('{ } http-client.env.json', 'Open the public file', () => vscode.postMessage({ type: 'openFile', private: false }), 'secondary'),
      button('{ } private', 'Open http-client.private.env.json', () => vscode.postMessage({ type: 'openFile', private: true }), 'secondary')
    );
  }

  function refreshTable() {
    const current = document.querySelector('.table-wrap');
    if (!current) return;
    const next = renderTable();
    next.scrollTop = current.scrollTop;
    next.scrollLeft = current.scrollLeft;
    current.replaceWith(next);
  }

  function renderError() {
    return h('div', { class: 'empty error' },
      h('p', {}, `The file cannot be read: ${model.error}`),
      h('p', {}, 'Fix it in the text editor; the table is shown again afterwards.'));
  }

  function renderTable() {
    const envs = model.environments;
    const others = envs.filter(e => e !== SHARED);
    const filter = (ui.filter || '').trim().toLocaleLowerCase();
    const variables = model.variables.filter(name => {
      if (!filter || name.toLocaleLowerCase().includes(filter)) return true;
      const cells = model.cells[name] || {};
      return Object.values(cells).some(cell =>
        (!ui.hidePrivate || !cell.private) && String(cell.value).toLocaleLowerCase().includes(filter));
    });
    if (ui.variableSort) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const direction = ui.variableSort === 'asc' ? 1 : -1;
      variables.sort((a, b) => direction * collator.compare(a, b));
    }
    const table = h('table', { class: 'env-table' });

    // Header: a column per environment
    table.append(h('thead', {}, h('tr', {},
      h('th', { class: 'var-col' }, button(
        `Variable ${ui.variableSort === 'asc' ? '↑' : ui.variableSort === 'desc' ? '↓' : '↕'}`,
        'Sort variables A to Z / Z to A', () => {
          ui.variableSort = ui.variableSort === 'asc' ? 'desc' : 'asc';
          vscode.setState(ui);
          refreshTable();
        }, 'sort')),
      envs.map(env => h('th', { class: env === model.active ? 'active' : '' },
        h('div', { class: 'env-head' },
          env === SHARED
            ? h('span', { class: 'env-name', title: 'Values for all environments; an environment overrides them' }, '$shared')
            : field(env, to => { refocus = { id: `env:${to}` }; send({ op: 'renameEnvironment', from: env, to }); },
              { class: 'env-name', 'data-focus': `env:${env}`, title: 'Rename' }),
          env === SHARED ? null : env === model.active
            ? button('● active', 'Requests use this environment (click: no environment)', () => vscode.postMessage({ type: 'use', env: null }), 'link active-env')
            : button('use', 'Send requests with this environment', () => vscode.postMessage({ type: 'use', env }), 'link'),
          button('🗑', `Delete the environment ${env}`, () => send({ op: 'deleteEnvironment', env }), 'icon danger')))),
      h('th', { class: 'add-col' },
        field('', env => { if (env.trim()) send({ op: 'addEnvironment', env: env.trim() }); else done(); },
          { placeholder: '+ Environment', class: 'new-env', 'data-focus': 'new-env' }),
        envs.includes(SHARED) ? null
          : button('+ $shared', 'Values for all environments', () => send({ op: 'addEnvironment', env: SHARED }), 'link')))));

    const body = h('tbody');
    if (filter && !variables.length) {
      body.append(h('tr', { class: 'filter-empty' },
        h('td', { colspan: envs.length + 2, class: 'hint' }, 'No matching variables.')));
    }
    for (const name of variables) {
      const cells = model.cells[name] || {};
      const privateElsewhere = Object.values(cells).some(c => c.private);
      const isPrivate = envs.some(env => {
        const key = `${name}:${env}`;
        const cell = cells[env];
        return cell ? cell.private : key in privateChoice ? privateChoice[key] : privateElsewhere && env !== SHARED;
      });
      body.append(h('tr', {},
        h('td', { class: 'var-col' },
          h('div', { class: 'var-head' },
            field(name, to => { refocus = { id: `var:${to.trim()}` }; send({ op: 'renameVariable', from: name, to: to.trim() }); },
              { class: 'var-name', 'data-focus': `var:${name}`, title: `{{${name}}} – rename` }),
            button(isPrivate ? '🔒' : '🔓',
              isPrivate ? 'Move all values to the public file' : 'Move all values to the private file',
              () => {
                const targetPrivate = !isPrivate;
                let pendingMoves = 0;
                for (const env of envs) {
                  const key = `${name}:${env}`;
                  const cell = cells[env];
                  if (cell && cell.private !== targetPrivate) {
                    pendingMoves++;
                    vscode.postMessage({ type: 'op', change: { op: 'move', env, name, private: targetPrivate } });
                  } else if (!cell) privateChoice[key] = targetPrivate;
                }
                if (!pendingMoves) render();
              }, `icon lock${isPrivate ? ' on' : ''}`),
            button('✕', `Delete ${name} in all environments`, () => send({ op: 'deleteVariable', name }), 'icon danger'))),
        envs.map(env => renderCell(name, env, cells[env], cells[SHARED], privateElsewhere)),
        h('td')));
    }
    body.append(h('tr', { class: 'new-row' },
      h('td', { class: 'var-col' },
        field('', n => { if (n.trim()) { refocus = { id: `cell:${n.trim()}:${others[0] || SHARED}` }; send({ op: 'addVariable', name: n.trim() }); } else done(); },
          { placeholder: '+ Variable', class: 'var-name', 'data-focus': 'new-var' })),
      h('td', { colspan: envs.length + 1, class: 'hint' }, envs.length ? '' : 'Add an environment (e.g. dev) to start.')));
    table.append(body);
    return h('div', { class: 'table-wrap' }, table);
  }

  function renderCell(name, env, cell, shared, privateElsewhere) {
    const key = `${name}:${env}`;
    const isPrivate = cell ? cell.private : key in privateChoice ? privateChoice[key] : privateElsewhere && env !== SHARED;
    const inherited = !cell && env !== SHARED && shared ? `$shared: ${shared.private && ui.hidePrivate ? '••••' : shared.value}` : '';
    const input = field(cell ? cell.value : '', value => send({ op: 'set', env, name, value, private: isPrivate }), {
      class: `cell${cell ? '' : ' missing'}`,
      type: isPrivate && ui.hidePrivate ? 'password' : undefined,
      multiline: !(isPrivate && ui.hidePrivate),
      placeholder: inherited || 'not set',
      'data-focus': `cell:${name}:${env}`,
      disabled: cell && cell.kind === 'json',
      title: cell && cell.kind === 'json' ? 'An object – edit it in the JSON file'
        : cell && cell.shadowsPublic ? 'Also in the public file; this private value is used'
          : cell && cell.kind !== 'string' ? `A ${cell.kind}; stays a ${cell.kind} if the new value is one` : undefined
    });
    return h('td', { class: `${isPrivate ? 'private' : ''}${env === model.active ? ' active' : ''}` },
      h('div', { class: 'cell-wrap' },
        input,
        cell ? button('✕', 'Remove the value from this environment', () => send({ op: 'delete', env, name }), 'icon danger') : h('span', { class: 'icon-space' })));
  }

  function renderHints() {
    return h('div', { class: 'hints hint' },
      h('p', {}, '🔒 Private values are stored in http-client.private.env.json – keep that file out of version control. ',
        'A value in an environment overrides $shared; a private value overrides a public one.'),
      model.files.pub || model.files.priv ? null : h('p', {}, 'The files are created with the first change.'));
  }

  vscode.postMessage({ type: 'ready' });
})();
