# HTTP-Client (IntelliJ style)

Runs `.http` / `.rest` files with the syntax of the **IntelliJ HTTP Client**, so existing
request files from IntelliJ/WebStorm/PhpStorm work unchanged in VS Code: environments,
`{{variables}}`, pre-request and response handler scripts, `client.test` / `client.assert`,
cookies and GraphQL.

## Quick start

1. Open or create a `.http` file.
2. Click **▶ Send Request** above a request (or press `Ctrl+Alt+R`).
3. The response opens beside the editor, together with test results, script logs and the
   environment that was used.

## Response tab

All requests share one tab, *HTTP-Client: response*. It stays in the editor group where it is
and is updated in place; it is only brought to the front when a request fails or returns a
status of 400 or higher.

Above every response:

* **Open in viewer** opens the body in VS Code (pretty-printed JSON, images, PDFs); other binary
  content opens in the default application.
* **Open in browser** (HTML responses only).
* **Save as…** saves the body to a file.

## File references

After `<`, `<@`, `>` and `>>`, file paths are completed relative to the `.http` file (for
response handlers `>` only `.js` files are offered). Referenced files are clickable links, and a
body file or script that does not exist is marked as an error. Paths that contain a
`{{variable}}` are not checked.

```http
@user = janos

### Login
POST https://{{host}}/login
Content-Type: application/json

{"user": "{{user}}", "password": "{{password}}"}

> {%
  client.test("Login OK", () => client.assert(response.status === 200, "status " + response.status));
  client.global.set("token", response.body.token);
%}

### Profile
GET https://{{host}}/me
Authorization: Bearer {{token}}
```

## Keyboard shortcuts

| Shortcut (macOS: `Cmd` instead of `Ctrl`) | Command | Where |
| --- | --- | --- |
| `Ctrl+Alt+R` | Send the request at the cursor | `.http` files |
| `Ctrl+Alt+Shift+R` | Run all requests in the file | `.http` files |
| `Ctrl+Alt+Shift+L` | **Resend last request** | everywhere |
| `Ctrl+Alt+Shift+V` | **Pick and send** another request of the current / last-used file | everywhere |
| `Ctrl+Alt+Shift+E` | **Select environment** | everywhere |

The global shortcuts work from any editor, e.g. while you are editing the code that serves
the request. All shortcuts can be changed in *Preferences: Open Keyboard Shortcuts*.

* **Resend** repeats the last single request or the last “run all”. The file is re-read, so
  edits are picked up. The last request is remembered per workspace, also after a restart.
* **Pick and send** lists all requests of the active `.http` file – or, if none is active, of
  the file of the last request. The last sent request is marked; the picked one becomes the
  new “last request”.

## Commands

All commands are in the Command Palette under **HTTP-Client**:
*Send Request*, *Run All Requests in File*, *Resend Last Request*, *Pick and Send Request…*,
*Select Environment*, *Copy Request as cURL*, *Create Environment File*,
*Show Global Variables*, *Clear Global Variables*, *Clear Cookies*.

## Environments

Environments are read from `http-client.env.json` and `http-client.private.env.json`
(searched upward from the `.http` file to the workspace root). Values in `$shared` apply to
all environments; the private file overrides the public one.

```json
{
  "$shared": { "user": "janos" },
  "dev":  { "host": "localhost:8080" },
  "prod": { "host": "api.example.com" }
}
```

* Select the environment via the status bar (in `.http` files) or `Ctrl+Alt+Shift+E`.
* The selection is remembered **per workspace** and applies to all `.http` files in it.
* Every response shows the environment it was run with (`// Environment: dev`). If the
  selected environment does not exist for a file, the request runs without one and the
  response says so.
* Keep `http-client.private.env.json` out of version control.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `httpClient.saveAllBeforeRequest` | `true` | Save all modified files before a request is sent (untitled files are not saved). |
| `httpClient.timeoutSeconds` | `60` | Request timeout; per request `# @timeout 30`. |
| `httpClient.followRedirects` | `true` | Follow redirects; per request `# @no-redirect`. |
| `httpClient.responseViewColumn` | `beside` | Show the response `beside` the editor or in the `active` column. |
| `httpClient.prettyPrintJson` | `true` | Pretty-print JSON responses. |

## Supported IntelliJ features

| IntelliJ feature | Supported |
| --- | --- |
| `###` separators, `# @name`, comments (`#`, `//`) | ✓ |
| `▶ Send Request` per request, *Run all requests* | ✓ CodeLens, context menu, shortcuts |
| `http-client.env.json` + `http-client.private.env.json` (incl. `$shared`) | ✓ |
| `{{variables}}`, in-place variables `@name = value` | ✓ incl. completion and hover |
| Dynamic variables `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$random.integer(a,b)}}`, `{{$random.alphabetic(n)}}`, `{{$random.email}}` … | ✓ |
| Pre-request scripts `< {% … %}` / `< script.js` with `request.variables.set()` | ✓ |
| Response handlers `> {% … %}` / `> handler.js` | ✓ |
| `client.global.set/get/clear/clearAll/isEmpty`, `client.test`, `client.assert`, `client.log`, `client.exit` | ✓ globals persist per workspace |
| `response.status/body/headers.valueOf()/valuesOf()/contentType` | ✓ |
| `jsonPath()`, `$random`, `crypto.sha256()…` / `crypto.hmac.sha256()…` | ✓ |
| Multi-line query (indented `?a=1` / `&b=2` lines) | ✓ |
| Body from file `< ./file`, with variables `<@ ./file` | ✓ |
| Save response `>> file` (adds `-1`, `-2` …) / `>>! file` (overwrite) | ✓ |
| Multipart (`multipart/form-data`) incl. file parts | ✓ |
| `# @no-redirect`, `# @no-cookie-jar`, `# @timeout 30` | ✓ |
| Cookie jar | ✓ in memory + per workspace |
| `GRAPHQL` requests (+ JSON variables block) | ✓ |
| Live templates `gtr`, `gtrp`, `ptr`, `ptrp`, `mptr`, `fptr` | ✓ (+ `rh`, `prs`, `gqlr`) |
| Copy as cURL | ✓ |
| WebSocket / gRPC requests, `run #name`, response history in `.idea` | – |

### Variable precedence

`request.variables` (pre-request script) → in-place file variables → `client.global` → environment.

## Notes

* Uses the language id `http-client`. If *REST Client* (humao) or *httpYac* are installed too,
  they also claim `.http`; disable them or pick **HTTP-Client Request** as language mode.
* Not affiliated with JetBrains. IntelliJ is a trademark of JetBrains s.r.o.

## License

[MIT](LICENSE)
