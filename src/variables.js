'use strict';

const crypto = require('crypto');

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALPHA = LOWER + LOWER.toUpperCase();
const ALNUM = ALPHA + '0123456789';
const HEX = '0123456789abcdef';

const pick = (chars, n) => {
  let s = '';
  for (let i = 0; i < Number(n); i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};
const randInt = (from, to) => Math.floor(Math.random() * (Number(to) - Number(from))) + Number(from);

/** The `$random` object, also exposed to scripts. */
const random = {
  get uuid() { return crypto.randomUUID(); },
  integer: (from = 0, to = 1000) => randInt(from, to),
  float: (from = 0, to = 1000) => Math.random() * (Number(to) - Number(from)) + Number(from),
  alphabetic: (length = 10) => pick(ALPHA, length),
  alphanumeric: (length = 10) => pick(ALNUM, length),
  hexadecimal: (length = 10) => pick(HEX, length),
  get email() { return `${pick(LOWER, 8)}@${pick(LOWER, 6)}.com`; }
};

const DYNAMIC_VARIABLES = [
  ['$uuid', 'Random UUID v4'],
  ['$random.uuid', 'Random UUID v4'],
  ['$timestamp', 'Current UNIX timestamp (seconds)'],
  ['$isoTimestamp', 'Current time as ISO-8601 (UTC)'],
  ['$randomInt', 'Random integer 0–1000'],
  ['$random.integer(0, 100)', 'Random integer in [from, to)'],
  ['$random.float(0, 1)', 'Random float in [from, to)'],
  ['$random.alphabetic(10)', 'Random letters'],
  ['$random.alphanumeric(10)', 'Random letters and digits'],
  ['$random.hexadecimal(10)', 'Random hex string'],
  ['$random.email', 'Random e-mail address'],
  ['$env.NAME', 'OS environment variable'],
  ['$projectRoot', 'Workspace folder of the .http file']
];

function parseArgs(s) {
  return s.split(',').map(a => a.trim()).filter(Boolean).map(a => a.replace(/^['"]|['"]$/g, ''));
}

/** Resolve a `$…` dynamic variable expression. Returns undefined if unknown. */
function resolveDynamic(expr) {
  const name = expr.slice(1).trim();
  switch (name) {
    case 'uuid':
    case 'random.uuid': return crypto.randomUUID();
    case 'timestamp': return Math.floor(Date.now() / 1000);
    case 'isoTimestamp': return new Date().toISOString();
    case 'randomInt': return randInt(0, 1000);
    case 'random.email': return random.email;
  }
  let m = name.match(/^random\.(integer|float|alphabetic|alphanumeric|hexadecimal)\((.*)\)$/);
  if (m) return random[m[1]](...parseArgs(m[2]));
  m = name.match(/^random\.(alphabetic|alphanumeric|hexadecimal)$/);
  if (m) return random[m[1]]();
  m = name.match(/^(?:env|processEnv)\.(.+)$/);
  if (m) return process.env[m[1]];
  return undefined;
}

const VARIABLE_RE = /\{\{\s*(.+?)\s*\}\}/g;

/** Replace every {{name}} using resolve(name); unresolved ones are left as-is. */
function substitute(text, resolve) {
  return text.replace(VARIABLE_RE, (all, name) => {
    const v = resolve(name);
    return v === undefined || v === null ? all : String(v);
  });
}

function stringify(v) {
  if (v === undefined || v === null) return v;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * Builds a resolver over the variable sources in priority order, as documented for the
 * IntelliJ HTTP Client: environment > client.global > in-place file variables > request variables.
 */
function makeResolver(state) {
  const sources = () => [state.envVars, state.globals, state.fileVars, state.requestVars];
  const resolve = (name, depth) => {
    if (depth > 20) return undefined;
    if (name === '$projectRoot') return state.projectRoot;
    if (name.startsWith('$')) return resolveDynamic(name);
    for (const src of sources()) {
      if (src && Object.prototype.hasOwnProperty.call(src, name)) {
        const s = stringify(src[name]);
        if (s === undefined || s === null) return s;
        return substitute(s, n => resolve(n, depth + 1));
      }
    }
    return undefined;
  };
  return name => resolve(name, 0);
}

/** Like makeResolver, but also reports which source a name came from (for hovers). */
function describeVariable(state, name) {
  if (name.startsWith('$')) return { source: 'dynamic', value: makeResolver(state)(name) };
  const named = [
    ['environment', state.envVars], ['global', state.globals],
    ['file', state.fileVars], ['request', state.requestVars]
  ];
  for (const [source, src] of named) {
    if (src && Object.prototype.hasOwnProperty.call(src, name)) {
      return { source, value: makeResolver(state)(name) };
    }
  }
  return null;
}

module.exports = {
  random, resolveDynamic, substitute, makeResolver, describeVariable,
  DYNAMIC_VARIABLES, VARIABLE_RE
};
