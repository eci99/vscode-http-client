'use strict';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const BINARY_MIME = /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|x-tar|vnd\.)/;

const STATUS_LINE = /^HTTP\/1\.1 \d{3}/;

function isBinaryResponse({ mimeType }) {
  return !!mimeType && BINARY_MIME.test(mimeType) && !/xml|json/.test(mimeType);
}

function prettyBody(response, pretty) {
  const { text, bodyBuffer } = response;
  if (isBinaryResponse(response)) {
    return `<binary content, ${formatBytes(bodyBuffer.length)}>`;
  }
  if (pretty && typeof response.parsedBody === 'object' && response.parsedBody !== null) {
    return JSON.stringify(response.parsedBody, null, 2);
  }
  return text;
}

/** Formats one result in the style of the IntelliJ response panel. */
function formatResult(r, opts = {}) {
  const out = [];
  out.push(`// ${r.title}`);
  if (r.request) out.push(`// ${r.request.method} ${r.request.url}`);
  if (opts.environment !== undefined) out.push(`// Environment: ${opts.environment}`);
  if (r.missing.length) out.push(`// ⚠ Unresolved variables: ${r.missing.join(', ')}`);
  if (r.error) {
    out.push(`// ✗ Error: ${r.error}`);
  }
  for (const l of r.logs) out.push(`// ${l.replace(/\n/g, '\n// ')}`);
  if (r.tests.length) {
    const passed = r.tests.filter(t => t.passed).length;
    out.push(`// Tests: ${passed}/${r.tests.length} passed`);
    for (const t of r.tests) out.push(t.passed ? `//   ✓ ${t.name}` : `//   ✗ ${t.name}: ${t.error}`);
  }
  if (r.response) {
    const res = r.response;
    out.push(`// Response code: ${res.status} (${res.statusText || ''}); Time: ${res.durationMs} ms; ` +
      `Content length: ${formatBytes(res.bodyBuffer.length)}`);
    if (r.savedTo) out.push(`// Response saved to ${r.savedTo}`);
    out.push('');
    out.push(`HTTP/1.1 ${res.status} ${res.statusText || ''}`.trimEnd());
    for (const h of res.headers) out.push(`${h.name}: ${h.value}`);
    out.push('');
    out.push(prettyBody(res, opts.prettyJson !== false));
  }
  return out.join('\n');
}

function formatResults(results, opts) {
  return results.map(r => formatResult(r, opts)).join('\n\n###\n\n') + '\n';
}

module.exports = { formatResult, formatResults, formatBytes, STATUS_LINE, isBinaryResponse };
