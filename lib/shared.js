/**
 * Shared primitives for the Apple WebDAV protocols (CalDAV / CardDAV).
 *
 * Both protocols are the same shape: HTTP Basic over TLS, a principal
 * discovery hop, a home-set hop, a Depth:1 enumeration, then PUT of one
 * structured text resource. Only the XML namespaces, the home-set property
 * name, and the collection type differ — so everything else lives here once.
 */

export const XMLNS_DAV = 'xmlns:d="DAV:"';
export const XMLNS_CALDAV = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
export const XMLNS_CARDDAV = 'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"';

/** How many times a dropped connection is retried before the call fails. */
export const NET_RETRIES = 2;
/** Backoff between transport retries, in ms (index = attempt). */
const BACKOFF_MS = [250, 700];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One failure shape for every protocol hop, carrying the HTTP status when there was one. */
export class WebDAVError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'WebDAVError';
    this.status = status;
    this.body = body;
  }
}

export function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}

export function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Collect the text content of every <tag>…</tag> in an XML document. */
/** Strip any namespace prefix: `d:href` → `href`. */
export function localName(tag) {
  return tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag;
}

const PFX = '(?:[\\w.-]+:)?';

/**
 * Collect the text content of every <tag>…</tag>, ignoring namespace prefixes.
 *
 * This matters more than it looks: iCloud answers with the **default** DAV:
 * namespace and NO prefix at all (`<href>`, `<displayname>`,
 * `<addressbook-home-set>`), while Radicale/Nextcloud/Baïkal use `d:href`.
 * Every matcher below is `(?:prefix:)?local` so both parse.
 */
export function xmlTexts(xml, tag) {
  const local = localName(tag);
  const out = [];
  const re = new RegExp(`<${PFX}${local}\\b[^>]*>([\\s\\S]*?)</${PFX}${local}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeXmlEntities(m[1]).trim());
  return out;
}

/** Split a multistatus body into per-<response> chunks, prefix-agnostic. */
export function xmlResponses(xml) {
  const out = [];
  const re = new RegExp(`<${PFX}response\\b[^>]*>([\\s\\S]*?)</${PFX}response>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export function firstHref(chunk) {
  const hrefs = xmlTexts(chunk, 'href');
  return hrefs[0];
}

/**
 * Extract the href nested inside a named property such as
 * `<current-user-principal><href>…</href></current-user-principal>`.
 * A `<response>` carries its own href first, so taking the first href of the
 * whole chunk would return the resource path instead of the property value.
 * @param {string} chunk one `<response>` body
 * @param {string} tag   property name with or without a prefix
 * @returns {string|undefined}
 */
export function propertyHref(chunk, tag) {
  const local = localName(tag);
  const m = new RegExp(`<${PFX}${local}\\b[^>]*>([\\s\\S]*?)</${PFX}${local}>`, 'i').exec(chunk);
  if (!m) return undefined;
  return firstHref(m[1]);
}

/**
 * Read `<comp name="VTODO"/>` self-closing entries out of a
 * supported-calendar-component-set property.
 * @param {string} chunk one `<response>` body
 * @returns {string[]} upper-cased component names
 */
export function componentNames(chunk) {
  const block = new RegExp(
    `<${PFX}supported-calendar-component-set\\b[^>]*>([\\s\\S]*?)</${PFX}supported-calendar-component-set>`,
    'i',
  ).exec(chunk);
  if (!block) return [];
  const out = [];
  const re = new RegExp(`<${PFX}comp\\b([^>]*)\\/?>`, 'gi');
  let m;
  while ((m = re.exec(block[1])) !== null) {
    const name = /name\s*=\s*"([^"]*)"/i.exec(m[1]) ?? /name\s*=\s*'([^']*)'/i.exec(m[1]);
    if (name) out.push(name[1].trim().toUpperCase());
  }
  return out;
}

/**
 * Inspect `<resourcetype>` for one self-closing member such as
 * `<calendar/>` or `<addressbook/>`.
 * The member is self-closing, so match the tag delimiter rather than a closing
 * tag; `<calendar-home-set>` must not be mistaken for `<calendar/>`.
 * @param {string} chunk one `<response>` body
 * @param {string} wanted member name without namespace prefix
 * @returns {boolean|null} null when the server reported no resourcetype at all
 */
export function hasResourceType(chunk, wanted) {
  const block = new RegExp(`<${PFX}resourcetype\\b[^>]*>([\\s\\S]*?)</${PFX}resourcetype>`, 'i').exec(chunk);
  if (!block) return null;
  return new RegExp(`<${PFX}${localName(wanted)}[\\s/>]`, 'i').test(block[1]);
}

/** Calendar-collection test, kept as a named wrapper for call-site readability. */
export function isCalendarCollection(chunk) {
  return hasResourceType(chunk, 'calendar');
}

/** Resolve a possibly-relative href against the request base. */
export function absolute(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** TEXT escaping shared by iCalendar and vCard (RFC 5545 / RFC 6350). */
export function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/**
 * Fold long content lines at 75 octets, never splitting a UTF-8 sequence.
 * @param {string} line one logical content line
 * @param {number} [firstLimit] octets allowed on the first line
 */
export function fold(line, firstLimit = 75) {
  const chunks = [];
  let current = '';
  let bytes = 0;
  let limit = firstLimit;
  for (const ch of line) {
    // Iterate by code point so a multi-byte character is never cut in half.
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > limit) {
      chunks.push(current);
      current = '';
      bytes = 0;
      limit = firstLimit - 1; // continuation lines spend one octet on the leading space
    }
    current += ch;
    bytes += n;
  }
  chunks.push(current);
  return chunks.length === 1 ? chunks[0] : chunks.join('\r\n ');
}

/** CRLF-join folded lines and terminate the object. */
export function serializeLines(lines, firstLimit = 75) {
  return lines.map((l) => fold(l, firstLimit)).join('\r\n') + '\r\n';
}

/**
 * Undo RFC 5545/6350 line folding: a CRLF (or LF) followed by one space or tab
 * is a continuation of the previous logical line.
 *
 * Parsing a folded resource line-by-line is not "slightly lossy" — it is wrong
 * in two directions. Reading truncates the value at the first fold, and patching
 * replaces only the first physical line, so the old continuation lines survive
 * underneath the new value and the property silently becomes old-tail + new-head.
 * iCloud happens to unfold on storage, which hides both; Radicale and Nextcloud
 * store what you sent, which is exactly the self-hosted path this plugin tells
 * people to use when their account has no legacy reminder list.
 *
 * @param {string} text one iCalendar / vCard body, CRLF or LF terminated
 * @returns {string} the same body with every fold removed, LF terminated
 */
export function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/**
 * The HTTP half every Apple DAV protocol shares: Basic auth, per-request
 * deadline, PROPFIND framing, and one consistent rendering of auth failures.
 * Subclasses supply only the discovery tags and the resource serialization.
 */
export class WebDAVSession {
  /**
   * @param {object} options
   * @param {string} options.username Apple ID e-mail (or a self-hosted account).
   * @param {string} options.password App-specific password.
   * @param {string} options.baseUrl  Protocol root, e.g. https://caldav.icloud.com/
   * @param {number} [options.timeoutMs]
   * @param {string} [options.userAgent]
   * @param {AbortSignal} [options.signal] the tool call's own deadline signal
   */
  constructor({ username, password, baseUrl, timeoutMs = 20000, userAgent = 'dsh-apple-write/0.3', signal }) {
    if (!username) throw new WebDAVError('username is required');
    if (!password) throw new WebDAVError('password is required');
    this.baseUrl = baseUrl;
    this.auth = basicAuth(username, password);
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    /**
     * A tool that declares `timeoutMs` is promising to observe `exec.signal` and
     * reach quiescence when the deadline fires. DSH's timeout policy only waits
     * for the tool's promise and replaces the result afterwards — it never
     * cancels the underlying work — so without this the budget is decoration and
     * a 30-item batch can outlive its receipt by minutes.
     */
    this.signal = signal;
    /**
     * iCloud hands back a regional shard host derived from the ENTRY point you
     * used. Entering through contacts.icloud.com on a mainland-China account
     * yields pNN-contacts.icloud.com, which does not resolve in that region,
     * while pNN-contacts.icloud.com.cn does. Once a request dies at the network
     * layer we retry once with the region suffix and, if that works, keep it for
     * every URL afterwards — no configuration needed.
     */
    this.region = null;
    this.regionAdjusted = false;
  }

  /** Apply the discovered region to any iCloud URL. */
  applyRegion(url) {
    if (this.region !== 'cn') return url;
    return String(url).replace(/\.icloud\.com(?=[:/]|$)/i, '.icloud.com.cn');
  }

  async #once(url, { method = 'GET', body, headers = {}, depth } = {}) {
    if (this.signal?.aborted) {
      throw new WebDAVError(`cancelled before ${method} ${url}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Link the caller's deadline to this request. `{ once: true }` plus the
    // removal in `finally` keeps a long-lived signal from accumulating listeners
    // across the dozen requests one tool call can make.
    const forward = () => controller.abort();
    this.signal?.addEventListener?.('abort', forward, { once: true });
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Authorization: this.auth,
          'User-Agent': this.userAgent,
          ...(depth !== undefined ? { Depth: String(depth) } : {}),
          ...headers,
        },
      });
      // A 401 that arrives after a cross-origin redirect is almost never the
      // credential: fetch strips Authorization on that hop, so the request that
      // actually reached the server was anonymous. Say so instead of sending the
      // operator to regenerate a password that was fine.
      if ((res.status === 401 || res.status === 403) && res.url && res.url !== url) {
        throw new WebDAVError(
          `credentials rejected (${res.status}) after a redirect to ${res.url}. A cross-origin redirect drops the ` +
            'Authorization header, so a correct app-specific password also fails on that hop — check the two hosts ' +
            'before regenerating anything.',
          { status: res.status },
        );
      }
      return { res, text: await res.text() };
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (this.signal?.aborted) throw new WebDAVError(`cancelled during ${method} ${url}`);
        throw new WebDAVError(`request timed out after ${this.timeoutMs} ms: ${method} ${url}`);
      }
      throw new WebDAVError(`network error: ${method} ${url}: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener?.('abort', forward);
    }
  }

  async request(url, opts = {}) {
    const target = this.applyRegion(url);
    const alt = String(target).replace(/\.icloud\.com(?=[:/]|$)/i, '.icloud.com.cn');
    const canSwitchRegion = this.region !== 'cn' && alt !== target;

    // iCloud drops connections when one tool call fires a burst of requests
    // (a real acceptance run failed on the 8th request of a second with
    // "fetch failed" and then succeeded on retry). A transport failure is not
    // an answer from the server, so retry it with a short jittered backoff
    // before giving up. A 401/403/404 IS an answer and is never retried.
    let lastError = null;
    for (let attempt = 0; attempt <= NET_RETRIES; attempt += 1) {
      try {
        return await this.#once(target, opts);
      } catch (err) {
        lastError = err;
        const transport = /network error|timed out/i.test(err?.message ?? '');
        if (!transport || this.signal?.aborted) break;
        // First failure on an iCloud host that has a regional twin: hop once,
        // that is what the .com.cn fallback exists for.
        if (attempt === 0 && canSwitchRegion) {
          try {
            const out = await this.#once(alt, opts);
            this.region = 'cn';
            this.regionAdjusted = true;
            return out;
          } catch (err2) {
            lastError = err2;
          }
        }
        if (attempt < NET_RETRIES) await sleep(BACKOFF_MS[attempt] ?? 600);
      }
    }
    throw lastError;
  }

  /**
   * Render one auth failure the same way everywhere. iCloud answers 401 for
   * "no usable credential" and 403 for "rejected credential"; both mean the
   * operator should look at the app-specific password.
   */
  assertAuth(status, body) {
    if (status === 401) {
      throw new WebDAVError(
        'authentication failed (401): no usable credential was accepted. ' +
          'Use an app-specific password generated at appleid.apple.com, not the Apple ID account password.',
        { status, body },
      );
    }
    if (status === 403) {
      throw new WebDAVError(
        'credentials rejected (403). Use an app-specific password, not the Apple ID account password; ' +
          'a revoked or expired app password also lands here.',
        { status, body },
      );
    }
  }

  async propfind(url, depth, propXml, xmlns) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${xmlns}><d:prop>${propXml}</d:prop></d:propfind>`;
    const { res, text } = await this.request(url, {
      method: 'PROPFIND',
      depth,
      body,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
    this.assertAuth(res.status, text);
    if (res.status !== 207 && res.status !== 200) {
      throw new WebDAVError(`unexpected ${res.status} from ${url}`, { status: res.status, body: text });
    }
    return text;
  }

  /** Follow current-user-principal, then one home-set property, and return the home URL. */
  async discoverHomeSet(homeTag, xmlns) {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    let xml = await this.propfind(base, 0, '<d:current-user-principal/>', xmlns);
    const principal = propertyHref(
      xmlResponses(xml).find((c) => /current-user-principal/i.test(c)) ?? '',
      'current-user-principal',
    );
    if (!principal) {
      throw new WebDAVError('server did not return a current-user-principal; cannot discover the home set');
    }
    const principalUrl = absolute(base, principal);
    xml = await this.propfind(principalUrl, 0, `<${homeTag}/>`, xmlns);
    // The response may carry the property with a prefix (card:), without one
    // (default namespace), or under a different prefix; match on the local name.
    const localTag = localName(homeTag);
    const chunk =
      xmlResponses(xml).find((c) => new RegExp(`<${PFX}${localTag}\\b`, 'i').test(c)) ?? '';
    const home = propertyHref(chunk, homeTag);
    if (!home) {
      throw new WebDAVError(
        `server did not return a ${localTag} for the principal. ` +
          'If the service is enabled on the account, this usually means the server answered with an ' +
          'unexpected property shape; re-run with the diagnostic script to see the raw XML.',
      );
    }
    return { principalUrl, home: absolute(principalUrl, home) };
  }
}
