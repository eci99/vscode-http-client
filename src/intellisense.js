'use strict';

/**
 * Editor-independent logic for completion and hover in .http files: where the cursor is
 * (request line, header, script, …) and what can be suggested there.
 */

const { METHODS } = require('./parser');

/** The documentation; completion items and hovers link to its sections. */
const DOCS_URL = 'https://github.com/eci99/vscode-http-client/blob/main/docs/documentation.md';
const docsUrl = anchor => `${DOCS_URL}#${anchor}`;

const METHOD_DOCS = {
  GET: 'Reads a resource. A body is not sent.',
  POST: 'Sends data, e.g. to create a resource.',
  PUT: 'Replaces a resource with the body.',
  DELETE: 'Deletes a resource.',
  PATCH: 'Changes part of a resource.',
  HEAD: 'Like `GET`, but only the headers are returned. A body is not sent.',
  OPTIONS: 'Asks which methods and headers the server allows (e.g. for CORS).',
  TRACE: 'Echoes the request back (diagnostics).',
  CONNECT: 'Opens a tunnel through a proxy.',
  GRAPHQL: 'Sends a GraphQL query as `POST` with a JSON body; a JSON block after an empty line becomes `variables`.'
};

const TAGS = [
  ['name', '# @name login', 'Names the request, e.g. for **Resend** and the response tab. `# @name = login` works too.'],
  ['no-redirect', '# @no-redirect', 'Do not follow redirects (3xx); the redirect response itself is shown.'],
  ['no-log', '# @no-log', 'Do not write the request to the *HTTP-Client* log (the output of its scripts still is).'],
  ['no-cookie-jar', '# @no-cookie-jar', 'Neither send nor store cookies for this request.'],
  ['no-auto-encoding', '# @no-auto-encoding', 'Send the query as written, without percent-encoding characters such as space, `@`, `#` or `$`.'],
  ['timeout', '# @timeout 30', 'Request timeout, in seconds or with a unit: `500 ms`, `30 s`, `2 m`. Default: setting `httpClient.timeoutSeconds`.'],
  ['connection-timeout', '# @connection-timeout 2 m', 'Maximum time until the response headers arrive, in seconds or with a unit: `500 ms`, `30 s`, `2 m`.']
];

const HTTP_VERSIONS = ['HTTP/1.1', 'HTTP/2'];
const HTTP_VERSION_DOC = 'Accepted for compatibility with the IntelliJ HTTP Client; requests are always sent with HTTP/1.1.';

const HEADERS = [
  ['Accept', 'Media types the client accepts in the response.'],
  ['Accept-Charset', 'Character sets the client accepts.'],
  ['Accept-Encoding', 'Content encodings (compression) the client accepts.'],
  ['Accept-Language', 'Preferred natural languages of the response.'],
  ['Authorization', 'Credentials, e.g. `Bearer {{token}}`, or `Basic user password` (encoded automatically).'],
  ['Cache-Control', 'Caching directives.'],
  ['Connection', 'Whether the connection stays open after the request.'],
  ['Content-Disposition', 'In multipart bodies: name and file name of a part.'],
  ['Content-Encoding', 'Encoding (compression) applied to the body.'],
  ['Content-Length', 'Size of the body in bytes (normally computed automatically).'],
  ['Content-Type', 'Media type of the body.'],
  ['Cookie', 'Cookies to send (the cookie jar adds stored cookies automatically).'],
  ['Expect', 'Expectations the server has to meet, e.g. `100-continue`.'],
  ['Forwarded', 'Information from proxies about the original request.'],
  ['From', 'E-mail address of the user making the request.'],
  ['Host', 'Host and port of the server (taken from the URL by default).'],
  ['If-Match', 'Only perform the request if the ETag matches.'],
  ['If-Modified-Since', 'Only return the resource if it changed since this date.'],
  ['If-None-Match', 'Only return the resource if the ETag does not match.'],
  ['If-Unmodified-Since', 'Only perform the request if the resource did not change since this date.'],
  ['Origin', 'Origin of a cross-site request.'],
  ['Pragma', 'Legacy caching directive (`no-cache`).'],
  ['Range', 'Request only part of the resource, e.g. `bytes=0-1023`.'],
  ['Referer', 'Address of the page the request comes from.'],
  ['User-Agent', 'Identifies the client software.'],
  ['X-API-Key', 'API key (common, not standardized).'],
  ['X-Correlation-ID', 'Correlates requests across services (common, not standardized).'],
  ['X-Forwarded-For', 'Original client IP behind proxies.'],
  ['X-Request-ID', 'Unique ID of the request (common, not standardized).'],
  ['X-Requested-With', 'Marks AJAX requests (`XMLHttpRequest`).']
];

const MEDIA_TYPES = [
  'application/json', 'application/xml', 'application/x-www-form-urlencoded',
  'multipart/form-data; boundary=WebAppBoundary', 'text/plain', 'text/html', 'text/xml', 'text/csv',
  'application/graphql', 'application/octet-stream', 'application/problem+json', 'application/pdf'
];

// Explanations of header values that do more than their name says.
const HEADER_VALUE_DOCS = {
  'authorization': {
    'Bearer ': ['Token authentication: `Bearer {{token}}`.', 'headers'],
    'Basic ': ['`Basic user password` is Base64-encoded automatically; an already encoded value is sent unchanged.', 'basic-authentication']
  },
  'content-type': {
    'multipart/form-data; boundary=WebAppBoundary': ['Parts start with `--WebAppBoundary`; file parts use `< ./file`. The last line is `--WebAppBoundary--`.', 'multipart'],
    'application/x-www-form-urlencoded': ['Body as `key=value&key2=value2`; escape `%`, `&`, `=` and `+` in values.', 'form-data'],
    'application/graphql': ['For GraphQL, the `GRAPHQL` method is easier: it builds the JSON body itself.', 'graphql']
  }
};

const HEADER_VALUES = {
  'accept': ['*/*', ...MEDIA_TYPES.filter(t => !t.startsWith('multipart'))],
  'content-type': MEDIA_TYPES,
  'accept-encoding': ['gzip, deflate, br', 'gzip', 'deflate', 'br', 'identity'],
  'content-encoding': ['gzip', 'deflate', 'br'],
  'accept-language': ['en-US,en;q=0.9', 'de-DE,de;q=0.9,en;q=0.8', 'en', 'de'],
  'accept-charset': ['utf-8', 'iso-8859-1'],
  'authorization': ['Bearer ', 'Basic '],
  'cache-control': ['no-cache', 'no-store', 'max-age=0', 'must-revalidate', 'no-transform'],
  'connection': ['keep-alive', 'close'],
  'content-disposition': ['form-data; name=""', 'form-data; name=""; filename=""', 'attachment; filename=""'],
  'expect': ['100-continue'],
  'pragma': ['no-cache'],
  'range': ['bytes=0-1023'],
  'x-requested-with': ['XMLHttpRequest']
};

// ---------- script API (see scripting.js) ----------

const m = (detail, doc, snippet) => ({ kind: 'method', detail, doc, snippet });
const p = (detail, doc, members) => ({ kind: 'property', detail, doc, members });

const HASH_BUILDER = {
  updateWithText: m('updateWithText(text, encoding?)', 'Adds text to the input (UTF-8 by default).', 'updateWithText($1)'),
  updateWithHex: m('updateWithHex(hex)', 'Adds bytes given as hex string.', 'updateWithHex($1)'),
  updateWithBase64: m('updateWithBase64(base64, urlSafe?)', 'Adds bytes given as Base64.', 'updateWithBase64($1)'),
  digest: m('digest()', 'Computes the hash; then `.toHex()`, `.toBase64(urlSafe?)` or `.bytes()`.', 'digest()')
};
const HMAC_BUILDER = {
  ...HASH_BUILDER,
  withTextSecret: m('withTextSecret(text, encoding?)', 'Sets the HMAC key as text (UTF-8 by default).', 'withTextSecret($1)'),
  withHexSecret: m('withHexSecret(hex)', 'Sets the HMAC key as hex string.', 'withHexSecret($1)'),
  withBase64Secret: m('withBase64Secret(base64, urlSafe?)', 'Sets the HMAC key as Base64.', 'withBase64Secret($1)')
};
const ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];

const RESPONSE_HEADERS = {
  valueOf: m('valueOf(name): string | null', 'First value of the header (case-insensitive), or `null`.', 'valueOf("$1")'),
  valuesOf: m('valuesOf(name): string[]', 'All values of the header; an empty array if there is none.', 'valuesOf("$1")')
};
const REQUEST_HEADERS = {
  all: m('all(): RequestHeader[]', 'All headers of the request.', 'all()'),
  findByName: m('findByName(name): RequestHeader | null', 'The first header with this name (case-insensitive), or `null`.', 'findByName("$1")')
};
const REQUEST_HEADER = {
  name: p('name: string', 'The header name, e.g. `Content-Type`.'),
  getRawValue: m('getRawValue(): string', 'The value as written, with `{{variables}}` unresolved.', 'getRawValue()'),
  tryGetSubstitutedValue: m('tryGetSubstitutedValue(): string', 'The value with `{{variables}}` resolved.', 'tryGetSubstitutedValue()'),
  value: m('value(): string', 'The value with `{{variables}}` resolved.', 'value()')
};
const STORE = (what, writable = true) => ({
  get: m('get(name)', `Value of ${what}, or \`null\`.`, 'get("$1")'),
  ...(writable ? {
    set: m('set(name, value)', `Sets ${what}, usable as \`{{name}}\`.`, 'set("$1", $2)'),
    isEmpty: m('isEmpty(): boolean', 'Whether no variable is set.', 'isEmpty()'),
    clear: m('clear(name)', `Removes ${what}.`, 'clear("$1")'),
    clearAll: m('clearAll()', 'Removes all of them.', 'clearAll()')
  } : {})
});
const RAW_TEXT_API = {
  getRaw: m('getRaw(): string', 'The text as written, with `{{variables}}` unresolved.', 'getRaw()'),
  tryGetSubstituted: m('tryGetSubstituted(): string', 'The text with `{{variables}}` resolved.', 'tryGetSubstituted()')
};

const CLIENT = p('client', 'Access to global variables, tests and the log.', {
  global: p('client.global', 'Global variables: kept across requests and files until cleared.', {
    set: m('set(name, value)', 'Sets a global variable, usable as `{{name}}` in later requests.', 'set("$1", $2)'),
    get: m('get(name)', 'Value of a global variable, or `null`.', 'get("$1")'),
    isEmpty: m('isEmpty(): boolean', 'Whether no global variable is set.', 'isEmpty()'),
    clear: m('clear(name)', 'Removes a global variable.', 'clear("$1")'),
    clearAll: m('clearAll()', 'Removes all global variables.', 'clearAll()'),
    headers: p('client.global.headers', 'Headers added to all following requests (for this session).', {
      set: m('set(name, value)', 'Adds the header to the following requests (in a pre-request script also to this one), unless a request sets it itself. `null` removes it.', 'set("$1", $2)'),
      clear: m('clear(name)', 'Removes the header.', 'clear("$1")')
    })
  }),
  variables: p('client.variables', 'Single access point to all variable scopes.', {
    global: p('client.variables.global', 'Global variables, same as `client.global`.', STORE('a global variable')),
    file: p('client.variables.file', 'In-place variables `@name = value` of this file (read-only).', STORE('an in-place variable', false)),
    request: p('client.variables.request', 'Variables of this request, same as `request.variables`.', {
      set: m('set(name, value)', 'Sets a variable for this request, usable as `{{name}}`.', 'set("$1", $2)'),
      get: m('get(name)', 'Value of a request variable, or `null`.', 'get("$1")')
    }),
    environment: p('client.variables.environment', 'Variables of the selected environment (read-only), same as `request.environment`.', STORE('an environment variable', false))
  }),
  test: m('test(name, fn)', 'Runs `fn` as a test; it fails if `fn` throws (e.g. via `client.assert`).',
    'test("${1:name}", function () {\n\t$0\n});'),
  assert: m('assert(condition, message?)', 'Throws (fails the test) if `condition` is falsy.', 'assert($1, "${2:message}")'),
  log: m('log(...values)', 'Writes to the *HTTP-Client* output channel.', 'log($1)'),
  exit: m('exit()', 'Ends the script.', 'exit()')
});

const REQUEST = p('request', 'The request being sent.', {
  method: p('request.method: string', 'HTTP method.'),
  url: p('request.url', 'The URL. `request.url()` returns it with variables resolved (as in response handlers).', RAW_TEXT_API),
  body: p('request.body', 'The body. `request.body()` returns it with variables resolved (as in response handlers).', RAW_TEXT_API),
  headers: p('request.headers', 'The request headers.', REQUEST_HEADERS),
  variables: p('request.variables', 'Variables for this request only.', {
    set: m('set(name, value)', 'Sets a variable for this request, usable as `{{name}}`.', 'set("$1", $2)'),
    get: m('get(name)', 'Value of a request variable, or `null`.', 'get("$1")')
  }),
  environment: p('request.environment', 'Variables of the selected environment (read-only).', {
    get: m('get(name)', 'Value of an environment variable, or `null`.', 'get("$1")')
  }),
  environmentName: p('request.environmentName: string | null', 'Name of the selected environment.')
});

const RESPONSE = p('response', 'The response (only in response handlers `> {% %}`).', {
  status: p('response.status: number', 'HTTP status code.'),
  body: p('response.body', 'The body: parsed for JSON, otherwise a string.'),
  headers: p('response.headers', 'The response headers.', RESPONSE_HEADERS),
  contentType: p('response.contentType', 'Media type and charset of the response.', {
    mimeType: p('mimeType: string | null', 'e.g. `application/json`.'),
    charset: p('charset: string | null', 'e.g. `utf-8`.')
  }),
  cookies: m('cookies(): Cookie[]', 'All cookies set by the server (`Set-Cookie`): `name`, `value`, `domain`, `path`, `expires`, `maxAge`, `secure`, `httpOnly`, `sameSite`.', 'cookies()'),
  cookiesByName: m('cookiesByName(name): Cookie[]', 'The cookies set by the server with this name.', 'cookiesByName("$1")')
});

const RANDOM = p('$random', 'Random values.', {
  uuid: p('uuid: string', 'Random UUID v4.'),
  integer: m('integer(from?, to?): number', 'Random integer in [from, to), default 0–1000.', 'integer($1)'),
  float: m('float(from?, to?): number', 'Random float in [from, to), default 0–1000.', 'float($1)'),
  alphabetic: m('alphabetic(length?): string', 'Random letters (default 10).', 'alphabetic($1)'),
  alphanumeric: m('alphanumeric(length?): string', 'Random letters and digits (default 10).', 'alphanumeric($1)'),
  hexadecimal: m('hexadecimal(length?): string', 'Random hex string (default 10).', 'hexadecimal($1)'),
  email: p('email: string', 'Random e-mail address.')
});

const CRYPTO = p('crypto', 'Hashes and HMACs, e.g. `crypto.sha256().updateWithText(s).digest().toHex()`.', {
  ...Object.fromEntries(ALGORITHMS.map(a => [a, m(`${a}()`, `Starts a ${a.toUpperCase()} hash.`, `${a}()`)])),
  sha3: m('sha3(bits)', "Starts a SHA-3 hash; `bits` is `'224'`, `'256'`, `'384'` or `'512'`.", "sha3('${1:256}')"),
  hmac: p('crypto.hmac', 'Starts an HMAC, e.g. `crypto.hmac.sha256().withTextSecret(key)…`.', {
    ...Object.fromEntries(ALGORITHMS.map(a => [a, m(`${a}()`, `Starts an HMAC-${a.toUpperCase()}.`, `${a}()`)])),
    sha3: m('sha3(bits)', "Starts an HMAC with SHA-3; `bits` is `'224'`, `'256'`, `'384'` or `'512'`.", "sha3('${1:256}')")
  })
});

const JWT = p('jwt', 'Create, decode and verify JSON Web Tokens (HS256/384/512, RS…, PS…, ES…).', {
  sign: m('sign(payload, key, options?): string', 'Creates a signed JWT. `key`: secret for HS*, private key (PEM) for RS*/PS*/ES*. `options`: `algorithm` (default `HS256`), `expiresIn`, `notBefore`, `issuer`, `subject`, `audience`, `jwtid`, `keyid`.', 'sign({ $1 }, ${2:key}, { algorithm: "${3:HS256}" })'),
  verify: m('verify(token, key, options?): object', 'Checks signature, `exp` and `nbf`, and optionally `algorithm`, `issuer`, `subject`, `audience`; returns the payload or throws.', 'verify(${1:token}, ${2:key})'),
  decode: m('decode(token): {header, payload, signature}', 'Decodes a JWT without verifying it.', 'decode(${1:token})')
});

const BASE64 = {
  btoa: m('btoa(text): string', 'Encodes a string as Base64.', 'btoa($1)'),
  atob: m('atob(base64): string', 'Decodes a Base64 string.', 'atob($1)')
};

const CONSOLE = p('console', 'Writes to the *HTTP-Client* output channel.',
  Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(n => [n, m(`${n}(...values)`, 'Writes to the output channel.', `${n}($1)`)])));

const SCRIPT_GLOBALS = {
    client: CLIENT,
    request: REQUEST,
    $random: RANDOM,
    crypto: CRYPTO,
    jsonPath: m('jsonPath(value, path)', 'Reads a value by path, e.g. `jsonPath(response.body, "$.items[0].id")`.', 'jsonPath($1, "\\$.$2")'),
    console: CONSOLE,
    jwt: JWT,
    ...BASE64,
    Window: p('Window', 'Provides `btoa()` and `atob()`.', BASE64),
    URLSearchParams: m('new URLSearchParams(init?)', 'Builds or parses a query string, e.g. `new URLSearchParams({ a: 1 }).toString()`.', 'URLSearchParams($1)'),
    $env: p('$env', 'Environment variables of the operating system, e.g. `$env.USER`.'),
    $uuid: p('$uuid: string', 'Random UUID v4 (a new one on every access).'),
    $timestamp: p('$timestamp: number', 'Current UNIX timestamp in seconds.'),
    $isoTimestamp: p('$isoTimestamp: string', 'Current time as ISO-8601 (UTC).'),
    $randomInt: p('$randomInt: number', 'Random integer 0–1000.')
};

/** Top-level names in scripts; `response` only exists in response handlers. */
function scriptGlobals(scriptKind) {
  return scriptKind === 'handler' ? { ...SCRIPT_GLOBALS, response: RESPONSE } : SCRIPT_GLOBALS;
}

// Objects returned by method calls, so that chains like crypto.sha256().digest() complete too.
const RETURNS = {
  'crypto.md5': HASH_BUILDER, 'crypto.sha1': HASH_BUILDER, 'crypto.sha256': HASH_BUILDER,
  'crypto.sha384': HASH_BUILDER, 'crypto.sha512': HASH_BUILDER,
  'crypto.hmac.md5': HMAC_BUILDER, 'crypto.hmac.sha1': HMAC_BUILDER, 'crypto.hmac.sha256': HMAC_BUILDER,
  'crypto.hmac.sha384': HMAC_BUILDER, 'crypto.hmac.sha512': HMAC_BUILDER,
  'crypto.sha3': HASH_BUILDER, 'crypto.hmac.sha3': HMAC_BUILDER,
  'request.headers.findByName': REQUEST_HEADER,
  digest: {
    toHex: m('toHex(): string', 'The hash as hex string.', 'toHex()'),
    toBase64: m('toBase64(urlSafe?): string', 'The hash as Base64; `true` for the URL-safe variant.', 'toBase64()'),
    bytes: m('bytes(): number[]', 'The hash as byte array.', 'bytes()')
  }
};

// Section of the documentation for every entry. The more specific sections come first,
// entries that already have one keep it.
function setAnchor(anchor, ...entries) {
  for (const entry of entries) {
    if (entry.kind) {
      entry.anchor = entry.anchor || anchor;
      if (entry.members) setAnchor(anchor, entry.members);
    } else {
      setAnchor(anchor, ...Object.values(entry)); // a plain map of entries
    }
  }
}
setAnchor('clientglobal', CLIENT.members.global);
setAnchor('clientvariables', CLIENT.members.variables);
setAnchor('client', CLIENT);
setAnchor('request', REQUEST, REQUEST_HEADER);
setAnchor('response', RESPONSE);
setAnchor('crypto', CRYPTO, HASH_BUILDER, HMAC_BUILDER, RETURNS.digest);
setAnchor('jwt', JWT);
setAnchor('jsonpathvalue-path', SCRIPT_GLOBALS.jsonPath);
setAnchor('other-globals', SCRIPT_GLOBALS);

/**
 * Members of an expression such as "client.global" or "crypto.sha256().updateWithText(x)".
 * Returns undefined if unknown.
 */
function membersOf(expr, scriptKind) {
  // Remove call arguments: "a.b(x, y).c" → "a.b().c"
  let e = expr, prev;
  do { prev = e; e = e.replace(/\([^()]*\)/g, '()'); } while (e !== prev);
  const segments = e.split('.');
  let members = scriptGlobals(scriptKind);
  let pathSoFar = '';
  for (const seg of segments) {
    const call = seg.endsWith('()');
    const name = call ? seg.slice(0, -2) : seg;
    const entry = members && members[name];
    if (!entry) return undefined;
    pathSoFar = pathSoFar ? `${pathSoFar}.${name}` : name;
    if (call) {
      if (entry.kind !== 'method') return undefined;
      if (name === 'digest') members = RETURNS.digest;
      else if (RETURNS[pathSoFar]) members = RETURNS[pathSoFar];
      else if (members !== HASH_BUILDER && members !== HMAC_BUILDER) members = undefined; // builders return themselves
    } else {
      members = entry.members;
    }
  }
  return members;
}

// ---------- where the cursor is ----------

const SCRIPT_OPEN_RE = /^\s*([<>])\s*\{%/;

/**
 * Determines the context at a position.
 * @param {string[]} lines document lines
 * @returns {{ kind: 'requestStart' | 'httpVersion' | 'tag' | 'headerName' | 'headerValue' | 'script' | 'other', ... }}
 */
function contextAt(lines, line, character) {
  let start = line;
  while (start > 0 && !/^###/.test(lines[start])) start--;
  if (/^###/.test(lines[start])) {
    if (start === line) return { kind: 'other' };
    start++;
  }

  let section = 'preamble'; // → requestLine → headers → body
  let script = null; // 'pre' | 'handler' while inside {% … %}
  for (let i = start; i < line; i++) {
    const t = lines[i];
    if (script) {
      if (t.includes('%}')) script = null;
      continue;
    }
    const open = t.match(SCRIPT_OPEN_RE);
    if (open) {
      if (!t.slice(t.indexOf('{%') + 2).includes('%}')) script = open[1] === '<' ? 'pre' : 'handler';
      if (open[1] === '>') section = 'body';
      continue;
    }
    const trimmed = t.trim();
    if (section === 'preamble') {
      if (trimmed && !/^(#|\/\/|@|<)/.test(trimmed)) section = 'requestLine';
    } else if (section === 'requestLine') {
      if (!trimmed) section = 'body';
      else if (!/^\s+[?&/#]/.test(t)) section = 'headers';
    } else if (section === 'headers') {
      if (!trimmed) section = 'body';
    }
  }

  const text = lines[line] || '';
  const before = text.slice(0, character);
  if (script) {
    const close = text.indexOf('%}');
    if (close < 0 || close >= character) return { kind: 'script', scriptKind: script, before };
    return { kind: 'other' };
  }
  const open = text.match(SCRIPT_OPEN_RE);
  if (open) {
    const codeStart = text.indexOf('{%') + 2;
    const close = text.indexOf('%}', codeStart);
    if (character >= codeStart && (close < 0 || character <= close)) {
      return { kind: 'script', scriptKind: open[1] === '<' ? 'pre' : 'handler', before: before.slice(codeStart) };
    }
    return { kind: 'other' };
  }

  let tag;
  if ((tag = before.match(/^\s*(?:#|\/\/)\s*@([\w-]*)$/))) return { kind: 'tag', typed: tag[1] };
  if (section === 'preamble' && /^[A-Za-z]*$/.test(before) && !/^[A-Za-z]*:/.test(text)) {
    return { kind: 'requestStart', typed: before };
  }
  // After the URL of the request line (method optional): the HTTP version
  const version = section === 'preamble' && before.match(/^(?:[A-Za-z]+\s+)?\S*[/:.{]\S*\s+(H[\w/.]*)?$/);
  if (version) return { kind: 'httpVersion', typed: version[1] || '' };
  if (section === 'requestLine' || section === 'headers') {
    // A line right after the request line is a header unless it continues the URL.
    if (/^\s+[?&/#]/.test(text) && section === 'requestLine') return { kind: 'other' };
    if (/^\s*(#|\/\/|>|<)/.test(text)) return { kind: 'other' };
    const value = before.match(/^([^:\s][^:]*?)\s*:\s?(.*)$/);
    if (value) return { kind: 'headerValue', name: value[1], typed: value[2] };
    if (/^[\w-]*$/.test(before)) return { kind: 'headerName', typed: before };
  }
  return { kind: 'other' };
}

/**
 * Completions in a script for the text before the cursor.
 * Returns { members: {name: entry}, typed } or { names: 'global' | 'environment', typed }, or undefined.
 */
function scriptCompletions(before, scriptKind) {
  // Inside the string argument of a call that takes a variable name
  const arg = before.match(/\b(client\.global\.(?:get|set|clear)|request\.environment\.get)\(\s*["']([\w.$-]*)$/);
  if (arg) return { names: arg[1].startsWith('client') ? 'global' : 'environment', typed: arg[2] };
  // No suggestions inside other strings: a quote is left after removing the closed strings.
  if (/["'`]/.test(before.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, ''))) return undefined;
  const member = before.match(/((?:[\w$]+(?:\([^()]*\))?\.)+)([\w$]*)$/);
  if (member) {
    const members = membersOf(member[1].slice(0, -1), scriptKind);
    return members ? { members, typed: member[2] } : undefined;
  }
  const word = before.match(/(?:^|[^\w$.])([\w$]*)$/);
  return word ? { members: scriptGlobals(scriptKind), typed: word[1] } : undefined;
}

/** The API entry for the identifier at a position in script text, for hovers. */
function scriptEntryAt(text, character, scriptKind) {
  const re = /[\w$]+/g;
  let mm;
  while ((mm = re.exec(text))) {
    if (mm.index <= character && character <= mm.index + mm[0].length) {
      const end = mm.index + mm[0].length;
      const before = text.slice(0, mm.index);
      const owner = before.match(/((?:[\w$]+(?:\([^()]*\))?\.)+)$/);
      const members = owner ? membersOf(owner[1].slice(0, -1), scriptKind) : scriptGlobals(scriptKind);
      const entry = members && members[mm[0]];
      return entry ? { entry, name: mm[0], start: mm.index, end } : undefined;
    }
  }
  return undefined;
}

/**
 * Help for the element at a position outside scripts: method, HTTP version, separator,
 * in-place variable, file markers, tags, header names and values.
 * Returns { title, doc, anchor, start, end } or undefined.
 */
function helpAt(lines, line, character) {
  const text = lines[line] || '';
  const within = (start, end) => character >= start && character <= end;
  const help = (title, doc, anchor, start, end) => (within(start, end) ? { title, doc, anchor, start, end } : undefined);
  let mm;

  if ((mm = text.match(/^###/))) {
    return help('Request separator', 'Starts a new request. Text after `###` is its title.', 'separators-and-titles', 0, text.length);
  }
  if ((mm = text.match(/^(\s*(?:#|\/\/)\s*@)([\w-]+)/))) {
    const tag = TAGS.find(([name]) => name === mm[2]);
    return tag && help(`\`${tag[1]}\``, tag[2], '4-tags', mm[1].length, mm[0].length);
  }
  if ((mm = text.match(/^@([\w.-]+)\s*=/))) {
    return help(`In-place variable \`${mm[1]}\``, 'Usable as `{{' + mm[1] + '}}` in all requests of this file.', 'in-place-variables', 0, mm[1].length + 1);
  }
  if ((mm = text.match(/^\s*(>>!|>>|<@|<|>)(?=\s)/))) {
    const marker = {
      '<': ['Pre-request script, or body from a file', '`< {% … %}` / `< ./script.js` before the request line runs a script; in the body, `< ./file` inserts the file as is.', 'body-from-a-file'],
      '<@': ['Body from a file with variables', 'Inserts the file and replaces `{{variables}}` in it.', 'body-from-a-file'],
      '>': ['Response handler', '`> {% … %}` or `> ./handler.js` runs after the response arrived.', 'response-handlers'],
      '>>': ['Save the response body', 'Saves the body; an existing file is kept and `-1`, `-2`, … is added.', 'saving-the-response-body'],
      '>>!': ['Save the response body (overwrite)', 'Saves the body and overwrites an existing file.', 'saving-the-response-body']
    }[mm[1]];
    const start = text.indexOf(mm[1]);
    return help(marker[0], marker[1], marker[2], start, start + mm[1].length);
  }

  const ctx = contextAt(lines, line, 0);
  if (ctx.kind === 'requestStart') {
    // The request line: method and HTTP version
    if ((mm = text.match(/^([A-Za-z]+)\s/)) && METHOD_DOCS[mm[1].toUpperCase()]) {
      const found = help(`\`${mm[1].toUpperCase()}\` (HTTP method)`, METHOD_DOCS[mm[1].toUpperCase()], 'request-line', 0, mm[1].length);
      if (found) return found;
    }
    if ((mm = text.match(/\s(HTTP\/[\d.]+)\s*$/i))) {
      const start = mm.index + 1;
      return help(`\`${mm[1]}\``, HTTP_VERSION_DOC, 'request-line', start, start + mm[1].length);
    }
    return undefined;
  }
  const header = text.match(/^([^:\s][^:]*?)\s*:\s?(.*)$/);
  if (header && contextAt(lines, line, header[1].length).kind === 'headerName') {
    const info = HEADERS.find(([name]) => name.toLowerCase() === header[1].toLowerCase());
    if (info && within(0, header[1].length)) return help(`\`${info[0]}\` (header)`, info[1], 'headers', 0, header[1].length);
    const docs = HEADER_VALUE_DOCS[header[1].toLowerCase()] || {};
    const start = text.length - header[2].length;
    for (const [value, [doc, anchor]] of Object.entries(docs)) {
      if (header[2].toLowerCase().startsWith(value.trim().toLowerCase())) {
        return help(`\`${value.trim()}\``, doc, anchor, start, text.length);
      }
    }
  }
  return undefined;
}

module.exports = {
  METHODS, METHOD_DOCS, TAGS, HTTP_VERSIONS, HTTP_VERSION_DOC, HEADERS, HEADER_VALUES, HEADER_VALUE_DOCS,
  docsUrl, contextAt, scriptCompletions, scriptEntryAt, membersOf, helpAt
};
