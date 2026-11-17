/**
 * Zero-dependency CardDAV client for Apple Contacts (vCard) over iCloud.
 *
 * CardDAV is the same protocol shape as CalDAV — Basic over TLS, principal hop,
 * home-set hop, Depth:1 enumeration, then PUT — so everything except the
 * namespaces, the home-set tag and the resource type comes from shared.js.
 *
 * iCloud specifics that shape the code:
 *  - Root is `https://contacts.icloud.com/`, and the home set points at a shard
 *    host (`pNN-contacts.icloud.com`, or `.icloud.com.cn` in mainland China).
 *    Always follow the href the server returns.
 *  - Auth is HTTP Basic with the same app-specific password the CalDAV side uses.
 *  - Contacts are vCard **3.0**. Apple's Address Book reads 3.0 best; 4.0 fields
 *    such as KIND/MEMBER are only partially understood.
 */
import {
  XMLNS_CARDDAV,
  WebDAVError,
  WebDAVSession,
  xmlTexts,
  xmlResponses,
  firstHref,
  hasResourceType,
  absolute,
  escapeText,
  serializeLines,
  unfold,
} from './shared.js';

/** Kept as a distinct export so CardDAV-specific failures stay greppable. */
export const CardDAVError = WebDAVError;

/** iCloud's synthetic address book names, mapped to something a human reads. */
const FRIENDLY_NAMES = new Map([
  ['card', '通讯录'],
  ['addressbook', '通讯录'],
  ['addressbooks', '通讯录'],
]);

export class ContactsClient extends WebDAVSession {
  /**
   * @param {object} options
   * @param {string} options.username        Apple ID e-mail.
   * @param {string} options.password        App-specific password.
   * @param {string} [options.baseUrl]       CardDAV root, default iCloud.
   * @param {number} [options.timeoutMs]     Per-request timeout.
   */
  constructor({ username, password, baseUrl = 'https://contacts.icloud.com/', timeoutMs = 20000, signal }) {
    super({ username, password, baseUrl, timeoutMs, signal, userAgent: 'dsh-apple-write/0.3 (carddav)' });
    this.home = null;
    this.books = null;
  }

  /** Resolve addressbook-home-set for the authenticated principal. */
  async discoverHome() {
    if (this.home) return this.home;
    const { home } = await this.discoverHomeSet('card:addressbook-home-set', XMLNS_CARDDAV);
    this.home = home;
    return home;
  }

  /**
   * List address-book collections.
   * @returns {Promise<Array<{name: string, url: string}>>}
   */
  async listAddressbooks() {
    if (this.books) return this.books;
    const home = await this.discoverHome();
    const xml = await this.propfind(home, 1, '<d:displayname/><d:resourcetype/>', XMLNS_CARDDAV);
    const books = [];
    for (const chunk of xmlResponses(xml)) {
      const href = firstHref(chunk);
      if (!href) continue;
      const url = absolute(home, href);
      if (url.replace(/\/$/, '') === home.replace(/\/$/, '')) continue;
      // Skip anything that is explicitly not an address book (calendars, plain folders).
      if (hasResourceType(chunk, 'addressbook') === false) continue;
      const raw = xmlTexts(chunk, 'd:displayname')[0];
      const slug = decodeURIComponent(url.split('/').filter(Boolean).pop() ?? '');
      books.push({ name: raw || FRIENDLY_NAMES.get(slug.toLowerCase()) || slug, url });
    }
    this.books = books;
    return books;
  }

  /**
   * Resolve one address book by display name or URL fragment.
   * iCloud normally exposes exactly one; when several exist and none is named,
   * the first (the primary book) wins rather than failing the write.
   */
  async resolveAddressbook(wanted) {
    const all = await this.listAddressbooks();
    if (all.length === 0) {
      throw new CardDAVError(
        'no address book on this account. Check that Contacts is enabled for the Apple ID, ' +
          'or point baseUrl at a self-hosted CardDAV server.',
      );
    }
    if (!wanted) return all[0];
    const needle = wanted.toLowerCase();
    const exact = all.find((b) => b.name.toLowerCase() === needle);
    if (exact) return exact;
    const fuzzy = all.find((b) => b.url.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle));
    if (fuzzy) return fuzzy;
    throw new CardDAVError(
      `address book ${JSON.stringify(wanted)} not found (candidates: ${all.map((b) => b.name).join(', ')})`,
    );
  }

  /**
   * Read the contacts in one address book.
   *
   * CardDAV `addressbook-query` (RFC 6352 §8.6) returns every vCard in ONE round
   * trip — a PROPFIND + GET-per-resource would cost one request per contact. The
   * empty `<card:filter test="anyof"/>` is the documented "match everything"
   * shape; a server that refuses it reports the status rather than an empty list.
   *
   * This is the read half of the contacts channel. Without it a wrong write into
   * the user's phone could only be repaired by hand on the device, which is the
   * same asymmetry that made a wrong reminder list so expensive.
   *
   * @param {string} [book] address book name; defaults to the primary book
   * @returns {Promise<Array<{uid: string, href: string, etag: string|null, name: string, phones: string[], emails: string[], book: string}>>}
   */
  async listContacts(book) {
    const target = await this.resolveAddressbook(book);
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<card:addressbook-query ${XMLNS_CARDDAV}>` +
      '<d:prop><d:getetag/><card:address-data/></d:prop>' +
      '<card:filter test="anyof"/>' +
      '</card:addressbook-query>';
    const { res, text } = await this.request(target.url, {
      method: 'REPORT',
      depth: 1,
      body,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
    this.assertAuth(res.status, text);
    if (res.status !== 207 && res.status !== 200) {
      throw new CardDAVError(`contact listing failed (${res.status}) on ${target.name}`, {
        status: res.status,
        body: text,
      });
    }
    const self = target.url.replace(/\/$/, '');
    const out = [];
    for (const chunk of xmlResponses(text)) {
      const first = firstHref(chunk);
      if (!first) continue;
      const href = absolute(target.url, first);
      if (href.replace(/\/$/, '') === self) continue;
      const [raw] = xmlTexts(chunk, 'address-data');
      const [etag] = xmlTexts(chunk, 'getetag');
      out.push({ href, etag: etag ?? null, book: target.name, ...parseVCard(raw ?? '') });
    }
    return out;
  }

  /**
   * Delete one contact resource by its absolute href.
   * 404 means the goal state already holds and is reported, not thrown.
   * `If-Match` guards against deleting a card the phone just edited.
   */
  async deleteContact(href, { etag = null } = {}) {
    const { res, text } = await this.request(href, {
      method: 'DELETE',
      headers: etag ? { 'If-Match': etag } : {},
    });
    this.assertAuth(res.status, text);
    if (res.status === 412) {
      throw new CardDAVError(
        'precondition failed (412) — 这张名片在读取之后被改过，未删除。重新查一次再删。',
        { status: 412 },
      );
    }
    if (res.status === 404) return { ok: true, status: 404, alreadyGone: true };
    if (res.status !== 204 && res.status !== 200) {
      throw new CardDAVError(`DELETE rejected with ${res.status}`, { status: res.status, body: text });
    }
    return { ok: true, status: res.status, alreadyGone: false };
  }

  /**
   * Create one contact. Returns {uid, href, status, book}.
   * @param {{uid?: string, name: string, phone?: string|string[], email?: string, org?: string, note?: string, url?: string}} contact
   * @param {{book?: string}} [options]
   */  async createContact(contact, { book } = {}) {
    const target = await this.resolveAddressbook(book);
    const uid = contact.uid ?? globalThis.crypto.randomUUID();
    // Same trailing-slash trap as CalDAV: `new URL('x.vcf', '…/card')` escapes one
    // level up, so normalize before building the resource href.
    const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
    const href = new URL(`${encodeURIComponent(uid)}.vcf`, base).toString();
    const vcf = buildVCard({ ...contact, uid });
    const { res, text } = await this.request(href, {
      method: 'PUT',
      body: vcf,
      // Idempotency guard: never overwrite an existing resource on create.
      headers: { 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' },
    });
    this.assertAuth(res.status, text);
    if (res.status === 412) {
      throw new CardDAVError('precondition failed (412) — a contact with this UID already exists', { status: 412 });
    }
    if (res.status === 507) {
      throw new CardDAVError(
        'server reports insufficient storage (507). On iCloud the account is over its storage quota.',
        { status: 507 },
      );
    }
    if (res.status !== 201 && res.status !== 204 && res.status !== 200) {
      throw new CardDAVError(`PUT rejected with ${res.status}`, { status: res.status, body: text });
    }
    return { uid, href, status: res.status, book: target.name, bookUrl: target.url };
  }
}

/**
 * Build a minimal vCard 3.0 object Apple's Address Book accepts.
 *
 * `FN` (formatted name) and `N` (structured name) are separate fields and the
 * iOS UI renders both. Chinese names have no natural given/family split, so the
 * whole name goes into the family slot — that is the shape macOS Contacts
 * displays most predictably.
 */
export function buildVCard({ uid, name, phone, email, org, note, url }) {
  if (!name || !String(name).trim()) throw new CardDAVError('contact name is required');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${escapeText(name)}`];
  lines.push(`N:${escapeText(name)};;;;`);
  for (const p of [].concat(phone ?? [])) {
    if (p && String(p).trim()) lines.push(`TEL;TYPE=CELL:${escapeText(p)}`);
  }
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${escapeText(email)}`);
  if (org) lines.push(`ORG:${escapeText(org)}`);
  if (note) lines.push(`NOTE:${escapeText(note)}`);
  if (url) lines.push(`URL:${escapeText(url)}`);
  lines.push('END:VCARD');
  return serializeLines(lines);
}

/** Undo vCard TEXT escaping for display purposes. */
export function unescapeText(value) {
  // One pass, so a literal "\\n" (backslash + n) does not become a newline
  // before the escaped backslash itself is resolved.
  return String(value).replace(/\\([\\n,;])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

/**
 * Pull the fields this plugin models out of one vCard body.
 *
 * Only the shape `buildVCard` writes plus the conventional Apple fields are
 * read: a real address book carries PHOTO, ADR, BDAY, social profiles and more,
 * and none of that is this plugin's business — the point is to let the model see
 * what already exists before it writes another copy, and to let a mistaken write
 * be found again and deleted.
 *
 * @param {string} raw one vCard body (folded or not)
 * @returns {{uid: string, name: string, phones: string[], emails: string[]}}
 */
export function parseVCard(raw) {
  const text = unfold(raw);
  const values = (property) => {
    const out = [];
    const re = new RegExp(`^${property}([;:][^\\n]*)$`, 'gm');
    let m;
    while ((m = re.exec(text)) !== null) {
      const colon = m[1].indexOf(':');
      if (colon >= 0) out.push(unescapeText(m[1].slice(colon + 1).trim()));
    }
    return out;
  };
  return {
    uid: values('UID')[0] ?? '',
    name: values('FN')[0] ?? values('N')[0] ?? '',
    phones: values('TEL'),
    emails: values('EMAIL'),
  };
}
