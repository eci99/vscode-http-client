'use strict';

/**
 * Model of a .http file for the visual editor: the file is split into blocks at the ### separators
 * like in parser.js, and every block is described by editable fields. Only a block the user changes
 * is written back (serializeBlock); all other lines stay as they are.
 *
 * Everything the form has no field for (comments, scripts, the body, the lines after the body) is
 * kept as raw text, so that nothing is lost when a block is written back.
 */

const { METHODS } = require('./parser');

const SEPARATOR_RE = /^###(.*)$/;
const TAG_RE = /^(?:#|\/\/)\s*@([\w-]+)\s*(.*)$/;
const COMMENT_RE = /^(?:#|\/\/)/;
const FILE_VAR_RE = /^@([\w.-]+)\s*=\s*(.*)$/;
const HEADER_RE = /^([^:\s][^:]*?)\s*:\s?(.*)$/;
const HANDLER_START_RE = /^>(?!>)\s*(\{%|\S)/;
const RESPONSE_FILE_RE = /^>>(!?)\s+(.+)$/;
const CONTINUATION_RE = /^\s+[?&/#]/;

/** Splits the text into blocks: { separator, title, startLine, endLine, lines }. Line numbers are 0-based and inclusive. */
function splitBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = { separator: false, title: '', startLine: 0, lines: [] };
  lines.forEach((line, no) => {
    const m = line.match(SEPARATOR_RE);
    if (m) {
      blocks.push(current);
      current = { separator: true, title: m[1].trim(), startLine: no, lines: [] };
    } else {
      current.lines.push(line);
    }
  });
  blocks.push(current);
  for (const b of blocks) b.endLine = b.startLine + b.lines.length - (b.separator ? 0 : 1);
  // A file without a preamble: the empty first block has no lines at all.
  return blocks.filter(b => b.separator || b.lines.length);
}

/** End index of a script starting at L[i] ("< {% … %}", "> ./file.js"). */
function scriptEnd(L, i) {
  const first = L[i].trim().slice(1).trim();
  if (!first.startsWith('{%') || first.slice(2).includes('%}')) return i;
  for (let j = i + 1; j < L.length; j++) if (L[j].includes('%}')) return j;
  return L.length - 1;
}

/** Splits "https://host/path?a=1&b" into the URL without the query and its parameters. */
function splitUrl(url) {
  const q = url.indexOf('?');
  if (q < 0) return { url, query: [] };
  const query = url.slice(q + 1).split('&').filter(p => p !== '').map(p => {
    const eq = p.indexOf('=');
    return eq < 0 ? { name: p, value: '', eq: false } : { name: p.slice(0, eq), value: p.slice(eq + 1), eq: true };
  });
  return { url: url.slice(0, q), query };
}

function joinQuery(query) {
  return query.filter(p => p.name !== '' || p.value !== '')
    .map(p => (p.eq || p.value !== '' ? `${p.name}=${p.value}` : p.name));
}

function trimBlankEnd(lines) {
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/** The editable fields of one block. */
function blockModel(block) {
  const L = block.lines;
  const model = {
    separator: block.separator,
    title: block.title,
    startLine: block.startLine,
    endLine: block.endLine,
    comments: '',
    commentsGap: false, // an empty line between the comments and what follows
    name: '',
    tags: [],          // [{ name, value }], value '' for flags like @no-log
    variables: [],     // [{ name, value }]
    preScript: '',
    request: null,
    trailingBlank: 0
  };
  let last = L.length - 1;
  while (last >= 0 && L[last].trim() === '') last--;
  model.trailingBlank = L.length - 1 - last;
  const comments = [];
  const pre = [];

  let i = 0;
  let blanks = 0; // empty lines since the last line, kept between comments
  for (; i <= last; i++) {
    const t = L[i].trim();
    if (!t) { blanks++; continue; }
    const gap = blanks;
    blanks = 0;
    let m;
    if ((m = t.match(TAG_RE))) {
      const value = m[2].trim();
      if (m[1] === 'name') model.name = value.replace(/^=\s*/, '');
      else model.tags.push({ name: m[1], value });
      continue;
    }
    if (COMMENT_RE.test(t)) {
      if (comments.length) for (let k = 0; k < gap; k++) comments.push('');
      comments.push(L[i]);
      model.commentsGap = i < last && L[i + 1].trim() === '';
      continue;
    }
    if ((m = t.match(FILE_VAR_RE))) { model.variables.push({ name: m[1], value: m[2].trim() }); continue; }
    if (t.startsWith('<') && !t.startsWith('<@')) {
      const end = scriptEnd(L, i);
      pre.push(...L.slice(i, end + 1));
      i = end;
      continue;
    }
    break;
  }
  model.comments = comments.join('\n');
  model.preScript = pre.join('\n');
  if (i > last) return model;

  // Request line and indented query continuation lines
  let requestLine = L[i].trim();
  let multiline = false;
  for (i++; i <= last && CONTINUATION_RE.test(L[i]); i++) {
    requestLine += L[i].trim();
    multiline = true;
  }
  const req = { method: 'GET', url: '', query: [], multilineQuery: false, httpVersion: '', headers: [], headerExtra: '', body: '', handlers: '', responseFile: null };
  let rl = requestLine;
  const vm = rl.match(/\s+(HTTP\/[\d.]+)$/i);
  if (vm) { req.httpVersion = vm[1].toUpperCase(); rl = rl.slice(0, vm.index); }
  const mm = rl.match(/^([A-Za-z]+)\s+(\S.*)$/);
  if (mm && METHODS.includes(mm[1].toUpperCase())) {
    req.method = mm[1].toUpperCase();
    rl = mm[2].trim();
  }
  Object.assign(req, splitUrl(rl.trim()));
  req.multilineQuery = multiline && req.query.length > 0;

  // Headers up to the first empty line
  const extra = [];
  let inHandlers = false;
  for (; i <= last; i++) {
    const t = L[i].trim();
    if (!t) { i++; break; }
    if (HANDLER_START_RE.test(t) || RESPONSE_FILE_RE.test(t)) { inHandlers = true; break; }
    const hm = !COMMENT_RE.test(t) && t.match(HEADER_RE);
    if (hm) req.headers.push({ name: hm[1].trim(), value: hm[2].trim() });
    else extra.push(L[i]);
  }
  req.headerExtra = extra.join('\n');

  // Body up to the first response handler or ">>" line
  const body = [];
  if (!inHandlers) {
    for (; i <= last; i++) {
      const t = L[i].trim();
      if (HANDLER_START_RE.test(t) || RESPONSE_FILE_RE.test(t)) break;
      body.push(L[i]);
    }
  }
  req.body = trimBlankEnd(body).join('\n');

  // Response handlers; the last ">>" line (the one that counts) gets its own fields.
  const post = L.slice(i, last + 1);
  let fileIdx = -1;
  post.forEach((line, k) => { if (RESPONSE_FILE_RE.test(line.trim())) fileIdx = k; });
  if (fileIdx >= 0) {
    const m = post[fileIdx].trim().match(RESPONSE_FILE_RE);
    req.responseFile = { path: m[2].trim(), overwrite: m[1] === '!' };
    post.splice(fileIdx, 1);
  }
  req.handlers = trimBlankEnd(post).join('\n');
  model.request = req;
  return model;
}

/** All blocks of a .http text with their fields. */
function toModel(text) {
  return splitBlocks(text).map(blockModel);
}

/** The lines of a block, written from its fields. */
function serializeBlock(model, opts = {}) {
  const out = [];
  const nonEmpty = s => (s && s.trim() !== '' ? s.split(/\r?\n/) : []);
  if (model.separator || opts.separator) out.push(model.title ? `### ${model.title}` : '###');
  const comments = nonEmpty(model.comments);
  out.push(...comments);
  const rest = out.length;
  if (model.name && model.name.trim()) out.push(`# @name ${model.name.trim()}`);
  for (const t of model.tags || []) {
    if (!t.name || !t.name.trim()) continue;
    out.push(t.value !== '' && t.value != null ? `# @${t.name.trim()} ${t.value}` : `# @${t.name.trim()}`);
  }
  for (const v of model.variables || []) {
    if (v.name && v.name.trim()) out.push(`@${v.name.trim()} = ${v.value}`);
  }
  out.push(...nonEmpty(model.preScript));

  const req = model.request;
  if (req) {
    const params = joinQuery(req.query || []);
    const version = req.httpVersion ? ` ${req.httpVersion}` : '';
    const url = (req.url || '').trim();
    if (req.multilineQuery && params.length) {
      // The HTTP version ends the request line, so it follows the last parameter.
      out.push(`${req.method} ${url}`);
      params.forEach((p, k) => out.push(`    ${k ? '&' : '?'}${p}${k === params.length - 1 ? version : ''}`));
    } else {
      out.push(`${req.method} ${url}${params.length ? `?${params.join('&')}` : ''}${version}`);
    }
    for (const h of req.headers || []) {
      if (h.name && h.name.trim()) out.push(`${h.name.trim()}: ${h.value}`);
    }
    out.push(...nonEmpty(req.headerExtra));
    const body = trimBlankEnd((req.body || '').split(/\r?\n/));
    if (body.length) out.push('', ...body);
    const handlers = nonEmpty(req.handlers);
    const file = req.responseFile && req.responseFile.path && req.responseFile.path.trim()
      ? [`>>${req.responseFile.overwrite ? '!' : ''} ${req.responseFile.path.trim()}`] : [];
    if (handlers.length || file.length) out.push('', ...handlers, ...file);
  }
  if (comments.length && model.commentsGap && out.length > rest) out.splice(rest, 0, '');
  for (let k = 0; k < (model.trailingBlank || 0); k++) out.push('');
  return out;
}

/** The text of a new request block. */
function newRequestLines(title = 'New request') {
  return [`### ${title}`, 'GET https://'];
}

const blankLines = n => new Array(n).fill('');

/**
 * Adds, deletes, duplicates or moves a block. Only the blocks involved change; the moved and copied
 * blocks keep their text. Returns the new text and the index of the block to show (-1: none).
 */
function applyOperation(text, op, index) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const blocks = splitBlocks(text);
  const raw = b => {
    const own = lines.slice(b.startLine, b.endLine + 1);
    return b.separator ? own : ['###', ...own];
  };
  const trailing = b => {
    const own = lines.slice(b.startLine, b.endLine + 1);
    return own.length - trimBlankEnd(own).length;
  };
  let out;
  let focus = index;
  const b = blocks[index];
  if (op === 'add') {
    const head = trimBlankEnd(lines);
    out = [...head, ...(head.length ? [''] : []), ...newRequestLines(), ''];
    focus = splitBlocks(out.join('\n')).length - 1;
  } else if (!b) {
    return { text, index: -1 };
  } else if (op === 'delete') {
    out = [...lines.slice(0, b.startLine), ...lines.slice(b.endLine + 1)];
    focus = -1;
  } else if (op === 'duplicate') {
    const copy = trimBlankEnd(raw(b)).map(l => l.replace(/^(\s*(?:#|\/\/)\s*@name\s*(?:=\s*)?)(\S+)/, '$1$2-copy'));
    const tail = lines.slice(b.endLine + 1);
    const gap = Math.max(trailing(b), 1);
    out = [...trimBlankEnd(lines.slice(0, b.endLine + 1)), ...blankLines(gap), ...copy,
      ...blankLines(tail.length ? gap : trailing(b)), ...tail];
    focus = index + 1;
  } else if (op === 'up' || op === 'down') {
    const upper = blocks[op === 'up' ? index - 1 : index];
    const lower = blocks[op === 'up' ? index : index + 1];
    if (!upper || !lower) return { text, index };
    // Each position keeps its empty lines, so the spacing of the file stays the same.
    out = [...lines.slice(0, upper.startLine),
      ...trimBlankEnd(raw(lower)), ...blankLines(Math.max(trailing(upper), 1)),
      ...trimBlankEnd(raw(upper)), ...blankLines(trailing(lower)),
      ...lines.slice(lower.endLine + 1)];
    focus = op === 'up' ? index - 1 : index + 1;
  } else {
    return { text, index };
  }
  return { text: out.join(eol), index: focus };
}

module.exports = { splitBlocks, toModel, blockModel, serializeBlock, splitUrl, newRequestLines, applyOperation, trimBlankEnd };
