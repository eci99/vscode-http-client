# HTTP-Client (IntelliJ style) – Documentation

This is the complete reference for the extension. The [README](../README.md) gives a short
overview; this page describes every feature in detail.

**Contents**

1. [Getting started](#1-getting-started)
2. [Request syntax](#2-request-syntax)
3. [Request body](#3-request-body)
4. [Tags](#4-tags)
5. [Variables](#5-variables)
6. [Environments](#6-environments)
7. [Scripts](#7-scripts)
8. [Script API reference](#8-script-api-reference)
9. [Cookies](#9-cookies)
10. [Running requests](#10-running-requests)
11. [The response tab](#11-the-response-tab)
12. [Editor support](#12-editor-support)
13. [Commands, shortcuts and settings](#13-commands-shortcuts-and-settings)
14. [Differences from the IntelliJ HTTP Client](#14-differences-from-the-intellij-http-client)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Getting started

> The [examples](../examples) folder contains ready-to-run `.http` files and environment files
> for every feature described here.

Files with the extension `.http` or `.rest` open in the language mode **HTTP-Client Request**.
A file contains one or more requests, separated by lines that start with `###`.

```http
### Get a post
GET https://jsonplaceholder.typicode.com/posts/1
Accept: application/json
```

Click **▶ Send Request** above the request line or press `Ctrl+Alt+R` (macOS: `Cmd+Alt+R`)
with the cursor inside the request. The response opens in the tab *HTTP-Client: response*
beside the editor.

At the top of every file there are two more CodeLens links: **▶▶ Run all requests** and
**Environment: …**, which selects the [environment](#6-environments).

## 2. Request syntax

A request consists of these parts, in this order. Everything except the request line is
optional.

```http
### Title                              ← separator, title optional
# @name createUser                     ← tags and comments
@base = https://api.example.com        ← in-place variables
< {% request.variables.set("id", $uuid) %}   ← pre-request script
POST {{base}}/users HTTP/1.1           ← request line
Content-Type: application/json         ← headers

{"id": "{{id}}"}                       ← body, after an empty line

> {% client.test("created", () => client.assert(response.status === 201)) %}   ← response handler
>> ./out/user.json                     ← save the response body
```

### Separators and titles

`###` starts a new request. Text after it is the request's title, shown in the response tab and
in **Pick and Send Request…**, the *Outline* view, the breadcrumbs and *Go to Symbol in Editor*
(`Ctrl+Shift+O`). Requests before the first `###` are allowed.

### Comments

Lines that start with `#` or `//` are comments – in the part before the request line, between
headers and between response handlers. In the body, they are sent as part of the body.

### Request line

```
METHOD URL [HTTP-VERSION]
```

* **Methods:** `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, `TRACE`, `CONNECT` and
  `GRAPHQL` (see [GraphQL](#graphql)). Lowercase is accepted.
* **Short form:** without a method, the request is a `GET`: `https://example.com/status`.
* **URL without scheme:** `example.com/api` is sent as `http://example.com/api`.
* **Path only:** `/api/users` together with a `Host:` header is sent to `http://<host>/api/users`.
* **HTTP version:** `HTTP/1.1` or `HTTP/2` may follow the URL. It is accepted for compatibility;
  requests are always sent with Node's `fetch`, i.e. HTTP/1.1.

### Long URLs on several lines

Lines after the request line that are indented and start with `?`, `&`, `/` or `#` continue the
URL:

```http
GET https://example.com/api
    /users
    ?page=2
    &size={{pageSize}}
```

### Query encoding

Before sending, characters in the query that are not allowed there are percent-encoded – for
example space, `@`, `#`, `$`, `[`, `]` and non-ASCII characters. Existing `%XX` escapes are kept,
so already encoded URLs are not encoded twice. `#` in the query is data (`%23`), not the start of
a fragment.

```http
GET https://example.com/search?name=@john doe&raw=%40
# is sent as https://example.com/search?name=%40john%20doe&raw=%40
```

Add [`# @no-auto-encoding`](#4-tags) to send the query exactly as written.

### Headers

Headers follow the request line, one per line, as `Name: value`. They end at the first empty
line. Values may contain variables.

The headers `Host`, `Content-Length`, `Connection`, `Transfer-Encoding` and `Keep-Alive` are
computed by the HTTP stack and not sent as written.

#### Basic authentication

`Authorization: Basic <user> <password>` – user and password separated by a space – is encoded
automatically to `Basic <base64(user:password)>`. A value that is already Base64-encoded (one
token after `Basic`) is sent unchanged.

```http
GET https://example.com/private
Authorization: Basic {{username}} {{password}}
```

## 3. Request body

The body starts after the first empty line following the headers and ends at the next response
handler (`>`), response file (`>>`) or `###`. Trailing empty lines are removed.

A body in a `GET` or `HEAD` request is not sent; the response tab shows a note.

### Body from a file

| Line | Effect |
| --- | --- |
| `< ./payload.json` | Inserts the file as is (also binary files). |
| `<@ ./payload.json` | Inserts the file and replaces `{{variables}}` in it. |

Paths are relative to the `.http` file and may contain variables. They can be combined with text:

```http
POST https://example.com/import
Content-Type: application/json

< ./data/users.json
```

### Form data

```http
POST https://example.com/login
Content-Type: application/x-www-form-urlencoded

user={{user}}&password={{password}}
```

Escape `%`, `&`, `=` and `+` inside values yourself (`%25`, `%26`, `%3D`, `%2B`).

### Multipart

With `Content-Type: multipart/form-data`, the body lines are joined with `CRLF`, as multipart
requires. File parts use `<`:

```http
POST https://example.com/upload
Content-Type: multipart/form-data; boundary=WebAppBoundary

--WebAppBoundary
Content-Disposition: form-data; name="description"

Holiday photo
--WebAppBoundary
Content-Disposition: form-data; name="file"; filename="photo.jpg"
Content-Type: image/jpeg

< ./photo.jpg
--WebAppBoundary--
```

### GraphQL

The method `GRAPHQL` sends a `POST` with a JSON body `{"query": …, "variables": …}`. If the last
block of the body (after an empty line) is valid JSON, it becomes `variables`; the rest is the
query. `Content-Type: application/json` is added unless the request sets one.

```http
GRAPHQL https://example.com/graphql

query User($id: ID!) {
  user(id: $id) { name email }
}

{"id": "{{userId}}"}
```

### Saving the response body

| Line | Effect |
| --- | --- |
| `>> ./out/result.json` | Saves the body. If the file exists, `-1`, `-2`, … is added before the extension. |
| `>>! ./out/result.json` | Saves the body and overwrites an existing file. |

Directories are created as needed. Paths are relative to the `.http` file and may contain
variables, e.g. `>>! {{$projectRoot}}/out/result.json`. The response tab shows where the body was
saved.

## 4. Tags

Tags are comment lines (`#` or `//`) before the request line.

| Tag | Effect |
| --- | --- |
| `# @name login` or `# @name = login` | Names the request. The name is shown in the response tab and in **Pick and Send Request…**. |
| `# @no-redirect` | Does not follow redirects; the 3xx response itself is shown. Default: setting `httpClient.followRedirects`. |
| `# @no-cookie-jar` | Neither sends stored cookies nor stores cookies from the response. |
| `# @no-log` | Does not write the request to the *HTTP-Client* output channel; the output of its scripts is still written. |
| `# @no-auto-encoding` | Sends the query as written, without [encoding](#query-encoding). |
| `# @timeout 30` | Timeout for the whole request. Default: setting `httpClient.timeoutSeconds`. |
| `# @connection-timeout 2 m` | Maximum time until the response headers arrive. |

Durations are a number of seconds, optionally with a unit, with or without a space: `500 ms`,
`30 s`, `30s`, `2 m`.

```http
### Slow export
# @name export
# @timeout 5 m
# @no-redirect
GET https://example.com/export
```

## 5. Variables

Variables are written as `{{name}}` and can be used in the URL, headers, body, file paths and in
files included with `<@`. Names may contain letters, digits, `_`, `-` and `.`.

An unresolved variable stays in the request as `{{name}}`; the response tab lists it under
*⚠ Unresolved variables*.

### Kinds of variables

| Kind | Defined | Scope | In scripts |
| --- | --- | --- | --- |
| Environment | `http-client.env.json`, `http-client.private.env.json` | all files using the environment | `request.environment.get()`, `client.variables.environment` |
| Global | `client.global.set()` in a script | all files of the workspace, kept until cleared | `client.global`, `client.variables.global` |
| In-place | `@name = value` in the `.http` file | this file | `client.variables.file` |
| Request | `request.variables.set()` in a pre-request script | the following request | `request.variables`, `client.variables.request` |
| Dynamic | built in | everywhere | without braces, e.g. `$uuid` |

### Precedence

If the same name is defined more than once, the first of these wins (as documented for the
IntelliJ HTTP Client):

1. environment
2. global (`client.global`)
3. in-place (`@name = value`)
4. request (`request.variables`)

### In-place variables

```http
@host = localhost:8080
@base = http://{{host}}/api

### Users
GET {{base}}/users
```

In-place variables can be anywhere before a request line and apply to the whole file. Their
values may refer to other variables; references are resolved when the request is sent.

### Dynamic variables

| Variable | Value |
| --- | --- |
| `{{$uuid}}`, `{{$random.uuid}}` | random UUID v4 |
| `{{$timestamp}}` | current UNIX timestamp in seconds |
| `{{$isoTimestamp}}` | current time as ISO-8601 (UTC) |
| `{{$randomInt}}` | random integer 0–999 |
| `{{$random.integer(from, to)}}` | random integer in [from, to); default 0–1000 |
| `{{$random.float(from, to)}}` | random float in [from, to); default 0–1000 |
| `{{$random.alphabetic(length)}}` | random letters (default 10) |
| `{{$random.alphanumeric(length)}}` | random letters and digits (default 10) |
| `{{$random.hexadecimal(length)}}` | random hex string (default 10) |
| `{{$random.email}}` | random e-mail address |
| `{{$env.NAME}}` | environment variable `NAME` of the operating system |
| `{{$projectRoot}}` | workspace folder of the `.http` file |

Every occurrence gets a new value. In scripts, use them without braces:
`$uuid`, `$timestamp`, `$isoTimestamp`, `$randomInt`, `$random.integer(1, 10)`, `$env.USER`.

## 6. Environments

### Files

Environments are defined in two JSON files:

* `http-client.env.json` – shared values, meant to be committed.
* `http-client.private.env.json` – secrets such as passwords and tokens; keep it out of version
  control (add it to `.gitignore`).

Both files are searched in the directory of the `.http` file and then upward to the workspace
root; the first directory that contains either file is used. **HTTP-Client: Create Environment
File** creates both files next to the active `.http` file.

```json
{
  "$shared": { "user": "janos" },
  "dev":  { "host": "localhost:8080" },
  "prod": { "host": "api.example.com" }
}
```

```json
{
  "dev":  { "password": "secret" },
  "prod": { "password": "…" }
}
```

The values of an environment are merged in this order (later wins): `$shared` of the public file,
`$shared` of the private file, the environment of the public file, the environment of the
private file.

### Selecting an environment

* Click the environment in the status bar (visible in `.http` files), the **Environment: …**
  CodeLens at the top of the file, or press `Ctrl+Alt+Shift+E`.
* The selection is stored per workspace and applies to all `.http` files in it.
* *&lt;no environment&gt;* runs requests without environment variables; `$shared` still applies.
* If the selected environment does not exist for a file, the request runs without one. The
  response tab says so (`// Environment: dev (not found – none used)`).

Changes to the environment files take effect immediately.

## 7. Scripts

Scripts are JavaScript. They run in a sandbox with the API described in the
[next section](#8-script-api-reference); Node modules (`require`) are not available. A script
may run at most 5 seconds.

### Pre-request scripts

A pre-request script runs before the request is built. It is written before the request line,
inline with `< {% … %}` or from a file with `< ./script.js`:

```http
< {%
  const ts = Date.now().toString();
  request.variables.set("ts", ts);
  request.variables.set("signature", crypto.hmac.sha256()
    .withTextSecret(request.environment.get("secret"))
    .updateWithText(ts)
    .digest().toHex());
%}
GET https://example.com/api
X-Timestamp: {{ts}}
X-Signature: {{signature}}
```

If a pre-request script throws, the request is not sent and the error is shown.

### Response handlers

A response handler runs after the response arrived. It is written after the body, inline with
`> {% … %}` or from a file with `> ./handler.js`:

```http
POST https://example.com/login
Content-Type: application/json

{"user": "{{user}}", "password": "{{password}}"}

> {%
  client.test("Login successful", () => {
    client.assert(response.status === 200, "status " + response.status);
    client.assert(response.body.token, "no token");
  });
  client.global.set("token", response.body.token);
%}
```

A request may have several pre-request scripts and response handlers; they run in order. If a
response handler throws, this is reported as a failed test named *Response handler*.

### Tests

`client.test(name, fn)` runs `fn` and records the result: the test fails if `fn` throws, for
example through `client.assert(condition, message)`. Results are shown in the response tab and in
the output channel:

```
// Tests: 1/2 passed
//   ✓ Login successful
//   ✗ Has role: expected admin
```

### Output

`client.log(…)` and `console.log/info/warn/error/debug(…)` write to the response tab and the
*HTTP-Client* output channel. Objects are written as JSON.

### Passing values between requests

```http
### Login
POST {{base}}/login
Content-Type: application/json

{"user": "{{user}}", "password": "{{password}}"}

> {% client.global.set("token", response.body.token); %}

### Profile – uses the token from the login
GET {{base}}/me
Authorization: Bearer {{token}}
```

Global variables are stored per workspace and survive a restart of VS Code. **HTTP-Client: Show
Global Variables** writes them to the output channel, **Clear Global Variables** removes them.

## 8. Script API reference

`response` exists only in response handlers. Everything else is available in both kinds of
scripts.

### `client`

| Member | Description |
| --- | --- |
| `client.test(name, fn)` | Runs `fn` as a named test. |
| `client.assert(condition, message?)` | Throws `message` (default *Assertion failed*) if `condition` is falsy. |
| `client.log(...values)` | Writes to the output. |
| `client.exit()` | Ends the script immediately. |
| `client.global` | Global variables, see below. |
| `client.variables` | Access to all variable scopes, see below. |

### `client.global`

| Member | Description |
| --- | --- |
| `set(name, value)` | Sets a global variable, usable as `{{name}}` in later requests. Objects are stored as JSON. |
| `get(name)` | Value of the variable, or `null`. |
| `isEmpty()` | `true` if no global variable is set. |
| `clear(name)` | Removes the variable. |
| `clearAll()` | Removes all global variables. |
| `headers.set(name, value)` | Adds the header to all following requests – in a pre-request script also to the current one. A request that sets the header itself keeps its own value. `null` as value removes it. |
| `headers.clear(name)` | Removes the global header. |

Global headers are kept in memory until VS Code is closed or **Clear Global Variables** is run.

### `client.variables`

| Member | Description |
| --- | --- |
| `client.variables.global` | Same as `client.global`: `get`, `set`, `isEmpty`, `clear`, `clearAll`. |
| `client.variables.file` | In-place variables of the file: `get(name)`. |
| `client.variables.request` | Same as `request.variables`: `get`, `set`. |
| `client.variables.environment` | Same as `request.environment`: `get(name)`. |

### `request`

| Member | Description |
| --- | --- |
| `request.method` | HTTP method, e.g. `POST`. |
| `request.url.getRaw()` | URL as written, variables unresolved. |
| `request.url.tryGetSubstituted()` | URL with variables resolved. |
| `request.url()` | Same as `tryGetSubstituted()` (the form used in IntelliJ response handlers). |
| `request.body.getRaw()` / `.tryGetSubstituted()` / `request.body()` | The body, likewise. |
| `request.headers.all()` | All request headers as `RequestHeader` objects. |
| `request.headers.findByName(name)` | The first header with this name (case-insensitive), or `null`. |
| `request.variables.set(name, value)` | Sets a variable for this request. |
| `request.variables.get(name)` | Value of a request variable, or `null`. |
| `request.environment.get(name)` | Value of an environment variable, or `null`. |
| `request.environmentName` | Name of the selected environment, or `null`. |

A `RequestHeader` has `name`, `getRawValue()` (variables unresolved), `tryGetSubstitutedValue()`
and `value()` (both with variables resolved).

### `response`

| Member | Description |
| --- | --- |
| `response.status` | Status code, e.g. `200`. |
| `response.body` | The body: an object for JSON responses (`application/json`, `*+json`), otherwise a string. |
| `response.headers.valueOf(name)` | First value of the header (case-insensitive), or `null`. |
| `response.headers.valuesOf(name)` | All values of the header; an empty array if there is none. |
| `response.contentType.mimeType` | e.g. `application/json`, or `null`. |
| `response.contentType.charset` | e.g. `utf-8`, or `null`. |
| `response.cookies()` | All cookies from `Set-Cookie` headers, including those of redirect responses. |
| `response.cookiesByName(name)` | The cookies with this name. |

A cookie has `name` and `value`, and – if the server sent them – `domain`, `path`, `expires`,
`maxAge`, `secure`, `httpOnly` and `sameSite`.

```js
> {%
  const session = response.cookiesByName("session")[0];
  client.test("session cookie is HttpOnly", () => client.assert(session && session.httpOnly));
%}
```

### `jsonPath(value, path)`

Reads a value from an object or JSON string. Supported: `$.a.b`, `$.items[0]`, `$['key with
space']`. Returns `undefined` if the path does not exist.

```js
const id = jsonPath(response.body, "$.items[0].id");
```

### `crypto`

Hashes: `crypto.md5()`, `sha1()`, `sha256()`, `sha384()`, `sha512()`, `sha3(bits)` with `bits`
`'224'`, `'256'`, `'384'` or `'512'`.
HMACs: `crypto.hmac.md5()`, `sha1()`, `sha256()`, `sha384()`, `sha512()`, `sha3(bits)`.

Builder methods (chainable):

| Method | Description |
| --- | --- |
| `updateWithText(text, encoding?)` | Adds text (UTF-8 by default). |
| `updateWithHex(hex)` | Adds bytes given as hex. |
| `updateWithBase64(base64, urlSafe?)` | Adds bytes given as Base64. |
| `withTextSecret(text)` | HMAC only: the key as text. |
| `withHexSecret(hex)` | HMAC only: the key as hex. |
| `withBase64Secret(base64, urlSafe?)` | HMAC only: the key as Base64. |
| `digest()` | Computes the result; then `.toHex()`, `.toBase64(urlSafe?)` or `.bytes()`. |

```js
const hash = crypto.sha256().updateWithText(request.body.tryGetSubstituted()).digest().toHex();
const sig = crypto.hmac.sha3('512').withTextSecret("key").updateWithText("message").digest().toBase64(true);
```

### `jwt`

| Method | Description |
| --- | --- |
| `jwt.sign(payload, key, options?)` | Creates a signed token. |
| `jwt.verify(token, key, options?)` | Checks the token and returns its payload; throws if it is invalid. |
| `jwt.decode(token)` | Returns `{ header, payload, signature }` without checking anything. |

Algorithms: `HS256`, `HS384`, `HS512` (key: secret string), `RS256/384/512`, `PS256/384/512`,
`ES256/384/512` (key: PEM string – private key for `sign`, public key for `verify`).

Options of `sign`: `algorithm` (default `HS256`), `expiresIn` and `notBefore` (seconds, or
`"30s"`, `"10m"`, `"1h"`, `"2d"`), `issuer`, `subject`, `audience`, `jwtid`, `keyid`, `header`,
`noTimestamp` (by default `iat` is set).

`verify` always checks the signature and `exp` / `nbf`. Optionally it checks `algorithm` (or
`algorithms`), `issuer`, `subject` and `audience`.

```http
< {%
  const token = jwt.sign({ sub: "janos", role: "admin" }, request.environment.get("jwtSecret"), {
    algorithm: "HS256", expiresIn: "15m", audience: "api"
  });
  request.variables.set("jwt", token);
%}
GET https://example.com/admin
Authorization: Bearer {{jwt}}
```

### Other globals

| Name | Description |
| --- | --- |
| `$random` | `uuid`, `integer(from?, to?)`, `float(from?, to?)`, `alphabetic(n?)`, `alphanumeric(n?)`, `hexadecimal(n?)`, `email` |
| `$uuid`, `$timestamp`, `$isoTimestamp`, `$randomInt` | Dynamic values, new on every access. |
| `$env` | Environment variables of the operating system, e.g. `$env.HOME`. |
| `btoa(text)`, `atob(base64)` | Base64 encoding and decoding; also as `Window.btoa` / `Window.atob`. |
| `URLSearchParams` | Builds and parses query strings. |
| `Buffer` | Node's `Buffer`. |
| `console` | `log`, `info`, `warn`, `error`, `debug`. |

## 9. Cookies

Cookies from `Set-Cookie` headers are stored in a cookie jar and sent with later requests to the
same domain and path, respecting `Domain`, `Path`, `Max-Age` and `Expires`. The jar is stored per
workspace and survives a restart.

* Cookies set by a redirect response are stored too, and sent to the redirect target.
* A `Cookie:` header in the request replaces the cookies from the jar.
* `# @no-cookie-jar` excludes a request from the jar.
* **HTTP-Client: Clear Cookies** empties the jar.

## 10. Running requests

| Action | How |
| --- | --- |
| Send the request at the cursor | **▶ Send Request** CodeLens, editor context menu, `Ctrl+Alt+R` |
| Run all requests of the file | **▶▶ Run all requests** CodeLens, the run icon in the editor title, `Ctrl+Alt+Shift+R` |
| Resend the last request | `Ctrl+Alt+Shift+L`, from any editor |
| Pick and send a request | `Ctrl+Alt+Shift+V`, from any editor |
| Copy as cURL | editor context menu, **HTTP-Client: Copy Request as cURL** |

* Before sending, all modified files are saved (setting `httpClient.saveAllBeforeRequest`).
* **Run all** sends the requests one after another, so values set by one request are available
  to the next.
* **Resend** repeats the last single request or the last *run all*. The file is read again, so
  edits are picked up. The last request is remembered per workspace, also after a restart.
* **Pick and send** lists the requests of the active `.http` file – or, if none is active, of
  the file of the last request – with name or title, method and URL. The last sent request is
  marked.
* **Redirects** are followed up to 20 times (unless `# @no-redirect`). After `303`, and after
  `301`/`302` for a `POST`, the request continues as `GET` without a body. The `Authorization`
  header is not sent to another origin. The response tab shows the final response.
* **Copy as cURL** copies the request with variables resolved. Pre-request scripts are not run
  for it.

The *HTTP-Client* output channel logs every request with time, method, URL, status and duration,
followed by script output and test results (`# @no-log` leaves out the request line).

## 11. The response tab

All requests share one tab, *HTTP-Client: response*. It opens beside the editor (setting
`httpClient.responseViewColumn`), stays in its editor group and is updated in place. It is only
brought to the front when a request fails or returns a status of 400 or higher.

Each response looks like this; responses of *run all* are separated by `###`:

```
// Login
// POST https://example.com/login
// Environment: dev
// Tests: 1/1 passed
//   ✓ Login successful
// Response code: 200 (OK); Time: 87 ms; Content length: 64 B

HTTP/1.1 200 OK
content-type: application/json
…

{
  "token": "…"
}
```

JSON bodies are pretty-printed (setting `httpClient.prettyPrintJson`). Binary bodies are shown as
`<binary content, 12.3 KB>`.

Above every response:

* **Open in viewer** opens the body in VS Code: pretty-printed JSON, text, images and PDFs.
  Other binary content opens in the default application. The viewer always uses the same file,
  so its tab is reused and – while it is open – shows the last response after every run. If the
  content type changes (e.g. from an image to JSON), the tab is replaced.
* **Open in browser** (HTML responses only) opens the body in the default browser.
* **Save as…** saves the body to a file of your choice.

## 12. Editor support

### Syntax highlighting

Request lines, headers, variables, comments, tags and file references are highlighted. Scripts
are highlighted as JavaScript, bodies as JSON or XML depending on their content.

### IntelliSense

Completion (`Ctrl+Space`) depends on where the cursor is:

| Position | Suggestions |
| --- | --- |
| Start of a request | HTTP methods |
| After the URL | `HTTP/1.1`, `HTTP/2` |
| After `# @` | tags, with description |
| Header name | common headers; after choosing one, its typical values are suggested right away |
| Header value | values for `Content-Type`, `Accept`, `Authorization`, `Accept-Encoding`, `Cache-Control`, `Connection`, … |
| Inside `{{` | environment, in-place and global variables, dynamic variables |
| After `<`, `<@`, `>`, `>>` | file paths relative to the `.http` file (after `>` only `.js` files) |
| In scripts | the [script API](#8-script-api-reference), including chains like `crypto.hmac.sha256().withTextSecret(k).` |
| In `client.global.get("…")` | names of global variables |
| In `request.environment.get("…")` | names of environment variables |

Methods of the script API are inserted as snippets with their arguments. Every suggestion has a
description (`Ctrl+Space` again, or the arrow next to it, shows it) and a **📖 Documentation**
link to the matching section of this page. Suggestions for variables show their current value.

### Hovers

* `{{variable}}` – its value and where it comes from (environment, global, file, request), or
  *unresolved*; dynamic variables are explained.
* Script API – signature and description.
* HTTP method and version on the request line, `###`, `@name =` (in-place variables), tags,
  header names, values such as `Basic` or `multipart/form-data`, and the markers `<`, `<@`,
  `>`, `>>`, `>>!` – what they do.

Every hover ends with a **📖 Documentation** link to the matching section of this page.

### Help

**HTTP-Client: Open Documentation** (Command Palette, or the context menu in `.http` files)
opens this documentation inside VS Code.

### File references

Paths after `<`, `<@`, `>` and `>>` are links that open the file. A body file or script that does
not exist is marked as an error (`File not found: …`). Files written with `>>` / `>>!` do not
have to exist. Paths that contain a variable are not checked.

When a referenced file, a `.http` file or a folder containing them is moved or renamed in VS Code
(Explorer, drag and drop), the paths are updated so that they still lead to the same files. A path
keeps its form: absolute paths stay absolute, and a leading `./` is kept where it still fits. By
default VS Code asks first; `httpClient.updatePathsOnFileMove` (`prompt`, `always`, `never`)
changes that. Moves outside VS Code, for example with `git mv`, are not noticed.

### Snippets

| Prefix | Inserts |
| --- | --- |
| `gtr` | GET request |
| `gtrp` | GET request with query parameters |
| `ptr` | POST request with JSON body |
| `ptrp` | POST request with form parameters |
| `mptr` | multipart POST |
| `fptr` | multipart file upload |
| `rh` | response handler with a test |
| `prs` | pre-request script |
| `gqlr` | GraphQL request |

## 13. Commands, shortcuts and settings

### Commands

All commands are in the Command Palette under **HTTP-Client**.

| Command | Shortcut (macOS: `Cmd` instead of `Ctrl`) |
| --- | --- |
| Send Request | `Ctrl+Alt+R` (in `.http` files) |
| Run All Requests in File | `Ctrl+Alt+Shift+R` (in `.http` files) |
| Resend Last Request | `Ctrl+Alt+Shift+L` |
| Pick and Send Request… | `Ctrl+Alt+Shift+V` |
| Select Environment | `Ctrl+Alt+Shift+E` |
| Copy Request as cURL | – |
| Create Environment File | – |
| Show Global Variables | – |
| Clear Global Variables | – |
| Clear Cookies | – |
| Open Documentation | – |

Shortcuts can be changed in *Preferences: Open Keyboard Shortcuts*.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `httpClient.saveAllBeforeRequest` | `true` | Save all modified files before a request is sent (untitled files are not saved). |
| `httpClient.timeoutSeconds` | `60` | Default request timeout; per request `# @timeout`. |
| `httpClient.followRedirects` | `true` | Follow redirects; per request `# @no-redirect`. |
| `httpClient.responseViewColumn` | `beside` | Show the response `beside` the editor or in the `active` column. |
| `httpClient.updatePathsOnFileMove` | `prompt` | Update the paths after `<`, `<@`, `>` and `>>` when files or folders are moved or renamed: `prompt`, `always` or `never`. |
| `httpClient.prettyPrintJson` | `true` | Pretty-print JSON responses. |

## 14. Differences from the IntelliJ HTTP Client

Supported with limitations:

* **HTTP version:** `HTTP/2` is accepted but requests are sent with HTTP/1.1.
* **`@connection-timeout`:** limits the time until the response headers arrive, not only the
  connection setup.
* **`@no-log`:** there is no request history; the tag keeps the request out of the output
  channel.
* **Global headers** last until VS Code is closed; global variables and cookies are stored per
  workspace.
* **`jwt`:** keys are strings or PEM, not `CryptoKey` objects.

Not supported:

* WebSocket and gRPC requests, `import` / `run`, shared scripts `={% %}`
* Collections in variables (`{{users[*].name}}`), `request.iteration()`, `request.templateValue()`
* `Authorization: Digest`, OAuth 2.0 (`{{$auth.token(…)}}`)
* `crypto.subtle`, DOM/XML response bodies (`DOMParser`), streaming responses (`onEachLine`,
  `onEachMessage`)
* `exec`, `execSync` and other shell commands, `sleep`, `setTimeout`
* Faker variables such as `$random.address`, `$exampleServer`, `$historyFolder`
* Request history in `.idea/httpRequests`

## 15. Troubleshooting

**`.http` files open in another language mode.** Other extensions such as *REST Client* or
*httpYac* also claim `.http`. Disable them or choose **HTTP-Client Request** as language mode
(click the language in the status bar).

**A variable is not replaced.** Hover over it to see whether and where it is defined. Check the
selected environment in the status bar and the [precedence](#precedence). The response tab lists
unresolved variables.

**The environment is not found.** The environment files must be in the directory of the `.http`
file or a parent directory inside the workspace. The response tab shows which environment was
used.

**The request times out.** Increase `httpClient.timeoutSeconds` or add `# @timeout 5 m` to the
request.

**A script fails.** The error is shown in the response tab: for pre-request scripts as request
error, for response handlers as failed test *Response handler*. `client.log()` helps to inspect
values.

**Special characters in the query arrive differently than written.** The query is
[percent-encoded](#query-encoding). Use `# @no-auto-encoding` to send it unchanged.
