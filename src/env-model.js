'use strict';

/**
 * Model of the environment files for the environment editor: http-client.env.json (public) and
 * http-client.private.env.json (private) shown as one table – a row per variable, a column per
 * environment. Changes are operations on the parsed files, so values that are not changed stay
 * as they are, and values that are not text (objects such as SSLConfiguration) are kept.
 */

const SHARED = '$shared';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Table of both files. A cell is { value, private, kind } with kind 'string' | 'number' | 'boolean' | 'json'. */
function envModel(pub, priv) {
  pub = isObject(pub) ? pub : {};
  priv = isObject(priv) ? priv : {};
  const environments = [];
  for (const name of [...Object.keys(pub), ...Object.keys(priv)]) {
    if (!environments.includes(name) && (isObject(pub[name]) || isObject(priv[name]))) environments.push(name);
  }
  // $shared first, the others in the order of the files
  environments.sort((a, b) => (b === SHARED) - (a === SHARED));
  const variables = [];
  const cells = {};
  for (const env of environments) {
    // The private file wins, as when the request is sent.
    for (const [file, isPrivate] of [[pub, false], [priv, true]]) {
      const values = isObject(file[env]) ? file[env] : {};
      for (const [name, value] of Object.entries(values)) {
        if (!variables.includes(name)) variables.push(name);
        cells[name] = cells[name] || {};
        cells[name][env] = describe(value, isPrivate, cells[name][env]);
      }
    }
  }
  return { environments, variables, cells };
}

function describe(value, isPrivate, shadowed) {
  const kind = typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number'
    : typeof value === 'boolean' ? 'boolean' : 'json';
  return {
    value: kind === 'string' ? value : kind === 'json' ? JSON.stringify(value) : String(value),
    private: isPrivate,
    kind,
    // the same variable is also in the public file (the private value is used)
    shadowsPublic: !!(isPrivate && shadowed)
  };
}

/** Text from the form, with the type of the old value where it fits (numbers and booleans stay what they were). */
function typedValue(text, old) {
  if (typeof old === 'number' && text.trim() !== '' && !Number.isNaN(Number(text))) return Number(text);
  if (typeof old === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  return text;
}

/** Renames a key and keeps its position. */
function renameKey(obj, from, to) {
  if (!isObject(obj) || !(from in obj) || from === to) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === to) continue;
    out[k === from ? to : k] = v;
  }
  return out;
}

/**
 * Applies a change of the form to both files (parsed JSON; null for a missing file) and returns
 * the new contents { pub, priv }. Operations:
 *   { op: 'set', env, name, value, private }   value of one cell, in the public or private file
 *   { op: 'move', env, name, private }         move a cell to the other file
 *   { op: 'delete', env, name }                remove a cell
 *   { op: 'addVariable', name }                new variable, empty in every environment
 *   { op: 'renameVariable', from, to }  { op: 'deleteVariable', name }
 *   { op: 'addEnvironment', env }  { op: 'renameEnvironment', from, to }  { op: 'deleteEnvironment', env }
 */
function applyEnvOperation(pub, priv, change) {
  pub = isObject(pub) ? JSON.parse(JSON.stringify(pub)) : null;
  priv = isObject(priv) ? JSON.parse(JSON.stringify(priv)) : null;
  const fileOf = isPrivate => {
    if (isPrivate) return (priv = priv || {});
    return (pub = pub || {});
  };
  const section = (file, env) => (isObject(file[env]) ? file[env] : (file[env] = {}));
  const both = () => [pub, priv].filter(Boolean);
  const envs = () => envModel(pub, priv).environments;

  switch (change.op) {
    case 'set': {
      const file = fileOf(change.private);
      const values = section(file, change.env);
      values[change.name] = typedValue(change.value, values[change.name]);
      break;
    }
    case 'move': {
      const from = change.private ? pub : priv;
      if (!from || !isObject(from[change.env]) || !(change.name in from[change.env])) break;
      const value = from[change.env][change.name];
      delete from[change.env][change.name];
      section(fileOf(change.private), change.env)[change.name] = value;
      break;
    }
    case 'delete':
      for (const file of both()) if (isObject(file[change.env])) delete file[change.env][change.name];
      break;
    case 'addVariable': {
      const targets = envs().filter(e => e !== SHARED);
      if (!targets.length) targets.push(envs().length ? SHARED : 'dev');
      for (const env of targets) {
        const values = section(fileOf(false), env);
        if (!(change.name in values) && !(priv && isObject(priv[env]) && change.name in priv[env])) values[change.name] = '';
      }
      break;
    }
    case 'renameVariable':
      for (const file of both()) {
        for (const env of Object.keys(file)) file[env] = renameKey(file[env], change.from, change.to);
      }
      break;
    case 'deleteVariable':
      for (const file of both()) {
        for (const env of Object.keys(file)) if (isObject(file[env])) delete file[env][change.name];
      }
      break;
    case 'addEnvironment':
      if (!envs().includes(change.env)) section(fileOf(false), change.env);
      break;
    case 'renameEnvironment':
      if (pub) pub = renameKey(pub, change.from, change.to);
      if (priv) priv = renameKey(priv, change.from, change.to);
      break;
    case 'deleteEnvironment':
      for (const file of both()) delete file[change.env];
      break;
    default:
      throw new Error(`Unknown operation ${change.op}`);
  }
  return { pub, priv };
}

/** JSON text in the style of the file: its indentation and final line break. */
function formatJson(obj, oldText) {
  const indent = (/\n([ \t]+)"/.exec(oldText || '') || [null, '  '])[1];
  const eol = (oldText || '').includes('\r\n') ? '\r\n' : '\n';
  const finalEol = oldText == null || /\r?\n$/.test(oldText) ? eol : '';
  return JSON.stringify(obj, null, indent).replace(/\n/g, eol) + finalEol;
}

module.exports = { SHARED, envModel, applyEnvOperation, formatJson, typedValue };
