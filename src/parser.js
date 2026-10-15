'use strict';

/**
 * Parser for IntelliJ HTTP Client (.http) files.
 *
 * Supported syntax:
 *   ### Request title                 – request separator (title optional)
 *   # @name login                     – request name; other @tags like @no-redirect, @no-cookie-jar, @timeout 30
 *   @host = example.com               – in-place (file) variables
 *   < {% ... %}  /  < ./script.js     – pre-request script
 *   GET https://{{host}}/path HTTP/1.1
 *       ?param=1                      – indented query continuation lines
 *       &other=2
 *   Header: value
 *
 *   body …
 *   < ./file.json                     – include file in body (raw)
 *   <@ ./file.json                    – include file in body with variable substitution
 *
 *   > {% ... %}  /  > ./handler.js    – response handler
 *   >> ./out.json  /  >>! ./out.json  – save response body (>>! overwrites)
 */

const METHODS = [
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'GRAPHQL'
];

const SEPARATOR_RE = /^###(.*)$/;
const TAG_RE = /^(?:#|\/\/)\s*@([\w-]+)\s*(.*)$/;
const COMMENT_RE = /^(?:#|\/\/)/;
const FILE_VAR_RE = /^@([\w.-]+)\s*=\s*(.*)$/;
const HEADER_RE = /^([^:\s][^:]*?)\s*:\s?(.*)$/;
const HANDLER_START_RE = /^>(?!>)\s*(\{%|\S)/;
const RESPONSE_FILE_RE = /^>>(!?)\s+(.+)$/;
const BODY_FILE_RE = /^<(@?)\s+(\S.*)$/;

function parse(text) {
  const lines = text.split(/\r?\n/);
  const fileVariables = {};
  const requests = [];

  // Split into blocks by ### separators
  const blocks = [];
  let current = { title: '', separatorLine: -1, lines: [] };
  lines.forEach((line, no) => {
    const m = line.match(SEPARATOR_RE);
    if (m) {
      blocks.push(current);
      current = { title: m[1].trim(), separatorLine: no, lines: [] };
    } else {
      current.lines.push({ text: line, no });
    }
  });
  blocks.push(current);

  for (const block of blocks) {
    const req = parseBlock(block, fileVariables);
    if (req) requests.push(req);
  }
  return { requests, fileVariables };
}

function readScript(L, i, prefixLen) {
  const first = L[i].text.trim().slice(prefixLen).trim();
  if (!first.startsWith('{%')) {
    return { script: { file: first, line: L[i].no }, end: i };
  }
  let rest = first.slice(2);
  const closeIdx = rest.indexOf('%}');
  if (closeIdx >= 0) {
    return { script: { code: rest.slice(0, closeIdx), line: L[i].no }, end: i };
  }
  const codeLines = [rest];
  let j = i + 1;
  for (; j < L.length; j++) {
    const t = L[j].text;
    const idx = t.indexOf('%}');
    if (idx >= 0) {
      codeLines.push(t.slice(0, idx));
      break;
    }
    codeLines.push(t);
  }
  return { script: { code: codeLines.join('\n'), line: L[i].no }, end: Math.min(j, L.length - 1) };
}

function parseBlock(block, fileVariables) {
  const L = block.lines;
  const req = {
    title: block.title || null,
    name: null,
    tags: {},
    preScripts: [],
    method: 'GET',
    url: '',
    httpVersion: null,
    headers: [],
    body: [],          // [{type:'text', value}] | [{type:'file', path, substitute}]
    handlers: [],      // [{code, line}] | [{file}]
    responseFile: null,
    line: -1,          // line of request line (0-based)
    startLine: block.separatorLine >= 0 ? block.separatorLine : (L[0] ? L[0].no : 0),
    endLine: L.length ? L[L.length - 1].no : block.separatorLine
  };

  let i = 0;
  // ---- Preamble: comments, tags, file variables, pre-request scripts
  for (; i < L.length; i++) {
    const t = L[i].text.trim();
    if (!t) continue;
    let m;
    if ((m = t.match(TAG_RE))) {
      const value = m[2].trim();
      if (m[1] === 'name') req.name = value;
      else req.tags[m[1]] = value === '' ? true : value;
      continue;
    }
    if (COMMENT_RE.test(t)) continue;
    if ((m = t.match(FILE_VAR_RE))) {
      fileVariables[m[1]] = m[2].trim();
      continue;
    }
    if (t.startsWith('<') && !t.startsWith('<@')) {
      const r = readScript(L, i, 1);
      req.preScripts.push(r.script);
      i = r.end;
      continue;
    }
    break;
  }
  if (i >= L.length) return null;

  // ---- Request line (+ continuation lines)
  let requestLine = L[i].text.trim();
  req.line = L[i].no;
  i++;
  while (i < L.length && /^\s+[?&/#]/.test(L[i].text)) {
    requestLine += L[i].text.trim();
    i++;
  }
  let rl = requestLine;
  const vm = rl.match(/\s+(HTTP\/[\d.]+)$/i);
  if (vm) {
    req.httpVersion = vm[1].toUpperCase();
    rl = rl.slice(0, vm.index);
  }
  const mm = rl.match(/^([A-Za-z]+)\s+(\S.*)$/);
  if (mm && METHODS.includes(mm[1].toUpperCase())) {
    req.method = mm[1].toUpperCase();
    req.url = mm[2].trim();
  } else {
    req.url = rl.trim();
  }

  // ---- Headers
  let inHandlers = false;
  for (; i < L.length; i++) {
    const raw = L[i].text;
    const t = raw.trim();
    if (!t) { i++; break; }
    if (HANDLER_START_RE.test(t) || RESPONSE_FILE_RE.test(t)) { inHandlers = true; break; }
    if (COMMENT_RE.test(t)) continue;
    const hm = t.match(HEADER_RE);
    if (hm) req.headers.push({ name: hm[1].trim(), value: hm[2].trim() });
  }

  // ---- Body
  if (!inHandlers) {
    for (; i < L.length; i++) {
      const raw = L[i].text;
      const t = raw.trim();
      if (HANDLER_START_RE.test(t) || RESPONSE_FILE_RE.test(t)) break;
      const fm = raw.match(BODY_FILE_RE);
      if (fm) req.body.push({ type: 'file', path: fm[2].trim(), substitute: fm[1] === '@', line: L[i].no });
      else req.body.push({ type: 'text', value: raw });
    }
    // trim trailing empty lines
    while (req.body.length && req.body[req.body.length - 1].type === 'text' &&
           req.body[req.body.length - 1].value.trim() === '') {
      req.body.pop();
    }
  }

  // ---- Response handlers / response file
  for (; i < L.length; i++) {
    const t = L[i].text.trim();
    if (!t || (COMMENT_RE.test(t) && !t.startsWith('>'))) continue;
    let m;
    if ((m = t.match(RESPONSE_FILE_RE))) {
      req.responseFile = { path: m[2].trim(), overwrite: m[1] === '!', line: L[i].no };
      continue;
    }
    if (t.startsWith('>')) {
      const r = readScript(L, i, 1);
      req.handlers.push(r.script);
      i = r.end;
    }
  }

  return req;
}

/** Returns the request containing the given 0-based line, or the nearest one above. */
function findRequestAt(parsed, line) {
  let found = null;
  for (const r of parsed.requests) {
    if (r.startLine <= line) found = r;
    else break;
  }
  return found || parsed.requests[0] || null;
}

module.exports = { parse, findRequestAt, METHODS };
