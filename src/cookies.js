'use strict';

/** Minimal in-memory cookie jar (domain/path matching, Max-Age/Expires). */
class CookieJar {
  constructor(serialized) {
    this.cookies = Array.isArray(serialized) ? serialized : [];
  }

  store(url, setCookieHeaders) {
    const u = new URL(url);
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: u.hostname,
        hostOnly: true,
        path: u.pathname.replace(/\/[^/]*$/, '') || '/',
        expires: null
      };
      for (const a of attrs) {
        const [k, ...v] = a.split('=');
        const key = k.trim().toLowerCase();
        const val = v.join('=').trim();
        if (key === 'domain' && val) { cookie.domain = val.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
        else if (key === 'path' && val) cookie.path = val;
        else if (key === 'max-age') cookie.expires = Date.now() + Number(val) * 1000;
        else if (key === 'expires' && cookie.expires === null) {
          const t = Date.parse(val);
          if (!isNaN(t)) cookie.expires = t;
        }
      }
      this.cookies = this.cookies.filter(c =>
        !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
      if (cookie.expires === null || cookie.expires > Date.now()) this.cookies.push(cookie);
    }
  }

  header(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const now = Date.now();
    this.cookies = this.cookies.filter(c => c.expires === null || c.expires > now);
    const matching = this.cookies.filter(c => {
      const domainOk = c.hostOnly ? host === c.domain : (host === c.domain || host.endsWith('.' + c.domain));
      const pathOk = u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/');
      return domainOk && pathOk;
    });
    return matching.length ? matching.map(c => `${c.name}=${c.value}`).join('; ') : null;
  }

  clear() { this.cookies = []; }
  toJSON() { return this.cookies; }
}

module.exports = { CookieJar };
