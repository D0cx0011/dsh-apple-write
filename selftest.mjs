/**
 * Offline self-test: drives the plugin through a stub cordis context and fake
 * iCloud CalDAV + CardDAV servers, asserting discovery, filtering, VTODO /
 * vCard generation, patching, alarms, and error surfaces.
 *
 * No network, no credentials. Run it with `npm test` (or `node selftest.mjs`).
 *
 * The fixtures deliberately include the shapes that bit a real deployment:
 *   - a folded SUMMARY (a server that preserves folding, unlike iCloud)
 *   - a floating DUE with no `Z` (what iCloud stores for phone-created items)
 *   - one live and one zombie list that declare the same component set
 *   - two reminders with the same title, so an ambiguous delete must refuse
 */
import assert from 'node:assert/strict';

const MOD = process.argv[2] || './lib/index.js';
const plugin = await import(new URL(MOD, import.meta.url).href);
const caldav = await import(new URL('./lib/caldav.js', import.meta.url).href);
const { CalDAVError, RemindersClient } = plugin;
const { buildVCalendar, escapeText, toIcalDate, patchVCalendar, alarmTrigger, hasAlarm } = caldav;

// ---------------------------------------------------------------- fake server
const SHARD = 'https://p62-caldav.icloud.com';
const PRINCIPAL = 'https://caldav.icloud.com/123456/principal/';
const HOME = `${SHARD}/123456/calendars/`;

const COLLECTIONS = [
  { href: '/123456/calendars/work/', name: 'Work', comps: ['VTODO'] },
  { href: '/123456/calendars/home/', name: 'Reminders', comps: ['VTODO'] },
  { href: '/123456/calendars/personal/', name: 'Personal', comps: ['VEVENT'] },
];

// Child resources per collection.
//   `home` models the trap a real account had: both `Work` and `Reminders`
//   declare VTODO and answer every protocol question the same way, but only
//   `home` is alive.
//   `zzzz` carries a folded SUMMARY and a floating (no-`Z`) DUE — the two shapes
//   that a line-by-line parser gets wrong.
//   The two `买牙膏` rows exist so reminder_remove has a real ambiguity to refuse.
const CHILDREN = {
  home: [
    { href: '/123456/calendars/home/aaaa.ics', mtime: 'Mon, 10 Nov 2025 09:00:00 GMT', uid: 'aaaa', summary: '交房租' },
    { href: '/123456/calendars/home/bbbb.ics', mtime: 'Fri, 20 Oct 2023 09:00:00 GMT', uid: 'bbbb', summary: '买牙膏' },
    { href: '/123456/calendars/home/dddd.ics', mtime: 'Fri, 20 Oct 2023 09:00:00 GMT', uid: 'dddd', summary: '买牙膏' },
    {
      href: '/123456/calendars/home/zzzz.ics',
      mtime: 'Tue, 11 Nov 2025 09:00:00 GMT',
      uid: 'zzzz',
      summary: '一条被服务端折行的长标题，用来确认读回时不会只剩第一段',
      due: '20251113T210000',
      folded: true,
      alarm: true,
    },
  ],
  work: [
    {
      href: '/123456/calendars/work/cccc.ics',
      mtime: 'Tue, 02 May 2023 09:00:00 GMT',
      uid: 'cccc',
      summary: '周报',
    },
  ],
  personal: [],
};

/** Fold one content line at 46 octets, the way a server that preserves folding does. */
function foldAt(line, width = 46) {
  let out = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > width) {
      out += '\r\n ';
      bytes = 1;
    }
    out += ch;
    bytes += n;
  }
  return out;
}

function icsFor(item) {
  const lines = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    `UID:${item.uid}`,
    item.folded ? foldAt(`SUMMARY:${item.summary}`) : `SUMMARY:${item.summary}`,
    'STATUS:NEEDS-ACTION',
  ];
  if (item.due) lines.push(`DUE:${item.due}`);
  if (item.alarm) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:提醒', 'TRIGGER:-PT15M', 'END:VALARM');
  }
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

const calls = [];
const CONTACTS_ROOT = 'https://contacts.icloud.com/';
const CONTACTS_PRINCIPAL = 'https://contacts.icloud.com/123456/principal/';
const CONTACTS_HOME = 'https://p62-contacts.icloud.com/123456/carddavhome/';
const CONTACT_CARD = `${CONTACTS_HOME}card/`;

const CONTACTS = [
  { href: `${CONTACT_CARD}AAAA.vcf`, uid: 'AAAA', name: '张三', phone: '+8613800138000' },
  { href: `${CONTACT_CARD}BBBB.vcf`, uid: 'BBBB', name: '李四', phone: '+8613900139000' },
  { href: `${CONTACT_CARD}CCCC.vcf`, uid: 'CCCC', name: '张三', phone: '+8613700137000' },
];

function vcfFor(contact) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${contact.uid}`,
    `FN:${contact.name}`,
    `N:${contact.name};;;;`,
    `TEL;TYPE=CELL:${contact.phone}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

function fakeFetch(url, init = {}) {
  const u = String(url);
  calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });

  // ---- CardDAV branch ----
  if (u === CONTACTS_ROOT && init.method === 'PROPFIND') {
    return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop>
      <d:current-user-principal><d:href>${new URL(CONTACTS_PRINCIPAL).pathname}</d:href></d:current-user-principal>
    </d:prop></d:propstat></d:response>`);
  }
  if (u === CONTACTS_PRINCIPAL) {
    return xml(207, `<d:response><d:href>${new URL(CONTACTS_PRINCIPAL).pathname}</d:href><d:propstat><d:prop>
      <card:addressbook-home-set><d:href>${CONTACTS_HOME}</d:href></card:addressbook-home-set>
    </d:prop></d:propstat></d:response>`);
  }
  if (u === CONTACTS_HOME) {
    return xml(207, `<d:response><d:href>/123456/carddavhome/card/</d:href><d:propstat><d:prop>
      <d:displayname/>
      <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
    </d:prop></d:propstat></d:response>`);
  }
  if (init.method === 'REPORT' && u === CONTACT_CARD) {
    const body = CONTACTS.map(
      (c) =>
        `<d:response><d:href>${new URL(c.href).pathname}</d:href><d:propstat><d:prop>` +
        `<d:getetag>"${c.uid}-etag"</d:getetag>` +
        `<card:address-data>${vcfFor(c)}</card:address-data>` +
        '</d:prop></d:propstat></d:response>',
    ).join('');
    return xml(207, body);
  }
  if (init.method === 'PUT' && u.startsWith(CONTACT_CARD)) return textRes(201, '');
  if (init.method === 'DELETE' && u.startsWith(CONTACT_CARD)) return textRes(204, '');
  if (u.startsWith('https://p62-contacts.icloud.com/')) return textRes(404, 'no');

  // ---- CalDAV branch ----
  if (u === 'https://caldav.icloud.com/' && init.method === 'PROPFIND') {
    return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop>
      <d:current-user-principal><d:href>${new URL(PRINCIPAL).pathname}</d:href></d:current-user-principal>
    </d:prop></d:propstat></d:response>`);
  }
  if (u === PRINCIPAL) {
    return xml(207, `<d:response><d:href>${new URL(PRINCIPAL).pathname}</d:href><d:propstat><d:prop>
      <c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>
    </d:prop></d:propstat></d:response>`);
  }
  if (u === HOME) {
    const body = COLLECTIONS.map(
      (c) => `<d:response><d:href>${c.href}</d:href><d:propstat><d:prop>
        <d:displayname>${c.name}</d:displayname>
        <c:supported-calendar-component-set>${c.comps
          .map((x) => `<c:comp name="${x}"/>`)
          .join('')}</c:supported-calendar-component-set>
      </d:prop></d:propstat></d:response>`,
    ).join('');
    return xml(207, body);
  }
  // Depth:1 PROPFIND on a collection -> its children with mtimes. This is what
  // collectionStats() reads, and activity is the only thing that separates a
  // live reminder list from a zombie one.
  if (init.method === 'PROPFIND' && u.startsWith(`${SHARD}/123456/calendars/`)) {
    const slug = u.slice(`${SHARD}/123456/calendars/`.length).replace(/\/$/, '');
    const items = CHILDREN[slug] ?? [];
    const body = [
      `<d:response><d:href>${new URL(u).pathname}</d:href><d:propstat><d:prop><d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`,
      ...items.map(
        (it) =>
          `<d:response><d:href>${new URL(it.href, SHARD).pathname}</d:href><d:propstat><d:prop><d:getlastmodified>${it.mtime}</d:getlastmodified></d:prop></d:propstat></d:response>`,
      ),
    ].join('');
    return xml(207, body);
  }
  // calendar-query REPORT -> listTodos(): every VTODO with its ICS inline.
  if (init.method === 'REPORT' && u.startsWith(`${SHARD}/123456/calendars/`)) {
    const slug = u.slice(`${SHARD}/123456/calendars/`.length).replace(/\/$/, '');
    const items = CHILDREN[slug] ?? [];
    const body = items
      .map(
        (it) =>
          `<d:response><d:href>${new URL(it.href, SHARD).pathname}</d:href><d:propstat><d:prop>` +
          `<d:getetag>"${it.uid}-etag"</d:getetag>` +
          `<c:calendar-data>${icsFor(it)}</c:calendar-data>` +
          '</d:prop></d:propstat></d:response>',
      )
      .join('');
    return xml(207, body);
  }
  // GET one resource -> its ICS body.
  if (init.method === 'GET' && /\/calendars\/[a-z]+\/[a-z]+\.ics$/.test(u)) {
    const slug = u.match(/calendars\/([a-z]+)\//)[1];
    const uid = u.split('/').pop().replace('.ics', '');
    const it = (CHILDREN[slug] ?? []).find((x) => x.uid === uid);
    if (!it) return textRes(404, 'no');
    return textRes(200, icsFor(it));
  }
  if (init.method === 'DELETE' && u.startsWith(`${SHARD}/123456/calendars/`)) {
    return textRes(204, '');
  }
  if (init.method === 'PUT' && u.startsWith(`${SHARD}/123456/calendars/`)) {
    return textRes(201, '');
  }
  return textRes(404, 'not found');
}
function xml(status, body) {
  return {
    status,
    ok: status < 400,
    text: async () =>
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">${body}</d:multistatus>`,
  };
}
function textRes(status, body) {
  return { status, ok: status < 400, text: async () => body };
}

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;

const CONFIG = {
  appleId: 'ops@example.com',
  appPassword: 'abcd-efgh-ijkl-mnop',
  caldavUrl: 'https://caldav.icloud.com/',
  carddavUrl: 'https://contacts.icloud.com/',
  reminderList: 'Reminders',
  timeoutMs: 5000,
};

// ------------------------------------------------------------- stub cordis ctx
const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  logger: { warn: (m) => calls.push({ warn: m }) },
};

// ------------------------------------------------------------------- run tests
plugin.apply(ctx, CONFIG);

const byName = (n) => registered.find((t) => t.name === n);
const add = byName('reminder_add');
const lists = byName('reminder_lists');
const contactAdd = byName('contact_add');
const contactList = byName('contact_list');
const contactRemove = byName('contact_remove');
const targets = byName('apple_targets');
const remove = byName('reminder_remove');
const removeMany = byName('reminder_remove_many');
const listItems = byName('reminder_list_items');
const addMany = byName('reminder_add_many');
const update = byName('reminder_update');

const EXPECTED_TOOLS = [
  'reminder_add',
  'reminder_add_many',
  'reminder_lists',
  'reminder_list_items',
  'reminder_remove',
  'reminder_remove_many',
  'reminder_update',
  'contact_add',
  'contact_list',
  'contact_remove',
  'apple_targets',
];
assert.deepEqual(registered.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort(), 'every tool registered');
assert.ok(plugin.name && plugin.inject.includes('tools'), 'cordis metadata present');

// 1. discovery + VTODO filtering
const out = await lists.execute({}, {});
assert.equal(out.reachable, true);
assert.deepEqual(
  out.lists.filter((l) => l.vtodos === 'yes').map((l) => l.name).sort(),
  ['Reminders', 'Work'],
  'VEVENT-only calendar filtered out',
);
assert.ok(calls[0].headers.Authorization.startsWith('Basic '), 'sends HTTP Basic auth');

// 1b. activity stats: the only signal that tells a live reminder list from a zombie.
const homeList = out.lists.find((l) => l.name === 'Reminders');
const workList = out.lists.find((l) => l.name === 'Work');
assert.equal(homeList.count, 4, 'child count read from a Depth:1 PROPFIND');
assert.match(homeList.newest, /2025/, 'live list reports a recent mtime');
assert.equal(workList.count, 1);
assert.match(workList.newest, /2023/, 'zombie list reports its stale mtime');
assert.equal(out.lists.find((l) => l.name === 'Personal').count, null, 'event-only calendar is not measured');

// 2. create a reminder with a due date-time and an alarm
const created = await add.execute(
  { title: '交房租', notes: '不要在 12 点后才想起', due: '2026-11-12T09:00:00+08:00', list: 'Reminders', priority: 1, alarm: '15m' },
  {},
);
assert.equal(created.ok, true);
assert.equal(created.list, 'Reminders');
assert.equal(created.alarm, '-PT15M', 'alarm echoed in normalized form');

const put = calls.filter((c) => c.method === 'PUT').at(-1);
assert.ok(put.url.endsWith(`${created.uid}.ics`), 'PUT targets <uid>.ics in the collection');
assert.match(put.url, /\/calendars\/home\//, 'PUT lands in the chosen list');
const ics = put.body;
assert.match(ics, /^BEGIN:VCALENDAR\r\n/, 'CRLF folded VCALENDAR');
assert.match(ics, /BEGIN:VTODO/);
assert.match(ics, new RegExp(`UID:${created.uid}`));
assert.match(ics, /SUMMARY:交房租/, 'non-ASCII title kept raw');
assert.match(ics, /DUE:20261112T010000Z/, 'due converted to UTC');
assert.match(ics, /PRIORITY:1/);
assert.match(ics, /STATUS:NEEDS-ACTION/);
assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:交房租\r\nTRIGGER:-PT15M\r\nEND:VALARM/);
assert.ok(!/\n/.test(ics.replace(/\r\n/g, '')), 'no bare LF inside the object');
assert.ok(ics.endsWith('END:VCALENDAR\r\n'));

// 3. all-day reminder
const allday = await add.execute({ title: '续签护照', due: '2026-12-01' }, {});
assert.equal(allday.list, 'Reminders', 'defaults to the configured list');
const alldayIcs = calls.filter((c) => c.method === 'PUT').at(-1).body;
assert.match(alldayIcs, /DUE;VALUE=DATE:20261201/, 'date-only becomes VALUE=DATE');

// 3a. alarm spellings
assert.equal(alarmTrigger('15m'), '-PT15M');
assert.equal(alarmTrigger('2h'), '-PT2H');
assert.equal(alarmTrigger('1d'), '-P1D');
assert.equal(alarmTrigger('0'), 'PT0S');
assert.equal(alarmTrigger('-PT30M'), '-PT30M');
assert.throws(() => alarmTrigger('soon'), /无法解析的提醒时间/);

// 3b. contacts channel: write, read, delete
const contactResult = await contactAdd.execute(
  { name: '张三', phone: '+8613800138000, +861012345678', email: 'z@x.com', org: '某公司' },
  {},
);
assert.equal(contactResult.ok, true);
assert.equal(contactResult.book, '通讯录', 'slug mapped to a readable book name');
const contactPut = calls.filter((c) => c.method === 'PUT').at(-1);
assert.ok(contactPut.url.startsWith(`${CONTACT_CARD}`), 'PUT lands in the CardDAV home');
assert.match(contactPut.headers['Content-Type'], /text\/vcard/);
const vcf = contactPut.body;
assert.match(vcf, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/, 'vCard 3.0');
assert.match(vcf, /\r\nFN:张三\r\n/);
assert.match(vcf, /\r\nN:张三;;;;\r\n/);
assert.equal((vcf.match(/TEL;TYPE=CELL:/g) ?? []).length, 2, 'comma-separated phones split');

const contactSearch = await contactList.execute({ query: '张' }, {});
assert.equal(contactSearch.matched, 2, 'substring search finds both 张三 rows');
assert.deepEqual(contactSearch.contacts.map((c) => c.uid).sort(), ['AAAA', 'CCCC']);
assert.equal(contactSearch.contacts[0].phones.length > 0, true, 'phone numbers are parsed back');

const rejectedRemove = await contactRemove.execute({ name: '张三' }, {}).catch((e) => e.message);
assert.match(rejectedRemove, /匹配到 2 位联系人/, 'ambiguous contact name is refused, never guessed');
const removedContact = await contactRemove.execute({ uid: 'BBBB' }, {});
const contactDelete = calls.filter((c) => c.method === 'DELETE').at(-1);
assert.match(contactDelete.url, /BBBB\.vcf$/, 'DELETE targets the uid it resolved');

// 3c. reminder_remove: an ambiguous title must be refused, a uid must resolve
await assert.rejects(() => remove.execute({ title: '买牙膏' }, {}), /匹配到 2 条/, 'ambiguous title refused');
const removed = await remove.execute({ uid: 'aaaa' }, {});
assert.equal(removed.removed.length, 1);
assert.equal(removed.removed[0].title, '交房租', 'uid resolved to the right reminder');
assert.equal(removed.removed[0].list, 'Reminders');
const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/calendars/'));
assert.equal(deletes.filter((d) => d.url.endsWith('/aaaa.ics')).length, 1, 'exactly one DELETE for the resolved href');

// 3c2. reminder_remove_many: batch undo with the same ambiguity rule
const batchRemove = await removeMany.execute({ uids: ['bbbb', 'nope'], titles: ['买牙膏'] }, {});
assert.equal(batchRemove.removed.length, 1, 'the resolvable uid is deleted');
assert.deepEqual(batchRemove.notFound, ['nope'], 'unknown uid reported, not fatal');
assert.equal(batchRemove.failed.length, 1, 'ambiguous title reported as failed');
assert.match(batchRemove.failed[0].error, /匹配 2 条/);
assert.equal(batchRemove.ok, false, 'partial failure is not ok');

// 3d. reminder_list_items: read path, folded titles, floating due, alarm flag
const longTitle = '一条被服务端折行的长标题，用来确认读回时不会只剩第一段';
const items = await listItems.execute({ query: '折行' }, {});
assert.equal(items.matched, 1, 'substring query still matches a folded title');
assert.equal(items.items[0].title, longTitle, 'folded SUMMARY is unfolded before parsing (no truncation)');
assert.equal(items.items[0].due, '2025-11-13 21:00', 'floating DUE is echoed as-is, not shifted by the UTC offset');
assert.equal(items.items[0].alarm, true, 'VALARM presence is reported');
const all = await listItems.execute({}, {});
assert.equal(all.matched, 4, 'no filter returns every unfinished item');
assert.equal(all.items.filter((i) => i.alarm).length, 1, 'only the fixture with a VALARM is flagged');

// 3d2. timezone rendering: Z is an instant, no-Z is a wall clock
const zItem = await add.execute({ title: '带 Z 的', due: '2026-11-12T09:00:00+08:00' }, {});
assert.ok(zItem.uid);

// 3e. reminder_update: patch on a FOLDED body must not concatenate old tails
const folded = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTODO',
  'UID:zzzz',
  `SUMMARY:${foldAt(`SUMMARY:${longTitle}`, 46).replace(/^SUMMARY:/, '')}`,
  'STATUS:NEEDS-ACTION',
  'DUE:20251113T210000',
  'END:VTODO',
  'END:VCALENDAR',
  '',
].join('\r\n');
assert.equal(hasAlarm(folded), false);
const renamed = patchVCalendar(folded, { title: '新标题' });
const logical = renamed.replace(/\r\n[ \t]/g, '');
assert.match(logical, /^SUMMARY:新标题$/m, 'rename replaces the whole folded property, no old tail survives');
assert.doesNotMatch(logical, /确认读回时不会只剩第一段/, 'no fragment of the old title is left behind');

const alarmed = patchVCalendar(folded, { alarm: '1h' });
// The DESCRIPTION inside the alarm is itself folded at 75 octets; unfold before
// asserting on the logical content line.
assert.match(
  alarmed.replace(/\r\n[ \t]/g, ''),
  /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:一条被服务端折行的长标题，用来确认读回时不会只剩第一段\r\nTRIGGER:-PT1H\r\nEND:VALARM/,
);
const cleared = patchVCalendar(alarmed, { alarm: null });
assert.equal(hasAlarm(cleared), false, 'clear_alarm removes the whole VALARM block');

// 3e2. component-scoped patching: DESCRIPTION is legal inside VALARM too, so a
//      note edit must not reach the alarm's notification text and vice versa.
const withAlarm = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTODO',
  'UID:a1',
  'SUMMARY:吃药',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:该吃药了',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VTODO',
  'END:VCALENDAR',
  '',
].join('\r\n');
const noted = patchVCalendar(withAlarm, { notes: '新备注' }).replace(/\r\n[ \t]/g, '');
assert.equal((noted.match(/^DESCRIPTION:/gm) ?? []).length, 2, 'two DESCRIPTION lines: one VTODO, one VALARM');
assert.match(noted, /^DESCRIPTION:新备注$/m, 'the new note lands on the VTODO');
assert.match(noted, /^DESCRIPTION:该吃药了$/m, 'the alarm keeps its own notification text');
assert.ok(
  noted.indexOf('DESCRIPTION:新备注') < noted.indexOf('BEGIN:VALARM'),
  'the VTODO note is written before the sub-component, not into it',
);
const clearedNotes = patchVCalendar(withAlarm, { notes: null }).replace(/\r\n[ \t]/g, '');
assert.match(clearedNotes, /^DESCRIPTION:该吃药了$/m, 'clear_notes must leave the alarm body alone');
assert.equal((clearedNotes.match(/^DESCRIPTION:/gm) ?? []).length, 1, 'only the alarm DESCRIPTION survives');

// 3e3. a new property is inserted before the first sub-component, never after it
const withDue = patchVCalendar(withAlarm, { due: '2026-12-01' }).replace(/\r\n[ \t]/g, '');
assert.doesNotMatch(
  withDue,
  /END:VALARM\r\n(?!END:)[A-Z][A-Z0-9-]*[;:]/,
  'no VTODO property may follow END:VALARM',
);
assert.ok(withDue.indexOf('DUE;VALUE=DATE:20261201') < withDue.indexOf('BEGIN:VALARM'), 'DUE sits with the VTODO properties');

// 3e4. completing a reminder writes the status and the completion stamp together
const completed = patchVCalendar(withAlarm, { status: 'COMPLETED' }).replace(/\r\n[ \t]/g, '');
assert.match(completed, /^STATUS:COMPLETED$/m);
assert.match(completed, /^COMPLETED:\d{8}T\d{6}Z$/m, 'a completion timestamp accompanies the status');
const reopened = patchVCalendar(completed, { status: 'NEEDS-ACTION' }).replace(/\r\n[ \t]/g, '');
assert.doesNotMatch(reopened, /^COMPLETED:/m, 're-opening clears the completion stamp');

const updated = await update.execute({ uid: 'zzzz', new_title: '交房租（改）', new_due: '2026-12-01' }, {});
assert.equal(updated.title, '交房租（改）');
const updPut = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/zzzz.ics')).at(-1);
assert.match(updPut.body, /SUMMARY:交房租（改）/);
assert.match(updPut.body, /DUE;VALUE=DATE:20261201/);
assert.match(updPut.body, /BEGIN:VALARM/, 'VALARM survives: update must not rebuild the resource');
assert.equal(updPut.headers['If-Match'], '"zzzz-etag"', 'conditional write on the etag just read');

// 3f. reminder_add_many: skip_existing keys on title + due day
const batch = await addMany.execute(
  {
    items: [
      { title: '甲', due: '2026-12-01' },
      { title: '甲', due: '2026-12-01' }, // same title, same day -> skipped
      { title: '甲', due: '2026-12-08' }, // same title, other week -> created
      { title: '乙' },
    ],
    skip_existing: true,
  },
  {},
);
assert.equal(batch.created.length, 3, 'same title on a different day is not treated as a duplicate');
assert.equal(batch.skipped.length, 1, 'the repeat within the batch is skipped');
assert.equal(batch.failed.length, 0);

// 3g. apple_targets reports both channels independently, and no phantom third channel
const targetReport = await targets.execute({}, {});
assert.equal(targetReport.reminders.ok, true);
assert.equal(targetReport.contacts.ok, true);
assert.equal('notes' in targetReport, false, 'no unimplemented channel is advertised');
assert.ok(targetReport.contacts.targets.length >= 1);

// 4. escaping
assert.equal(escapeText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');

// 5. unknown list is a clear error
await assert.rejects(() => add.execute({ title: 'x', list: 'Nope' }, {}), /not found.*candidates/i);

// 6. no configured default + several lists -> ambiguous, never silently guessed
const clientNoDefault = new RemindersClient({
  username: CONFIG.appleId,
  password: CONFIG.appPassword,
  baseUrl: CONFIG.caldavUrl,
  timeoutMs: 5000,
});
await assert.rejects(
  () => clientNoDefault.createTodo({ title: 'x' }),
  (err) => {
    assert.match(err.message, /必须显式指定 list/);
    assert.match(err.message, /4 条，最后活动 2025-11-11/, 'live list shown with count + mtime');
    assert.match(err.message, /1 条，最后活动 2023-05-02/, 'zombie list shown with count + mtime');
    return true;
  },
);

// 7. auth failures surface actionable text
globalThis.fetch = async () => textRes(401, 'denied');
await assert.rejects(() => lists.execute({}, {}), /app-specific password/i);
globalThis.fetch = async () => textRes(403, 'denied');
await assert.rejects(() => lists.execute({}, {}), /app-specific password/i);

// 7b. a REPORT that fails is an auth problem, not "this reminder does not exist".
//     Swallowing it would tell a user with an expired app password that their
//     reminder is gone.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://caldav.icloud.com/') {
    return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${new URL(PRINCIPAL).pathname}</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
  }
  if (u === PRINCIPAL) {
    return xml(207, `<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
  }
  if (u === HOME) {
    return xml(207, `<d:response><d:href>/123456/calendars/home/</d:href><d:propstat><d:prop><d:displayname>Reminders</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`);
  }
  return textRes(401, 'denied');
};
await assert.rejects(
  () => remove.execute({ uid: 'zzzz' }, {}),
  /App 专用密码/,
  'an unreadable collection reports the real cause, not "not found"',
);
await assert.rejects(() => update.execute({ uid: 'zzzz', new_title: 'x' }, {}), /App 专用密码/);

// 7c. the tool call's own deadline must reach the transport: an aborted signal
//     means the request is never even sent, not that it quietly completes.
{
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => add.execute({ title: 'x' }, { signal: controller.signal }),
    /cancelled/i,
    'an aborted exec.signal cancels the HTTP work instead of being ignored',
  );
}

// 7d. transport failures are retried; a real answer is not.
//     A live acceptance run lost the 8th request of a burst to "fetch failed"
//     and succeeded on retry — that resilience has to stay.
{
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (calls <= 3) throw new TypeError('fetch failed');
    const u = String(url);
    if (u.includes('/principal')) {
      return xml(207, `<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
    }
    return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${new URL(PRINCIPAL).pathname}</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
  };
  const flaky = new RemindersClient({
    username: CONFIG.appleId,
    password: CONFIG.appPassword,
    baseUrl: 'https://caldav.icloud.com/',
    timeoutMs: 5000,
  });
  const principal = await flaky.discoverHome();
  assert.ok(principal, 'a dropped connection is retried until it answers');
  assert.ok(calls >= 4, 'the retry actually happened');

  let denied = 0;
  globalThis.fetch = async () => {
    denied += 1;
    return textRes(401, 'denied');
  };
  const strict = new RemindersClient({
    username: CONFIG.appleId,
    password: CONFIG.appPassword,
    baseUrl: 'https://caldav.icloud.com/',
    timeoutMs: 5000,
  });
  await assert.rejects(() => strict.discoverHome(), /app-specific password/i);
  assert.equal(denied, 1, '401 is an answer: it must not be retried (no account lockout risk)');
}


globalThis.fetch = async (url) => {
  if (String(url) === 'https://caldav.icloud.com/') return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${new URL(PRINCIPAL).pathname}</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
  if (String(url) === PRINCIPAL) return xml(207, `<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
  return xml(207, `<d:response><d:href>/123456/calendars/personal/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`);
};
await assert.rejects(() => add.execute({ title: 'x' }, {}), /no collection on this account accepts VTODO/);

// 8a. server publishes NO component set: unknown, never yes
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://caldav.icloud.com/') return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${new URL(PRINCIPAL).pathname}</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
  if (u === PRINCIPAL) return xml(207, `<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
  if (u === HOME) return xml(207, `<d:response><d:href>/123456/calendars/jia/</d:href><d:propstat><d:prop><d:displayname>家庭</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`);
  if (init.method === 'PUT') return textRes(201);
  return textRes(404);
};
const bare = await lists.execute({}, {});
assert.equal(bare.lists.length, 1, 'one collection listed');
assert.equal(bare.lists[0].vtodos, 'unknown', 'unpublished component set is unknown, not yes');
assert.equal(bare.reachable, false, 'reachable means confirmed, so unknown does not count');
assert.equal(bare.unverifiedCount, 1);
const bareWrite = await add.execute({ title: '试写', list: '家庭' }, {});
assert.equal(bareWrite.vtodoDeclared, false, 'write to an undeclared collection is flagged');

// 8b. 507 (iCloud over quota) must say so
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://caldav.icloud.com/') return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${new URL(PRINCIPAL).pathname}</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
  if (u === PRINCIPAL) return xml(207, `<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
  if (u === HOME) return xml(207, `<d:response><d:href>/123456/calendars/home/</d:href><d:propstat><d:prop><d:displayname>Reminders</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`);
  return textRes(507, 'insufficient storage');
};
await assert.rejects(() => add.execute({ title: 'x', list: 'Reminders' }, {}), /storage quota|insufficient storage/i);

// 8c. mainland-China shard: a network failure on .icloud.com retries .icloud.com.cn
//     and keeps the discovered region for every later request.
{
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('https://caldav.icloud.com/') && !u.includes('.com.cn')) {
      throw new TypeError('fetch failed');
    }
    const cn = u.replace('.icloud.com', '.icloud.com.cn');
    if (u === 'https://caldav.icloud.com.cn/') {
      return xml(207, `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/p/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
    }
    if (u === 'https://caldav.icloud.com.cn/p/') {
      return xml(207, `<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>https://p42-caldav.icloud.com/123/calendars/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
    }
    if (u === 'https://p42-caldav.icloud.com.cn/123/calendars/') {
      return xml(207, `<d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:displayname>任务</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>`);
    }
    if (init.method === 'PROPFIND') {
      return xml(207, `<d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:getlastmodified>Wed, 12 Nov 2025 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`);
    }
    if (init.method === 'PUT') return textRes(201, '');
    return textRes(404, `unexpected ${cn}`);
  };
  const cnClient = new RemindersClient({
    username: CONFIG.appleId,
    password: CONFIG.appPassword,
    baseUrl: 'https://caldav.icloud.com/',
    timeoutMs: 5000,
  });
  const home = await cnClient.discoverHome();
  assert.match(home, /p42-caldav/, 'home set points at the account shard');
  assert.equal(cnClient.region, 'cn', 'region is remembered for later requests');
  const cnLists = await cnClient.listCollections();
  assert.equal(cnLists.length, 1);
  assert.equal(cnLists[0].name, '任务');
  assert.ok(
    seen.filter((u) => u.startsWith('https://p42')).every((u) => u.includes('.com.cn')),
    'every request after discovery uses the regional domain',
  );
}

globalThis.fetch = realFetch;

// 9. builders are usable standalone
const solo = buildVCalendar({ uid: 'u1', title: 'T', due: '2026-01-02T03:04:05Z' });
assert.match(solo, /DUE:20260102T030405Z/);
assert.deepEqual(toIcalDate('2026-01-02'), {
  property: 'DUE;VALUE=DATE',
  value: '20260102',
  resolved: '2026-01-02',
});
assert.match(buildVCalendar({ uid: 'u2', title: 'T', alarm: '30m' }), /TRIGGER:-PT30M/);

// 10. folding keeps every line within 75 octets
const long = buildVCalendar({ uid: 'u3', title: '标'.repeat(80) });
for (const line of long.split('\r\n')) {
  assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${Buffer.byteLength(line, 'utf8')}`);
}

// 11. every tool's output must satisfy its own schema and render without throwing.
//     execute() alone skips both steps — they live in the runtime, so a broken
//     render or an extra key would only surface in the UI.
{
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
  const samples = [
    [add, created],
    [lists, out],
    [listItems, all],
    [remove, removed],
    [removeMany, batchRemove],
    [update, updated],
    [addMany, batch],
    [contactAdd, contactResult],
    [contactList, contactSearch],
    [contactRemove, removedContact],
    [targets, targetReport],
  ];
  for (const [tool, value] of samples) {
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value');
    assert.deepEqual(violations, [], `${tool.name} output violates its declared schema`);
    const blocks = tool.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name} render returned no blocks`);
    assert.ok(
      blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string'),
      `${tool.name} render returned a non-text block`,
    );
  }
}

console.log('ALL TESTS PASSED');
console.log('tools:', registered.map((t) => t.name).join(', '));
console.log('requests made:', calls.filter((c) => c.url).length);
