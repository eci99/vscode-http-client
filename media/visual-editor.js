// @ts-check
'use strict';

/* Webview of the visual editor. The extension sends the blocks of the file ("model"); a change
 * in the form updates the block here and, after a short pause, is sent back as "edit". While an
 * edit is on its way, models from the extension wait, so nothing typed in the meantime is lost. */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  /** UI state that survives reloads: open cards and the tab of each card (by block index), filter. */
  const ui = { open: saved.open || {}, tabs: saved.tabs || {}, filter: saved.filter || '' };

  let meta = { methods: [], httpVersions: [], headers: [], headerValues: {}, tags: [] };
  let model = null;        // last model from the extension
  let blocks = [];         // blocks as edited here
  let version = -1;
  let pending = 0;         // edits sent but not yet acknowledged
  let timer = null;        // edits waiting to be sent
  let dirty = new Set();   // indexes of changed blocks
  let stashed = null;      // model that arrived while editing
  let focusIndex = null;   // block to open and focus after the next render

  const KNOWN_FLAGS = ['no-redirect', 'no-log', 'no-cookie-jar', 'no-auto-encoding'];
  const KNOWN_VALUES = ['timeout', 'connection-timeout'];
  const BODY_TYPES = [
    ['JSON', 'application/json', '{\n  \n}'],
    ['Form', 'application/x-www-form-urlencoded', 'key=value&other=value'],
    ['XML', 'application/xml', '<?xml version="1.0" encoding="UTF-8"?>\n<root></root>'],
    ['Text', 'text/plain', ''],
    ['Multipart', 'multipart/form-data; boundary=WebAppBoundary',
      '--WebAppBoundary\nContent-Disposition: form-data; name="field"\n\nvalue\n--WebAppBoundary\nContent-Disposition: form-data; name="file"; filename="data.json"\nContent-Type: application/json\n\n< ./data.json\n--WebAppBoundary--']
  ];
  const PRE_TEMPLATE = '< {%\n  request.variables.set("requestId", $uuid);\n%}';
  const TEST_TEMPLATE = '> {%\n  client.test("Status 200", () => {\n    client.assert(response.status === 200, "status " + response.status);\n  });\n%}';

  const persist = () => vscode.setState({ open: ui.open, tabs: ui.tabs, filter: ui.filter });

  // ---------------------------------------------------------------- messages

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'init') meta = msg.meta;
    else if (msg.type === 'model') {
      if (pending || timer) stashed = msg;
      else applyModel(msg);
    } else if (msg.type === 'ack') {
      pending = Math.max(0, pending - 1);
      version = msg.version;
      if (!pending && !timer) {
        if (stashed && stashed.version >= version) applyModel(stashed);
        else vscode.postMessage({ type: 'refresh' });
        stashed = null;
      }
    } else if (msg.type === 'focus') {
      focusIndex = msg.index;
    }
  });

  function applyModel(msg) {
    stashed = null;
    model = msg;
    version = msg.version;
    keepEmptyRows(msg.blocks);
    blocks = msg.blocks;
    if (focusIndex !== null && blocks[focusIndex]) ui.open[key(focusIndex)] = true;
    render();
    if (focusIndex !== null) {
      const card = document.querySelector(`[data-block="${focusIndex}"]`);
      if (card) {
        card.scrollIntoView({ block: 'nearest' });
        const url = card.querySelector('input.url');
        if (url instanceof HTMLInputElement) url.focus();
      }
      focusIndex = null;
    }
  }

  /**
   * Rows without name and value (just added with "+ Parameter", "+ Header", …) are not written to
   * the file, so the model from the extension does not have them. They are kept at their place
   * until something is typed into them.
   */
  function keepEmptyRows(next) {
    if (next.length !== blocks.length) return;
    const keep = (from, to, prop) => {
      if (!from || !to) return;
      from[prop].forEach((row, k) => {
        if (!row.name && !row.value) to[prop].splice(Math.min(k, to[prop].length), 0, row);
      });
    };
    next.forEach((b, i) => {
      const old = blocks[i];
      keep(old, b, 'variables');
      keep(old, b, 'tags');
      keep(old.request, b.request, 'query');
      keep(old.request, b.request, 'headers');
    });
  }

  /** The block at index has changed: send it after a short pause. */
  function changed(index, rerender) {
    dirty.add(index);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 350);
    if (rerender) render();
    else updateHeader(index);
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty.size) return;
    const changes = [...dirty].map(index => ({ index, block: blocks[index] }));
    dirty = new Set();
    pending++;
    vscode.postMessage({ type: 'edit', version, changes });
  }

  /** Sends pending edits first, so the extension acts on the current text. */
  function command(msg) {
    flush();
    if (msg.type === 'op') moveUiState(msg.op, msg.index);
    vscode.postMessage(msg);
  }

  /** Open cards and tabs follow their blocks when blocks are deleted, copied or moved. */
  function moveUiState(op, index) {
    const target = i => {
      if (op === 'delete') return i === index ? null : i > index ? i - 1 : i;
      if (op === 'duplicate') return i > index ? i + 1 : i;
      if (op === 'up') return i === index ? i - 1 : i === index - 1 ? index : i;
      if (op === 'down') return i === index ? i + 1 : i === index + 1 ? index : i;
      return i;
    };
    for (const name of ['open', 'tabs']) {
      const moved = {};
      for (const [k, v] of Object.entries(ui[name])) {
        const t = target(Number(k));
        if (t !== null) moved[t] = v;
      }
      if (op === 'duplicate' && ui[name][index] !== undefined) moved[index + 1] = ui[name][index];
      ui[name] = moved;
    }
    persist();
  }

  // ---------------------------------------------------------------- helpers

  const key = index => String(index);

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {...any} children
   */
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

  const isHeaderBlock = b => !b.request;
  const isEmpty = b => !b.request && !b.separator && !b.comments.trim() && !b.variables.length && !b.preScript.trim() && !b.tags.length && !b.name;

  function label(b) {
    if (!b.request) return b.title || (b.separator ? '(no request)' : 'File');
    return b.name || b.title || fullUrl(b.request) || '(no URL)';
  }

  function fullUrl(req) {
    const params = req.query.filter(p => p.name || p.value).map(p => (p.eq || p.value ? `${p.name}=${p.value}` : p.name));
    return req.url + (params.length ? `?${params.join('&')}` : '');
  }

  function headerValue(req, name) {
    const hd = req.headers.find(x => x.name.toLowerCase() === name.toLowerCase());
    return hd ? hd.value : null;
  }

  function setHeader(req, name, value) {
    const hd = req.headers.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (value === null) req.headers = req.headers.filter(x => x !== hd);
    else if (hd) hd.value = value;
    else req.headers.push({ name, value });
  }

  /** Text field bound to obj[prop]. */
  function input(index, obj, prop, attrs = {}, after) {
    return h('input', {
      type: 'text', spellcheck: 'false', value: obj[prop] == null ? '' : obj[prop], ...attrs,
      oninput: e => { obj[prop] = e.target.value; if (after) after(e); changed(index, false); }
    });
  }

  function textarea(index, obj, prop, attrs = {}) {
    return h('textarea', {
      spellcheck: 'false', value: obj[prop] || '', rows: Math.min(25, Math.max(attrs.minRows || 4, (obj[prop] || '').split('\n').length + 1)),
      ...attrs, minRows: undefined,
      oninput: e => { obj[prop] = e.target.value; changed(index, false); },
      onkeydown: e => {
        // Tab indents instead of leaving the field
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          document.execCommand('insertText', false, '  ');
        }
      }
    });
  }

  function button(text, title, onclick, cls = '') {
    return h('button', { class: `btn ${cls}`, title, type: 'button', onclick: e => { e.stopPropagation(); onclick(e); } }, text);
  }

  /** Table of name/value rows (query parameters, headers, variables, other tags). */
  function pairTable(index, rows, opts) {
    const table = h('div', { class: 'pairs' });
    rows.forEach((row, k) => {
      table.append(h('div', { class: 'pair' },
        input(index, row, 'name', { placeholder: opts.namePlaceholder, list: opts.nameList, class: 'name', 'data-focus': `${opts.id}.${k}.name` }),
        opts.separator ? h('span', { class: 'sep' }, opts.separator) : null,
        input(index, row, 'value', {
          placeholder: opts.valuePlaceholder, class: 'value', 'data-focus': `${opts.id}.${k}.value`,
          list: opts.valueList ? opts.valueList(row) : undefined
        }, () => { if (opts.onValue) opts.onValue(row); }),
        button('✕', 'Remove', () => { if (opts.remove) opts.remove(row); else rows.splice(k, 1); changed(index, true); }, 'icon')
      ));
    });
    table.append(h('div', { class: 'pair-actions' },
      button(`+ ${opts.addLabel}`, '', () => {
        const row = opts.create();
        const k = rows.length;
        if (opts.add) opts.add(row); else rows.push(row);
        focusAfterRender(`${opts.id}.${k}.name`);
        changed(index, true);
      }, 'link')));
    return table;
  }

  let refocus = null;
  function focusAfterRender(id) { refocus = { id, start: 0, end: 0 }; }

  // ---------------------------------------------------------------- rendering

  function render() {
    const active = document.activeElement;
    if (!refocus && active && active instanceof HTMLElement && active.dataset.focus) {
      const field = /** @type {HTMLInputElement} */ (active);
      refocus = { id: active.dataset.focus, start: field.selectionStart, end: field.selectionEnd };
    }
    if (model && model.textOnly) { renderTextOnly(model.textOnly); return; }
    const scroll = window.scrollY;
    renderToolbar();
    const list = document.getElementById('blocks');
    list.replaceChildren();
    const filter = ui.filter.trim().toLowerCase();
    let shown = 0;
    blocks.forEach((b, index) => {
      if (isEmpty(b)) return;
      if (filter && !(label(b) + ' ' + (b.request ? `${b.request.method} ${fullUrl(b.request)}` : '') + ' ' + b.title)
        .toLowerCase().includes(filter)) return;
      list.append(renderBlock(b, index));
      shown++;
    });
    if (!shown) {
      list.append(h('div', { class: 'empty' },
        filter ? 'No request matches the filter.' : 'This file contains no requests yet.',
        ' ', button('+ Add request', '', () => command({ type: 'op', op: 'add', index: 0 }), 'link')));
    }
    window.scrollTo(0, scroll);
    if (refocus) {
      const el = document.querySelector(`[data-focus="${CSS.escape(refocus.id)}"]`);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        try { el.setSelectionRange(refocus.start, refocus.end); } catch (e) { /* not a text field */ }
      }
      refocus = null;
    }
  }

  /** Merge conflicts and diffs are not shown as a form; the extension opens the text editor. */
  function renderTextOnly(reason) {
    document.getElementById('toolbar').replaceChildren();
    document.getElementById('blocks').replaceChildren(h('div', { class: 'empty' },
      h('p', {}, reason === 'conflict'
        ? 'This file contains merge conflicts. Resolve them in the text editor; the visual editor works again afterwards.'
        : 'Changes are compared in the text editor.'),
      reason === 'conflict'
        ? button('Open in Text Editor', '', () => vscode.postMessage({ type: 'openText' }))
        : button('Show as Text', '', () => vscode.postMessage({ type: 'textDiff' }))));
  }

  function renderToolbar() {
    const bar = document.getElementById('toolbar');
    const envs = model ? model.environments : [];
    const current = model ? model.environment : null;
    const filter = h('input', {
      type: 'search', class: 'filter', placeholder: 'Filter requests', value: ui.filter, 'data-focus': 'filter',
      oninput: e => { ui.filter = e.target.value; persist(); render(); }
    });
    bar.replaceChildren(
      h('span', { class: 'file' }, model ? model.fileName : ''),
      filter,
      h('label', { class: 'env', title: 'Environment (http-client.env.json)' }, 'Environment ',
        h('select', { onchange: e => command({ type: 'environment', name: e.target.value }) },
          h('option', { value: '', selected: !current }, '<none>'),
          envs.map(n => h('option', { value: n, selected: n === current }, n)),
          current && !envs.includes(current) ? h('option', { value: current, selected: true }, `${current} (not found)`) : null)),
      button('✎', 'Edit the environments (http-client.env.json, http-client.private.env.json)', () => command({ type: 'editEnvironments' }), 'icon'),
      h('span', { class: 'spacer' }),
      button('+ Request', 'Add a request at the end of the file', () => command({ type: 'op', op: 'add', index: 0 })),
      button('▶▶ Run all', 'Run all requests in the file', () => command({ type: 'runAll' })),
      button('Expand all', '', () => { blocks.forEach((b, i) => { ui.open[key(i)] = true; }); persist(); render(); }, 'secondary'),
      button('Collapse all', '', () => { ui.open = {}; persist(); render(); }, 'secondary'),
      button('{ } Text', 'Open in the text editor', () => command({ type: 'openText' }), 'secondary')
    );
  }

  function methodClass(m) {
    return `method m-${(m || 'GET').toLowerCase()}`;
  }

  function renderBlock(b, index) {
    const open = !!ui.open[key(index)];
    const req = b.request;
    const prev = blocks.slice(0, index).reverse().find(x => !isEmpty(x));
    const canUp = prev && !(isHeaderBlock(prev) && !prev.separator);
    const canDown = blocks.slice(index + 1).some(x => !isEmpty(x));
    const toggle = () => { ui.open[key(index)] = !open; persist(); render(); };

    const head = h('div', { class: 'card-head', onclick: toggle },
      h('span', { class: 'chevron' }, open ? '▾' : '▸'),
      req ? h('span', { class: methodClass(req.method) }, req.method) : h('span', { class: 'method m-file' }, b.separator ? '###' : 'FILE'),
      h('span', { class: 'label' }, label(b)),
      req && (b.name || b.title) ? h('span', { class: 'url' }, fullUrl(req)) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'actions' },
        req ? button('▶ Send', 'Send this request (Ctrl+Enter)', () => command({ type: 'send', index }), 'send') : null,
        req ? button('⧉', 'Duplicate', () => command({ type: 'op', op: 'duplicate', index }), 'icon') : null,
        b.separator || req ? button('↑', 'Move up', () => command({ type: 'op', op: 'up', index }), `icon${canUp ? '' : ' hidden'}`) : null,
        b.separator || req ? button('↓', 'Move down', () => command({ type: 'op', op: 'down', index }), `icon${canDown ? '' : ' hidden'}`) : null,
        button('🗑', 'Delete (undo with Ctrl+Z)', () => command({ type: 'op', op: 'delete', index }), 'icon danger')
      ));

    const card = h('section', { class: `card${open ? ' open' : ''}`, 'data-block': index }, head);
    if (open) card.append(req ? renderRequest(b, index) : renderHeaderBlock(b, index));
    return card;
  }

  /** Header line of a card, updated while typing without rebuilding the form. */
  function updateHeader(index) {
    const card = document.querySelector(`[data-block="${index}"]`);
    const b = blocks[index];
    if (!card || !b) return;
    const req = b.request;
    const m = card.querySelector('.card-head .method');
    if (m && req) { m.textContent = req.method; m.className = methodClass(req.method); }
    const l = card.querySelector('.card-head .label');
    if (l) l.textContent = label(b);
    const u = card.querySelector('.card-head .url');
    if (u && req) u.textContent = fullUrl(req);
    card.querySelectorAll('[data-count]').forEach(el => {
      const n = count(b, /** @type {HTMLElement} */ (el).dataset.count);
      el.textContent = n ? String(n) : '';
    });
  }

  function count(b, tab) {
    const req = b.request;
    switch (tab) {
      case 'params': return req.query.filter(p => p.name).length;
      case 'headers': return req.headers.filter(x => x.name).length;
      case 'variables': return b.variables.length;
      case 'options': return b.tags.length;
      default: return 0;
    }
  }

  function renderHeaderBlock(b, index) {
    return h('div', { class: 'card-body' },
      b.separator ? field('Title', input(index, b, 'title', { 'data-focus': `${index}.title`, placeholder: 'Title after ###' })) : null,
      h('h4', {}, 'In-place variables ', h('span', { class: 'hint' }, '@name = value – apply to the whole file')),
      pairTable(index, b.variables, variableOpts(index)),
      h('h4', {}, 'Comments'),
      textarea(index, b, 'comments', { 'data-focus': `${index}.comments`, placeholder: '# A comment', minRows: 2 }),
      b.preScript.trim() ? [h('h4', {}, 'Script ', h('span', { class: 'hint' }, 'without a request, it does not run')),
        textarea(index, b, 'preScript', { 'data-focus': `${index}.pre`, class: 'code' })] : null
    );
  }

  function variableOpts(index) {
    return {
      id: `${index}.v`, namePlaceholder: 'name', valuePlaceholder: 'value', separator: '=', addLabel: 'Variable',
      create: () => ({ name: '', value: '' })
    };
  }

  function field(labelText, control, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), control, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function renderRequest(b, index) {
    const req = b.request;
    const tab = ui.tabs[key(index)] || (req.body ? 'body' : 'params');

    const method = h('select', {
      class: methodClass(req.method) + ' method-select', 'data-focus': `${index}.method`,
      onchange: e => { req.method = e.target.value; changed(index, true); }
    }, meta.methods.map(m => h('option', { value: m, selected: m === req.method }, m)));

    const url = input(index, req, 'url', {
      class: 'url', placeholder: 'https://{{host}}/path', 'data-focus': `${index}.url`,
      onpaste: e => {
        // A pasted URL with a query is split into the parameter table.
        const text = e.clipboardData.getData('text');
        const el = e.target;
        const replacesAll = !el.value || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
        if (!replacesAll || !text.includes('?') || /\s/.test(text.trim())) return;
        e.preventDefault();
        const q = text.trim().indexOf('?');
        req.url = text.trim().slice(0, q);
        req.query = text.trim().slice(q + 1).split('&').filter(Boolean).map(p => {
          const eq = p.indexOf('=');
          return eq < 0 ? { name: p, value: '', eq: false } : { name: p.slice(0, eq), value: p.slice(eq + 1), eq: true };
        });
        changed(index, true);
      },
      onkeydown: e => { if (e.key === 'Enter') command({ type: 'send', index }); }
    }, () => {
      // A "?" typed into the URL field moves the query into the table.
      const q = req.url.indexOf('?');
      if (q >= 0) {
        const rest = req.url.slice(q + 1);
        req.url = req.url.slice(0, q);
        req.query.push(...rest.split('&').map(p => {
          const eq = p.indexOf('=');
          return eq < 0 ? { name: p, value: '', eq: false } : { name: p.slice(0, eq), value: p.slice(eq + 1), eq: true };
        }));
        focusAfterRender(`${index}.q.${req.query.length - 1}.name`);
        changed(index, true);
      }
    });

    const httpVersion = h('select', {
      class: 'version', title: 'HTTP version (optional)', 'data-focus': `${index}.version`,
      onchange: e => { req.httpVersion = e.target.value; changed(index, false); }
    }, h('option', { value: '', selected: !req.httpVersion }, '—'),
    meta.httpVersions.map(v => h('option', { value: v, selected: v === req.httpVersion }, v)),
    req.httpVersion && !meta.httpVersions.includes(req.httpVersion) ? h('option', { value: req.httpVersion, selected: true }, req.httpVersion) : null);

    const tabs = [
      ['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['scripts', 'Scripts'],
      ['options', 'Options'], ['variables', 'Variables'], ['comments', 'Comments']
    ];
    const indicator = id => {
      if (id === 'body') return req.body.trim() ? '●' : '';
      if (id === 'scripts') return b.preScript.trim() || req.handlers.trim() || (req.responseFile && req.responseFile.path) ? '●' : '';
      if (id === 'comments') return b.comments.trim() ? '●' : '';
      return '';
    };
    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, text]) =>
      h('button', {
        type: 'button', role: 'tab', class: `tab${id === tab ? ' active' : ''}`,
        onclick: () => { ui.tabs[key(index)] = id; persist(); render(); }
      }, text, ' ', h('span', { class: 'count', 'data-count': id }, count(b, id) || indicator(id)))));

    return h('div', {
      class: 'card-body',
      onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); command({ type: 'send', index }); } }
    },
      h('div', { class: 'request-line' }, method, url, httpVersion,
        button('▶ Send', 'Send (Ctrl+Enter)', () => command({ type: 'send', index }), 'send primary')),
      h('div', { class: 'row' },
        field('Title', input(index, b, 'title', { placeholder: 'Shown after ###', 'data-focus': `${index}.title` }, () => { b.separator = true; })),
        field('Name', input(index, b, 'name', { placeholder: 'e.g. login', 'data-focus': `${index}.name` }), '# @name – {{name.response.body…}}')),
      tabBar,
      h('div', { class: 'tab-panel' }, renderTab(tab, b, index))
    );
  }

  function renderTab(tab, b, index) {
    const req = b.request;
    switch (tab) {
      case 'params':
        return [
          pairTable(index, req.query, {
            id: `${index}.q`, namePlaceholder: 'parameter', valuePlaceholder: 'value', separator: '=', addLabel: 'Parameter',
            create: () => ({ name: '', value: '', eq: true }), onValue: row => { row.eq = true; }
          }),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: req.multilineQuery, onchange: e => { req.multilineQuery = e.target.checked; changed(index, false); } }),
            ' One parameter per line in the file')
        ];
      case 'headers':
        return [
          h('datalist', { id: 'header-names' }, meta.headers.map(x => h('option', { value: x.name }, x.doc))),
          Object.entries(meta.headerValues).map(([name, values]) =>
            h('datalist', { id: `hv-${name}` }, values.map(v => h('option', { value: v })))),
          pairTable(index, req.headers, {
            id: `${index}.h`, namePlaceholder: 'Header', valuePlaceholder: 'value', separator: ':', addLabel: 'Header',
            nameList: 'header-names', valueList: row => (meta.headerValues[(row.name || '').toLowerCase()] ? `hv-${row.name.toLowerCase()}` : undefined),
            create: () => ({ name: '', value: '' })
          }),
          h('div', { class: 'quick' }, 'Add: ',
            button('Bearer token', 'Authorization: Bearer {{token}}', () => { setHeader(req, 'Authorization', 'Bearer {{token}}'); changed(index, true); }, 'link'),
            button('Basic auth', 'Authorization: Basic user password (encoded automatically)', () => { setHeader(req, 'Authorization', 'Basic {{user}} {{password}}'); changed(index, true); }, 'link'),
            button('Accept JSON', 'Accept: application/json', () => { setHeader(req, 'Accept', 'application/json'); changed(index, true); }, 'link')),
          req.headerExtra.trim() ? [h('h4', {}, 'Other lines ', h('span', { class: 'hint' }, 'comments between the headers')),
            textarea(index, req, 'headerExtra', { 'data-focus': `${index}.hx`, class: 'code', minRows: 2 })] : null
        ];
      case 'body': {
        const type = headerValue(req, 'Content-Type');
        return [
          h('div', { class: 'quick' }, 'Content-Type: ',
            BODY_TYPES.map(([text, mime, template]) => button(text, mime, () => {
              setHeader(req, 'Content-Type', mime);
              if (!req.body.trim() && template) req.body = template;
              changed(index, true);
            }, `chip${type && type.split(';')[0].trim() === mime.split(';')[0] ? ' active' : ''}`)),
            button('none', 'Remove the Content-Type header', () => { setHeader(req, 'Content-Type', null); changed(index, true); }, 'chip'),
            h('span', { class: 'spacer' }),
            button('Format JSON', 'Pretty-print the body (only valid JSON)', e => {
              try {
                req.body = JSON.stringify(JSON.parse(req.body), null, 2);
                changed(index, true);
              } catch (err) {
                /** @type {HTMLElement} */ (e.target).title = `Not valid JSON: ${err.message}`;
                /** @type {HTMLElement} */ (e.target).classList.add('error');
              }
            }, 'secondary')),
          req.method === 'GET' || req.method === 'HEAD'
            ? h('div', { class: 'hint' }, `${req.method} requests are sent without a body.`) : null,
          textarea(index, req, 'body', {
            'data-focus': `${index}.body`, class: 'code', minRows: 8,
            placeholder: req.method === 'GRAPHQL'
              ? 'query {\n  user(id: 1) { name }\n}\n\n{ "variables": "after an empty line" }'
              : '{\n  "name": "{{user}}"\n}\n\n< ./file.json     – the content of a file\n<@ ./file.json    – … with {{variables}} replaced'
          })
        ];
      }
      case 'scripts':
        return [
          h('h4', {}, 'Pre-request script ', h('span', { class: 'hint' }, '< {% … %} or < ./script.js'),
            h('span', { class: 'spacer' }),
            !b.preScript.trim() ? button('Insert template', '', () => { b.preScript = PRE_TEMPLATE; changed(index, true); }, 'link') : null),
          textarea(index, b, 'preScript', { 'data-focus': `${index}.pre`, class: 'code', placeholder: PRE_TEMPLATE, minRows: 3 }),
          h('h4', {}, 'Response handler ', h('span', { class: 'hint' }, '> {% … %} or > ./handler.js'),
            h('span', { class: 'spacer' }),
            button('Insert test', 'client.test(…)', () => {
              req.handlers = req.handlers.trim() ? `${req.handlers}\n${TEST_TEMPLATE}` : TEST_TEMPLATE;
              changed(index, true);
            }, 'link')),
          textarea(index, req, 'handlers', { 'data-focus': `${index}.post`, class: 'code', placeholder: TEST_TEMPLATE, minRows: 3 }),
          h('h4', {}, 'Save response body to file ', h('span', { class: 'hint' }, '>> path (a new name each time) or >>! path (overwrite)')),
          h('div', { class: 'row' },
            (() => {
              if (!req.responseFile) req.responseFile = { path: '', overwrite: false };
              return input(index, req.responseFile, 'path', { placeholder: './responses/result.json', 'data-focus': `${index}.rf` });
            })(),
            h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: req.responseFile.overwrite, onchange: e => { req.responseFile.overwrite = e.target.checked; changed(index, false); } }),
              ' overwrite'))
        ];
      case 'options':
        return renderOptions(b, index);
      case 'variables':
        return [
          h('div', { class: 'hint' }, 'In-place variables (@name = value) apply to the whole file, from where they are defined.'),
          pairTable(index, b.variables, variableOpts(index))
        ];
      case 'comments':
        return textarea(index, b, 'comments', { 'data-focus': `${index}.comments`, placeholder: '# Comment lines before the request', minRows: 3 });
    }
    return null;
  }

  function renderOptions(b, index) {
    const tag = name => b.tags.find(t => t.name === name);
    const setTag = (name, value) => {
      const t = tag(name);
      if (value === null) b.tags = b.tags.filter(x => x !== t);
      else if (t) t.value = value;
      else b.tags.push({ name, value });
    };
    const doc = name => (meta.tags.find(t => t.name === name) || {}).doc || '';
    const others = b.tags.filter(t => !KNOWN_FLAGS.includes(t.name) && !KNOWN_VALUES.includes(t.name));
    return [
      KNOWN_FLAGS.map(name => h('label', { class: 'check option', title: doc(name) },
        h('input', { type: 'checkbox', checked: !!tag(name), onchange: e => { setTag(name, e.target.checked ? '' : null); changed(index, false); } }),
        ` @${name}`, h('span', { class: 'hint' }, doc(name).replace(/`/g, '')))),
      KNOWN_VALUES.map(name => {
        const t = tag(name);
        return h('label', { class: 'field option' }, h('span', { class: 'field-label' }, `@${name}`),
          h('input', {
            type: 'text', value: t ? t.value : '', placeholder: name === 'timeout' ? 'e.g. 30 or 2 m' : 'e.g. 500 ms', 'data-focus': `${index}.${name}`,
            oninput: e => { setTag(name, e.target.value.trim() === '' ? null : e.target.value); changed(index, false); }
          }),
          h('span', { class: 'hint' }, doc(name).replace(/`/g, '')));
      }),
      [h('h4', {}, 'Other tags'),
        pairTable(index, others, {
          id: `${index}.t`, namePlaceholder: 'tag', valuePlaceholder: 'value', separator: '', addLabel: 'Tag',
          // The rows are the objects in b.tags, so adding and removing goes there.
          create: () => ({ name: '', value: '' }),
          add: row => b.tags.push(row),
          remove: row => { b.tags = b.tags.filter(t => t !== row); }
        })]
    ];
  }

  document.addEventListener('keydown', e => {
    // Ctrl+F: filter
    if (e.key === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      const f = document.querySelector('input.filter');
      if (f instanceof HTMLInputElement) { e.preventDefault(); f.focus(); f.select(); }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
