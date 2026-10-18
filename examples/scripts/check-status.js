// Response handler from a file: used with "> ./scripts/check-status.js"
client.test("Status is 2xx", () => {
  client.assert(response.status >= 200 && response.status < 300, `status ${response.status}`);
});
client.log(`${request.method} ${request.url()} → ${response.status} (${response.contentType.mimeType})`);
