# Changelog

All notable changes to this extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] – 2026-10-16

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
