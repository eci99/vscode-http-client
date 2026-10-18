# Examples

Example `.http` files for the HTTP-Client (IntelliJ style) extension. They use the public
services [httpbin.org](https://httpbin.org), which echoes requests back, and the
[Countries GraphQL API](https://countries.trevorblades.com).

## Getting started

1. Open this folder (or the repository) in VS Code with the extension installed.
2. Open one of the `.http` files.
3. Select the environment **httpbin** in the status bar or with `Ctrl+Alt+Shift+E`.
4. Click **▶ Send Request** above a request, or **▶▶ Run all requests** at the top of the file.

## Files

| File | Shows |
| --- | --- |
| [01-basics.http](01-basics.http) | Methods, short form, query on several lines, JSON and form bodies, error status, HTML and image responses |
| [02-variables.http](02-variables.http) | Environment, in-place, dynamic, global and request variables, unresolved variables |
| [03-scripts.http](03-scripts.http) | Tests and assertions, headers, request information, HMAC signatures, scripts from files, hashes, global headers, `client.variables` |
| [04-auth.http](04-auth.http) | Basic authentication, bearer token from a login, API key, signed JWT |
| [05-files.http](05-files.http) | Body from files (`<`, `<@`), multipart upload, saving responses (`>>`, `>>!`) |
| [06-tags.http](06-tags.http) | `@name`, `@no-redirect`, cookies and `@no-cookie-jar`, `@timeout`, `@connection-timeout`, `@no-log`, query encoding and `@no-auto-encoding` |
| [07-graphql.http](07-graphql.http) | GraphQL queries with and without variables |

| Environment file | Contents |
| --- | --- |
| [http-client.env.json](http-client.env.json) | Environments `httpbin` and `local`, shared values in `$shared` |
| [http-client.private.env.json](http-client.private.env.json) | Password, API key and secrets per environment |

In a real project, keep `http-client.private.env.json` out of version control. Here it is
committed so that the examples work out of the box; it only contains demo values.

The environment **local** expects httpbin on `http://localhost:8080`, e.g. started with
`docker run -p 8080:80 kennethreitz/httpbin`.

Supporting files: [data/](data) contains files for request bodies and uploads,
[scripts/](scripts) contains a pre-request script and a response handler used by
`03-scripts.http` and `05-files.http`. Saved responses are written to `out/`.

See the [documentation](../docs/documentation.md) for all features.
