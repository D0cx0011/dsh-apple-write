/**
 * Zero-dependency CalDAV client for Apple Reminders (VTODO) over iCloud.
 *
 * Only the surface this plugin needs: discovery of a task-capable calendar
 * collection, then PUT of one .ics resource. Uses global fetch (Node >= 18).
 *
 * iCloud notes that shape the code:
 *  - `caldav.icloud.com` answers with a 207 whose calendar-home-set points at a
 *    shard host (pNN-caldav.icloud.com). Never hardcode the shard; always follow
 *    the href the server returns.
 *  - Auth is HTTP Basic with an app-specific password (`xxxx-xxxx-xxxx-xxxx`).
 *    The server advertises `Basic realm="MMCalDav"` on 401.
 *  - A reminder list is a calendar collection whose
 *    supported-calendar-component-set contains VTODO. Calendars that only carry
 *    VEVENT are not reminder lists and must be filtered out.
 */

import {
	XMLNS_CALDAV,
	WebDAVError,
	WebDAVSession,
	xmlTexts,
	xmlResponses,
	firstHref,
	isCalendarCollection,
	componentNames,
	absolute,
	escapeText,
	fold,
	unfold,
} from './shared.js';

const XMLNS = XMLNS_CALDAV;

/**
 * Kept as a distinct export so CalDAV-specific failures stay greppable at the
 * call site, while every protocol shares one error shape.
 */
export const CalDAVError = WebDAVError;

export { escapeText };

export class RemindersClient extends WebDAVSession {
  /**
   * @param {object} options
   * @param {string} options.username        Apple ID e-mail.
   * @param {string} options.password        App-specific password.
   * @param {string} [options.baseUrl]       CalDAV root, default iCloud.
   * @param {number} [options.timeoutMs]     Per-request timeout.
   */
  constructor({ username, password, baseUrl = 'https://caldav.icloud.com/', timeoutMs = 20000, signal }) {
    // Everything HTTP — Basic auth, deadline, the .icloud.com → .icloud.com.cn
    // retry, and one rendering of 401/403 — comes from WebDAVSession. This class
    // used to carry its own copy of that stack, which is exactly how it ended up
    // without the region fallback the CardDAV side had.
    super({ username, password, baseUrl, timeoutMs, signal, userAgent: 'dsh-apple-write/0.3 (caldav)' });
    this.homeSet = null;
    this.collections = null;
  }

  /** PROPFIND with the CalDAV namespaces already supplied. */
  propfind(url, depth, propXml) {
    return super.propfind(url, depth, propXml, XMLNS_CALDAV);
  }

  /** Resolve calendar-home-set for the authenticated principal. */
  async discoverHome() {
    if (this.homeSet) return this.homeSet;
    const { home } = await this.discoverHomeSet('c:calendar-home-set', XMLNS_CALDAV);
    this.homeSet = home;
    return home;
  }

  /**
   * List task-capable calendar collections.
   * @returns {Promise<Array<{name: string, url: string, vtodos: boolean, components: string[]}>>}
   */
  async listCollections() {
    if (this.collections) return this.collections;
    const home = await this.discoverHome();
    const xml = await this.propfind(
      home,
      1,
      '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:getlastmodified/>',
    );
    const collections = [];
    for (const chunk of xmlResponses(xml)) {
      const href = firstHref(chunk);
      if (!href) continue;
      const url = absolute(home, href);
      if (url.replace(/\/$/, '') === home.replace(/\/$/, '')) continue;
      // Skip the calendar-home container itself and anything that is explicitly
      // not a calendar (address books, plain folders). A server that reports no
      // resourcetype is treated as before.
      if (isCalendarCollection(chunk) === false) continue;
      const components = componentNames(chunk);
      const names = xmlTexts(chunk, 'd:displayname');
      const stamps = xmlTexts(chunk, 'd:getlastmodified');
      const componentsKnown = components.length > 0;
      collections.push({
        name: names[0] || decodeURIComponent(url.split('/').filter(Boolean).pop() ?? ''),
        url,
        // Three-state, because real iCloud accounts do NOT always publish this.
        // A sibling project measured a mainland-China account (19 calendars) and
        // found none of them advertised supported-calendar-component-set. Taking
        // an absent set as "supports everything" — which RFC 4791 does allow —
        // would then mark every plain calendar as a reminder list.
        components,
        componentsKnown,
        vtodos: componentsKnown ? (components.includes('VTODO') ? 'yes' : 'no') : 'unknown',
        // Collection-level mtime. Cheap (arrives in the same PROPFIND) but weak:
        // iCloud does not reliably bump it when a child resource changes, so it
        // is only a first hint. collectionStats() is the authoritative signal.
        lastModified: stamps[0] ?? null,
      });
    }
    this.collections = collections;
    return collections;
  }

  /**
   * Count VTODO resources in one collection. This is the only way to learn
   * whether a collection is a reminder list when the server withholds
   * supported-calendar-component-set — but a count of 0 is still ambiguous
   * (an empty reminder list and a pure event calendar both answer 0), so this
   * is a hint, not a verdict. The verdict comes from trying a PUT.
   * @param {string} collectionUrl collection to query
   * @returns {Promise<{count: number|null, status: number}>}
   */
  async probeTodos(collectionUrl) {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<c:calendar-query ${XMLNS}><d:prop><d:getetag/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>` +
      `</c:calendar-query>`;
    const { res, text } = await this.request(collectionUrl, {
      method: 'REPORT',
      depth: 1,
      body,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new CalDAVError(`REPORT refused (${res.status}) on ${collectionUrl}`, { status: res.status, body: text });
    }
    // iCloud is known to answer some calendar-query shapes with 412; treat any
    // non-multistatus as "could not determine" rather than a hard failure.
    if (res.status !== 207 && res.status !== 200) return { count: null, status: res.status };
    return { count: xmlResponses(text).length, status: res.status };
  }

  /**
   * Read every VTODO in one collection, with UID and SUMMARY.
   *
   * One calendar-query REPORT carrying `calendar-data` fetches the whole list in
   * a single round trip; the naive version (PROPFIND for hrefs, then GET each)
   * costs one request per reminder, i.e. 219 requests on a real account.
   *
   * @param {string} collectionUrl
   * @returns {Promise<Array<{href: string, uid: string|null, summary: string|null, status: string|null}>>}
   */
  async listTodos(collectionUrl) {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<c:calendar-query ${XMLNS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>` +
      `</c:calendar-query>`;
    const { res, text } = await this.request(collectionUrl, {
      method: 'REPORT',
      depth: 1,
      body,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new CalDAVError(`REPORT refused (${res.status}) on ${collectionUrl}`, { status: res.status, body: text });
    }
    if (res.status !== 207 && res.status !== 200) {
      throw new CalDAVError(`listing failed (${res.status}) on ${collectionUrl}`, { status: res.status, body: text });
    }
    const self = collectionUrl.replace(/\/$/, '');
    const out = [];
    for (const chunk of xmlResponses(text)) {
      const first = firstHref(chunk);
      if (!first) continue;
      const href = absolute(collectionUrl, first);
      if (href.replace(/\/$/, '') === self) continue;
      const [raw] = xmlTexts(chunk, 'calendar-data');
      const [etag] = xmlTexts(chunk, 'getetag');
      if (!raw) {
        out.push({
          href,
          etag: etag ?? null,
          uid: null,
          summary: null,
          status: null,
          due: null,
          notes: null,
          done: false,
        });
        continue;
      }
      // Normalise CRLF first so the ^-anchored multi-line matches below do not
      // leave a stray \r at the end of each captured value.
      const ics = raw.replace(/\r\n/g, '\n');
      const status = field(ics, 'STATUS');
      out.push({
        href,
        etag: etag ?? null,
        uid: field(ics, 'UID'),
        summary: field(ics, 'SUMMARY'),
        status,
        due: field(ics, 'DUE'),
        notes: field(ics, 'DESCRIPTION'),
        alarm: hasAlarm(ics),
        done: status === 'COMPLETED',
      });
    }
    return out;
  }

  /** Read one VTODO resource body verbatim. */
  async getTodo(href) {
    const { res, text } = await this.request(href, { method: 'GET' });
    this.assertAuth(res.status, text);
    if (res.status !== 200) {
      throw new CalDAVError(`GET failed (${res.status})`, { status: res.status, body: text });
    }
    return text;
  }

  /**
   * Delete one VTODO resource by its absolute href.
   *
   * `If-Match` on the etag that was read moments ago turns "the phone edited this
   * while we were deciding" into a 412 instead of deleting the user's newer text.
   * The header is omitted only when the server published no etag at all.
   */
  async deleteTodo(href, { etag = null } = {}) {
    const { res, text } = await this.request(href, {
      method: 'DELETE',
      headers: etag ? { 'If-Match': etag } : {},
    });
    this.assertAuth(res.status, text);
    if (res.status === 412) {
      throw new CalDAVError(
        'precondition failed (412) — 这条在读取之后被改过，未删除。重新读一遍确认后再删。',
        { status: 412 },
      );
    }
    // 404 means the goal state already holds; report it as such rather than
    // throwing, so a retried delete is not an error.
    if (res.status === 404) return { ok: true, status: 404, alreadyGone: true, conditional: Boolean(etag) };
    if (res.status !== 204 && res.status !== 200) {
      throw new CalDAVError(`DELETE rejected with ${res.status}`, { status: res.status, body: text });
    }
    return { ok: true, status: res.status, alreadyGone: false, conditional: Boolean(etag) };
  }

  /**
   * Replace one existing VTODO in place — the alternative to delete-then-recreate,
   * which leaves a window where the reminder simply does not exist.
   *
   * Takes the COMPLETE resource body, already patched by the caller (see
   * patchVCalendar). It deliberately does not rebuild the object: rebuilding would
   * drop every property this plugin does not model.
   *
   * PUT with `If-Match` on the current etag turns a lost update into a 412
   * instead of silently clobbering an edit made on the phone between our read and
   * our write. The header is dropped only when the server never supplied an etag.
   *
   * @param {string} href resource to replace
   * @param {string} ics  complete iCalendar body
   * @param {{etag?: string|null}} [options]
   */
  async updateTodo(href, ics, { etag = null } = {}) {
    if (typeof ics !== 'string' || !ics.includes('BEGIN:VTODO')) {
      throw new CalDAVError('updateTodo expects a complete iCalendar body');
    }
    const { res, text } = await this.request(href, {
      method: 'PUT',
      body: ics,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        ...(etag ? { 'If-Match': etag } : {}),
      },
    });
    if (res.status === 412) {
      throw new CalDAVError(
        'precondition failed (412) — 这条在读取之后被改过（etag 变了）。重新读一遍再改，避免覆盖手机上的编辑。',
        { status: 412 },
      );
    }
    this.assertAuth(res.status, text);
    if (res.status !== 204 && res.status !== 200 && res.status !== 201) {
      throw new CalDAVError(`PUT (update) rejected with ${res.status}`, { status: res.status, body: text });
    }
    // `conditional: false` means the server never sent an etag, so this write
    // carried no If-Match and could not detect a concurrent edit. Callers surface
    // it rather than pretending the guard applied.
    return { ok: true, status: res.status, conditional: Boolean(etag) };
  }

  /**
   * Measure how ALIVE one collection is: resource count plus the newest
   * last-modified stamp among its children.
   *
   * This exists because of a trap that cost a real debugging round: an iCloud
   * account exposed two collections that both declared VTODO, and both answered
   * every protocol question identically. One was the list the iOS Reminders app
   * actually renders; the other was a leftover that the Reminders→CloudKit
   * migration abandoned, which iOS shows as a calendar instead. Nothing in the
   * DAV layer distinguishes them — only activity does. A list whose newest item
   * is years old is the corpse; the one touched minutes ago is the live list.
   *
   * @param {string} collectionUrl collection to measure
   * @returns {Promise<{count: number, newest: string|null}>}
   */
  async collectionStats(collectionUrl) {
    // Measured against a real iCloud account: `getlastmodified` comes back as a
    // 404 propstat (empty), while `creationdate` is served — as bare
    // epoch-milliseconds, not the ISO-8601 that RFC 4918 specifies. Ask for both
    // and take whichever parses, so this works on iCloud and on servers that do
    // implement getlastmodified properly.
    const xml = await this.propfind(collectionUrl, 1, '<d:getlastmodified/><d:creationdate/>');
    const self = collectionUrl.replace(/\/$/, '');
    let count = 0;
    let newest = null;
    for (const chunk of xmlResponses(xml)) {
      const href = firstHref(chunk);
      if (!href) continue;
      // Depth:1 includes the collection itself; it is not one of its items.
      if (absolute(collectionUrl, href).replace(/\/$/, '') === self) continue;
      count += 1;
      const stamp = resourceStamp(chunk);
      if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
    }
    return { count, newest: newest === null ? null : new Date(newest).toISOString() };
  }

  /**
   * Resolve one collection by display name, id-ish suffix, or URL.
   * Candidates are collections that are not known to reject VTODO, so an
   * unpublished component set still stays in the race — flagged as unverified.
   */
  async resolveCollection(wanted) {
    const all = await this.listCollections();
    const targets = all.filter((c) => c.vtodos !== 'no');
    if (targets.length === 0) {
      const seen = all.map((c) => c.name || c.url).join(', ') || '(none)';
      throw new CalDAVError(
        `no collection on this account accepts VTODO — CalDAV cannot reach your reminder lists (visible: ${seen}). ` +
          'Apple moved Reminders to a CloudKit store; only lists never migrated remain on CalDAV.',
      );
    }
    if (!wanted) {
      if (targets.length === 1) return targets[0];
      // Several collections claim VTODO. Never guess: picking wrong writes into
      // a list the user never opens, and the write still reports success. Pay
      // for one PROPFIND per candidate and make the choice obvious instead.
      const described = [];
      for (const c of targets) {
        const stats = await this.collectionStats(c.url).catch(() => null);
        const shape = stats ? `${stats.count} 条，最后活动 ${stats.newest ?? '未知'}` : '活跃度未知';
        const note = c.vtodos === 'unknown' ? '，组件类型未公布' : '';
        described.push(`${JSON.stringify(c.name)}（${shape}${note}）`);
      }
      throw new CalDAVError(
        `账号上有多个候选提醒列表，必须显式指定 list：${described.join('；')}。` +
          '条目多、最近有活动的那个才是 iPhone 提醒事项里正在用的列表；' +
          '条目停在很久以前的通常是被 Reminders→CloudKit 迁移遗留的僵尸列表，iOS 只在日历里显示它。',
      );
    }
    const needle = wanted.toLowerCase();
    const exact = targets.find((c) => c.name.toLowerCase() === needle);
    if (exact) return exact;
    const fuzzy = targets.find(
      (c) => c.url.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle),
    );
    if (fuzzy) return fuzzy;
    throw new CalDAVError(
      `reminder list ${JSON.stringify(wanted)} not found (candidates: ${targets.map((c) => c.name).join(', ')})`,
    );
  }

  /**
   * Create one VTODO in the resolved collection.
   *
   * When a list is named explicitly, its activity is sampled FIRST — before the
   * PUT, because afterwards our own resource is the newest item and every list
   * would measure as alive. This guards a trap that actually happened on a real
   * account: a live list and a zombie list both declared VTODO, answered every
   * protocol question identically, and both accepted the write. Only the live
   * one is rendered by the iOS Reminders app; the zombie shows up in Calendar.
   * The write reported success either way, so nothing but activity tells them
   * apart.
   *
   * @param {object} todo
   * @param {{list?: string, verifyActivity?: boolean}} [options]
   */
  async createTodo(todo, { list, verifyActivity = Boolean(list), collection: preset } = {}) {
    // `collection` exists so a batch caller can resolve the list and sample its
    // activity ONCE. Without it a 30-item batch would issue 30 extra PROPFINDs
    // over a 219-item collection.
    const collection = preset ?? (await this.resolveCollection(list));

    const activity = verifyActivity
      ? await this.collectionStats(collection.url).catch(() => null)
      : null;
    const staleDays =
      activity?.newest != null
        ? Math.floor((Date.now() - Date.parse(activity.newest)) / 86_400_000)
        : null;

    const uid = todo.uid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // A collection href normally ends in '/', but `new URL('x.ics', '…/work')`
    // resolves to '…/x.ics' — one level UP, into the calendar home. Normalise so
    // a server that omits the trailing slash cannot scatter resources.
    const base = collection.url.endsWith('/') ? collection.url : `${collection.url}/`;
    const href = new URL(`${encodeURIComponent(uid)}.ics`, base).toString();
    const ics = buildVCalendar({ ...todo, uid });
    const { res, text } = await this.request(href, {
      method: 'PUT',
      body: ics,
      // Idempotency guard: never overwrite an existing resource on create.
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
    });
    if (res.status === 412) {
      throw new CalDAVError('precondition failed (412) — a resource with this UID already exists', { status: 412 });
    }
    this.assertAuth(res.status, text);
    if (res.status === 507) {
      // WebDAV's standard "out of space" answer. On iCloud this means the
      // account is over its storage quota; on a self-hosted server it is the
      // data volume being full.
      throw new CalDAVError(
        'server reports insufficient storage (507). On iCloud the account is over its storage quota — ' +
          'free space or upgrade the plan, then retry. On a self-hosted CalDAV server, check the data volume.',
        { status: 507 },
      );
    }
    if (res.status !== 201 && res.status !== 204 && res.status !== 200) {
      throw new CalDAVError(`PUT rejected with ${res.status}`, { status: res.status, body: text });
    }
    // What the caller's `due` actually became. An offset-less value is read in
    // the local timezone, so the stored instant depends on where this runs; the
    // caller must be able to echo the resolved absolute time back to the user.
    const dueResolved = todo.due
      ? toIcalDate(todo.due, { allDay: /^\d{4}-\d{2}-\d{2}$/.test(todo.due) }).resolved
      : null;

    return {
      uid,
      href,
      status: res.status,
      dueResolved,
      // Echo the normalized trigger so the caller can show what the phone will
      // actually schedule instead of the caller's own spelling.
      alarmTrigger: todo.alarm ? alarmTrigger(todo.alarm) : null,
      list: collection.name,
      listUrl: collection.url,
      // Deliberately named: it says what the SERVER declared about VTODO, not
      // that the iPhone will show the item. Those are different claims and this
      // account proved they can diverge.
      vtodoDeclared: collection.vtodos === 'yes',
      activity,
      staleDays,
      stale: staleDays !== null && staleDays > STALE_LIST_DAYS,
    };
  }
}

/**
 * A list untouched for this long is treated as suspect. Reminders people keep
 * using get touched every few weeks; the migration leftovers stopped dead years
 * ago, so anything past a quarter is far more likely a corpse than a quiet list.
 */
export const STALE_LIST_DAYS = 90;

/**
 * Read one property value out of the VTODO of an ICS body, e.g.
 * `DUE;VALUE=DATE:20261113`.
 *
 * Two things would otherwise go wrong. The body is unfolded first, because a
 * folded SUMMARY reads back as its first physical line only — every title longer
 * than 75 octets would come back truncated, and the tools that exist to stop
 * duplicates (skip_existing, exact-title matching) compare against that string.
 * Then the search is restricted to the VTODO component, because DESCRIPTION is
 * legal inside VALARM too and reading the alarm's notification text as the
 * reminder's note is silently wrong.
 *
 * @param {string} ics one iCalendar object body
 * @returns {string|null}
 */
function field(ics, name) {
  const body = componentBody(ics, 'VTODO');
  const m = body.match(new RegExp(`^${name}([^:\\r\\n]*):(.*)$`, 'm'));
  return m ? m[2].trim() : null;
}

/**
 * The lines of one named component inside a body, unfolded.
 * @param {string} ics  iCalendar body
 * @param {string} name component name, e.g. VTODO
 * @returns {string} the component's inner text (without BEGIN/END), or the
 *   whole body when the component is not present
 */
function componentBody(ics, name) {
  const text = unfold(ics);
  const start = text.indexOf(`BEGIN:${name}`);
  if (start < 0) return text;
  const end = text.indexOf(`END:${name}`, start);
  if (end < 0) return text.slice(start + name.length + 7);
  return text.slice(start + name.length + 7, end);
}

/**
 * Newest timestamp carried by one `<response>`, in epoch milliseconds, or null.
 *
 * Two shapes must both parse: `getlastmodified` is an HTTP-date per RFC 4918 and
 * is what Radicale / Nextcloud serve; iCloud answers it with an empty 404
 * propstat and serves `creationdate` as bare epoch-milliseconds instead.
 */
function resourceStamp(chunk) {
  const [http] = xmlTexts(chunk, 'd:getlastmodified');
  if (http) {
    const t = Date.parse(http);
    if (!Number.isNaN(t)) return t;
  }
  const [created] = xmlTexts(chunk, 'd:creationdate');
  if (created) {
    if (/^\d+$/.test(created)) return Number(created);
    const t = Date.parse(created);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/**
 * ISO-8601 (or date-only) → iCalendar DATE / DATE-TIME in UTC.
 *
 * `resolved` is what the input actually meant in absolute terms, with the
 * machine's UTC offset attached. An offset-less value like
 * "2026-11-16T09:00:00" is read in the LOCAL timezone by `new Date`, so the
 * stored UTC instant depends on where this process runs. Callers must echo
 * `resolved` back: a due date that silently shifts by hours is invisible until
 * somebody opens the phone.
 */
export function toIcalDate(value, { allDay = false } = {}) {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return { property: 'DUE;VALUE=DATE', value: fmtDate(d), resolved: isoDate(d) };
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new CalDAVError(`invalid due date: ${value}`);
  const stored = `${fmtDate(d)}T${fmtTime(d)}Z`;
  return { property: 'DUE', value: stored, resolved: isoLocal(d), utc: stored };
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}
function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** Local wall clock plus explicit UTC offset, e.g. 2026-11-16T09:00:00+08:00. */
function isoLocal(d) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
function fmtDate(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function fmtTime(d) {
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Edit a few properties of an existing VTODO without rebuilding the object.
 *
 * Rebuilding through buildVCalendar would drop everything this plugin does not
 * model — VALARM, URL, attachments, subtask relations — so an "update the due
 * date" call would quietly destroy the user's alarm. Patch the logical lines
 * instead and leave every property this call did not name exactly as it was.
 *
 * @param {string} ics original resource body
 * @param {{title?: string, notes?: string|null, due?: string|null, priority?: number, status?: string}} changes
 * @returns {string} new resource body
 */
export function patchVCalendar(ics, { title, notes, due, priority, status, alarm } = {}) {
  // Work on logical lines. Patching a still-folded body edits only the first
  // physical line of a property, so the old continuation lines stay put and the
  // value becomes "new text + tail of the old text" — a rename that silently
  // mangles the title on any server that returns folded bodies.
  const lines = unfold(ics).split('\n');

  // Component depth per line. A VTODO body is
  //   BEGIN:VCALENDAR (0) → props (1) → BEGIN:VTODO (1) → props (2) → BEGIN:VALARM (2) → props (3)
  // and DESCRIPTION is legal on both VTODO and VALARM. Patching by line alone
  // therefore rewrites the alarm's notification text when the caller meant the
  // reminder's note — so every property operation is restricted to the depth
  // the VTODO's own properties live at.
  const depth = new Array(lines.length).fill(0);
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('BEGIN:')) {
      depth[i] = level;
      level += 1;
    } else if (line.startsWith('END:')) {
      level = Math.max(0, level - 1);
      depth[i] = level;
    } else {
      depth[i] = level;
    }
  }
  const todoAt = lines.indexOf('BEGIN:VTODO');
  const propDepth = todoAt >= 0 ? depth[todoAt] + 1 : 1;
  const isProp = (index, name) =>
    depth[index] === propDepth && new RegExp(`^${name}[;:]`).test(lines[index]);

  const dropAll = (name) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) if (isProp(i, name)) lines.splice(i, 1);
  };
  // Properties must precede sub-components inside a component (RFC 5545 §3.6),
  // so a new property goes before the first nested BEGIN, not before END:VTODO
  // — that would place it after the VALARM block.
  const insertProp = (line) => {
    const nested = lines.findIndex((l, i) => i > todoAt && depth[i] === propDepth && l.startsWith('BEGIN:'));
    const end = lines.indexOf('END:VTODO');
    const at = nested >= 0 ? nested : end < 0 ? lines.length : end;
    lines.splice(at, 0, line);
  };
  const upsert = (name, line) => {
    const at = lines.findIndex((_, i) => isProp(i, name));
    if (at >= 0) lines[at] = line;
    else insertProp(line);
  };
  // A VALARM is a component, not a property: remove the whole BEGIN…END block
  // (there can be several) instead of a single line.
  const dropAlarm = () => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i] !== 'END:VALARM') continue;
      let start = i;
      while (start >= 0 && lines[start] !== 'BEGIN:VALARM') start -= 1;
      if (start >= 0) lines.splice(start, i - start + 1);
    }
  };
  const stampNow = () => {
    const now = new Date();
    return `${fmtDate(now)}T${fmtTime(now)}Z`;
  };

  if (title !== undefined) upsert('SUMMARY', `SUMMARY:${escapeText(title)}`);
  if (notes !== undefined) {
    if (notes === null || notes === '') dropAll('DESCRIPTION');
    else upsert('DESCRIPTION', `DESCRIPTION:${escapeText(notes)}`);
  }
  if (due !== undefined) {
    dropAll('DUE');
    if (due !== null && due !== '') {
      const { property, value } = toIcalDate(due, { allDay: /^\d{4}-\d{2}-\d{2}$/.test(due) });
      insertProp(`${property}:${value}`);
    }
  }
  if (priority !== undefined) upsert('PRIORITY', `PRIORITY:${priority}`);
  if (status !== undefined) {
    upsert('STATUS', `STATUS:${status}`);
    // Apple writes STATUS:COMPLETED and COMPLETED:<UTC> as a pair. Emitting only
    // the status leaves the completion date missing, so clients that show "done
    // on …" have nothing to show, and re-opening the item finds a stale stamp.
    if (status === 'COMPLETED') upsert('COMPLETED', `COMPLETED:${stampNow()}`);
    else dropAll('COMPLETED');
  }
  if (alarm !== undefined) {
    dropAlarm();
    if (alarm !== null && alarm !== '') {
      const block = alarmBlock(alarm, title ?? field(ics, 'SUMMARY') ?? '提醒');
      const end = lines.indexOf('END:VTODO');
      lines.splice(end < 0 ? lines.length : end, 0, ...block);
    }
  }

  // Re-fold: edited values may exceed the 75-octet limit, and the body was
  // unfolded above, so every logical line is re-serialized exactly once.
  return lines.filter((l) => l !== '').map((l) => fold(l)).join('\r\n') + '\r\n';
}

/**
 * Turn a human alarm spelling into an iCalendar DURATION: `15m`, `1h`, `2d`,
 * `0` / `at` (at the due moment), or an already-formed `-PT15M` / `PT0S`.
 * @param {string} value caller spelling
 * @returns {string} TRIGGER value, e.g. "-PT15M"
 */
export function alarmTrigger(value) {
  const raw = String(value).trim();
  if (!raw) throw new CalDAVError('empty alarm value');
  if (/^[+-]?P/i.test(raw)) return raw.toUpperCase().startsWith('P') ? `-${raw.toUpperCase()}` : raw.toUpperCase();
  if (raw === '0' || raw === 'at' || raw === 'ontime') return 'PT0S';
  const m = /^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i.exec(raw);
  if (!m) {
    throw new CalDAVError(
      `无法解析的提醒时间 ${JSON.stringify(raw)}：用 "15m" / "1h" / "2d" / "0"（到点提醒），或直接给 iCalendar 的 "-PT15M"。`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  if (n === 0) return 'PT0S';
  if (unit === 'm') return `-PT${n}M`;
  if (unit === 'h') return `-PT${n}H`;
  return `-P${n}D`;
}

/**
 * The VALARM block a reminder needs to actually fire on the phone.
 *
 * A VTODO without VALARM is a silent list item — iOS Reminders shows it, but
 * nothing buzzes. ACTION:DISPLAY plus TRIGGER is the minimal shape Apple's
 * client renders; DESCRIPTION is what the notification body shows.
 *
 * @param {string} trigger human spelling, see alarmTrigger
 * @param {string} title   notification text
 * @returns {string[]} unfolded content lines
 */
export function alarmBlock(trigger, title) {
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(title)}`,
    `TRIGGER:${alarmTrigger(trigger)}`,
    'END:VALARM',
  ];
}

/** Whether one VTODO body carries at least one VALARM. */
export function hasAlarm(ics) {
  return /^BEGIN:VALARM$/m.test(unfold(ics));
}

/** Build a minimal, Apple-accepted VTODO calendar object. */
export function buildVCalendar({ uid, title, notes, due, priority, url, completed, alarm }) {
  const now = new Date();
  const stamp = `${fmtDate(now)}T${fmtTime(now)}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dsh-apple-write//CalDAV VTODO//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `CREATED:${stamp}`,
    `SUMMARY:${escapeText(title)}`,
  ];
  if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
  if (due) {
    const { property, value } = toIcalDate(due, { allDay: /^\d{4}-\d{2}-\d{2}$/.test(due) });
    lines.push(`${property}:${value}`);
  }
  lines.push(`PRIORITY:${Number.isInteger(priority) ? priority : 0}`);
  // STATUS may not repeat, so the completed shape replaces the open one.
  if (completed) lines.push(`COMPLETED:${stamp}`, 'STATUS:COMPLETED');
  else lines.push('STATUS:NEEDS-ACTION');
  if (url) lines.push(`URL:${escapeText(url)}`);
  if (alarm) lines.push(...alarmBlock(alarm, title));
  lines.push('END:VTODO', 'END:VCALENDAR');
  // Wrap explicitly: handing `fold` straight to map would pass the array index
  // as `firstLimit`, collapsing every line to a single character.
  return lines.map((l) => fold(l)).join('\r\n') + '\r\n';
}
