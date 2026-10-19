# Changelog

All notable changes to this extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.6] – 2026-10-19

### Added

- Moving or renaming a referenced file, a `.http` file or a folder in VS Code updates the paths
  after `<`, `<@`, `>` and `>>`. `httpClient.updatePathsOnFileMove` (`prompt`, `always`, `never`)
  decides whether to ask first.

## [0.1.5] – 2026-10-18

### Added

- [examples/](examples): ready-to-run `.http` files (basics, variables, scripts, authentication,
  files, tags, GraphQL) with public and private environment files, data files and scripts.

### Fixed

- Cookies set by a redirect response are stored in the cookie jar, sent to the redirect target and
  returned by `response.cookies()`. Redirects are now followed by the extension itself (up to 20;
  `303`, and `301`/`302` after `POST`, continue as `GET`; `Authorization` is not sent to another
  origin).

## [0.1.4] – 2026-10-18

### Added

- IntelliSense depending on the cursor position: HTTP methods on the request line, tags after
  `# @`, header names and typical header values (e.g. media types for `Content-Type`), and the
  script API in `< {% %}` / `> {% %}` (`client`, `request`, `response`, `$random`, `crypto`,
  `jsonPath`, `console`) with signatures, snippets and names of global or environment variables
  in `client.global.get("…")` / `request.environment.get("…")`.
- Hover documentation for the script API, header names and tags.
- Features from the IntelliJ HTTP Client documentation:
  - Tags `# @no-log`, `# @no-auto-encoding` and `# @connection-timeout`; `# @name = name`.
  - Query parameters are percent-encoded automatically (space, `@`, `#`, `$` …; existing `%XX`
    escapes are kept), unless the request has `# @no-auto-encoding`.
  - `Authorization: Basic user password` is sent Base64-encoded.
  - `client.global.headers.set/clear`: headers added to all following requests.
  - `client.variables.global/file/request/environment`.
  - `request.url()` / `request.body()` (resolved values, as in response handlers),
    `request.headers.findByName(…)` with `getRawValue()`, `tryGetSubstitutedValue()` and `value()`.
  - `response.cookies()` and `response.cookiesByName(name)`.
  - `jwt.sign/verify/decode`, `crypto.sha3(bits)` / `crypto.hmac.sha3(bits)`, `btoa`/`atob`
    (also `Window.btoa/atob`), `URLSearchParams`, and `$uuid`, `$timestamp`, `$isoTimestamp`,
    `$randomInt`, `$env` in scripts.
  - Dynamic variable `{{$projectRoot}}`.
  - Completion of the HTTP version after the URL.
- Full documentation in [docs/documentation.md](docs/documentation.md), linked from the README.
  Suggestions and hovers link to the matching section; **HTTP-Client: Open Documentation**
  opens it in VS Code. Hovers also explain HTTP methods and versions, `###`, in-place
  variables, header values like `Basic`, the markers `<`, `<@`, `>`, `>>`, `>>!` and dynamic
  variables; variable suggestions show the current value.

### Changed

- Variable precedence follows the IntelliJ HTTP Client documentation: environment →
  `client.global` → in-place variables → `request.variables`. Before, it was the other way round.
- The query is percent-encoded before sending; `#` in the query is data (`%23`), not a fragment.
  Use `# @no-auto-encoding` for the previous behavior.
- Request headers from `request.headers.all()` / `findByName()` have `value()` (a method, as
  documented by JetBrains) instead of a `value` property.

## [0.1.3] – 2026-10-18

### Changed

- **Open in viewer** always writes to the same file instead of a new temporary file per click.
  Its tab is reused and, while it is open, updates to the last response after every run. When the
  content type changes (e.g. from an image to JSON), the tab is replaced.

## [0.1.2] – 2026-10-16

### Changed

- README: demo GIF showing environment selection and sending requests, a simple GET/POST
  example and an author's note.

## [0.1.1] – 2026-10-16

### Added

- Response tab: **Open in viewer** and **Save as…** above every response; **Open in browser**
  for HTML responses. JSON is pretty-printed in the viewer; images and PDFs open in VS Code,
  other binary content in the default application.
- Completion of file paths after `<`, `<@`, `>` and `>>` (only `.js` files for response handlers).
- Referenced files are clickable links; a body file or script that does not exist is reported
  as an error (`File not found: …`). Files written with `>>` / `>>!` do not have to exist yet.
- File icons for `.http`, `.rest` and `.http-response` files.

### Changed

- All requests share one response tab, *HTTP-Client: response*, instead of one tab per `.http` file.
- The response tab stays in its editor group and is not brought to the front for every request,
  only when a request fails or returns a status of 400 or higher.

## [0.1.0] – 2026-10-15

First release.

### Added

- Runs `.http` / `.rest` files written in the syntax of the IntelliJ HTTP Client.
- `▶ Send Request` and `▶▶ Run all requests` as CodeLens and via `Ctrl+Alt+R` /
  `Ctrl+Alt+Shift+R` in `.http` files; also in the editor context menu and title bar.
- **Resend Last Request** (`Ctrl+Alt+Shift+L`, global): repeats the last request or “run all”,
  re-reading the file. The last request is remembered per workspace, also across restarts.
- **Pick and Send Request…** (`Ctrl+Alt+Shift+V`, global): choose another request of the
  current or last-used `.http` file from a list and send it.
- Environments from `http-client.env.json` / `http-client.private.env.json` (incl. `$shared`),
  searched upward from the `.http` file. **Select Environment** via status bar or
  `Ctrl+Alt+Shift+E` (global); the selection is remembered per workspace.
- The response view shows the environment a request was run with.
- `{{variables}}` with completion and hover, in-place variables `@name = value` and dynamic
  variables (`{{$uuid}}`, `{{$timestamp}}`, `{{$random.*}}` …).
- Pre-request scripts and response handlers (inline or as files) with `client.global`,
  `client.test`, `client.assert`, `client.log`, `request.variables` and the `response` object.
- Body from file (`< ./file`, `<@ ./file`), multipart requests, `GRAPHQL` requests.
- Saving responses with `>> file` / `>>! file`.
- `# @no-redirect`, `# @no-cookie-jar`, `# @timeout`; cookie jar persisted per workspace.
- Copy request as cURL, live templates, syntax highlighting for requests and responses.
- All modified files are saved before a request is sent
  (setting `httpClient.saveAllBeforeRequest`, default `true`).
- Settings `httpClient.timeoutSeconds`, `httpClient.followRedirects`,
  `httpClient.responseViewColumn`, `httpClient.prettyPrintJson`.
