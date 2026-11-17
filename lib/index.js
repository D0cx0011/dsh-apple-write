/**
 * dsh-apple-write — write into Apple apps on the user's iPhone from DSH.
 *
 * One credential pair (Apple ID + app-specific password) unlocks every channel,
 * because that password is the whole iCloud DAV entry point, not a per-app one:
 *
 *   CalDAV  →  Reminders (VTODO)      caldav.js
 *   CardDAV →  Contacts  (vCard 3.0)  carddav.js
 *   IMAP    →  Notes     (planned)    imap.js
 *
 * Cordis plugin contract (mirrors @deepseek-ai/dsh-tool-todo):
 *   export const name / inject / Config / apply(ctx, config)
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  RemindersClient,
  CalDAVError,
  STALE_LIST_DAYS,
  patchVCalendar,
  toIcalDate,
  alarmTrigger,
} from './caldav.js';
import { ContactsClient, CardDAVError } from './carddav.js';
import { WebDAVError } from './shared.js';

export const name = 'apple-write';

/** `tools` supplies the registry. */
export const inject = ['tools'];

export const Config = z.object({
  appleId: z.string().required().description('Apple ID e-mail (or a self-hosted DAV account name)'),
  appPassword: z.string().description('App-specific password (xxxx-xxxx-xxxx-xxxx); prefer appPasswordEnv'),
  appPasswordEnv: z
    .string()
    .description('Name of the environment variable holding the password; wins over appPassword'),

  caldavUrl: z.string().description('CalDAV root; default https://caldav.icloud.com/'),
  carddavUrl: z.string().description('CardDAV root; default https://contacts.icloud.com/'),

  reminderList: z.string().description('Reminder list used when a call omits `list`'),
  contactsBook: z.string().description('Address book name; empty = the account\'s primary book'),

  enableReminders: z.boolean().description('Register the reminder tools (default true)'),
  enableContacts: z.boolean().description('Register the contact tools (default true)'),

  timeoutMs: z.number().description('Per-request timeout in ms (default 20000)'),
});

const DEFAULT_CALDAV = 'https://caldav.icloud.com/';
const DEFAULT_CARDDAV = 'https://contacts.icloud.com/';

/** Resolve the password at call time so an env var set after boot still works. */
function passwordFor(config) {
  if (config.appPasswordEnv) {
    const value = process.env[config.appPasswordEnv];
    if (!value) {
      throw new Error(
        `环境变量 ${config.appPasswordEnv} 是空的或不存在。请设置它，或在插件配置里直接填 appPassword。`,
      );
    }
    return value;
  }
  if (config.appPassword) return config.appPassword;
  throw new Error('没有可用的口令：请配置 appPassword 或 appPasswordEnv。');
}

function remindersClientFor(config, signal) {
  return new RemindersClient({
    username: config.appleId,
    password: passwordFor(config),
    baseUrl: config.caldavUrl || DEFAULT_CALDAV,
    timeoutMs: config.timeoutMs ?? 20000,
    signal,
  });
}

function contactsClientFor(config, signal) {
  return new ContactsClient({
    username: config.appleId,
    password: passwordFor(config),
    baseUrl: config.carddavUrl || DEFAULT_CARDDAV,
    timeoutMs: config.timeoutMs ?? 20000,
    signal,
  });
}

const CALDAV_HINT =
  '已实测确认：CalDAV 读写的提醒列表和 iPhone 提醒事项 app 看到的是同一批——写入 Reminders 列表后手机上直接出现。' +
  '所以「写入成功但手机上找不到」几乎总是选错了列表：真实账号常有同名或同协议的僵尸列表，' +
  '那是 Reminders→CloudKit 迁移的遗留物，iOS 只把它当日历显示。用 reminder_lists 看条目数和最后活动时间，' +
  '停在几年前的别碰。';

const AUTH_HINT =
  '口令和协议要分清：这里必须用 appleid.apple.com 生成的 App 专用密码（19 位、四个连字符），' +
  '不是 Apple ID 登录密码。DAV 层没有 2FA 通道，主密码一定被拒。';

/**
 * Translate one protocol failure into a tool failure, keeping `status` so a
 * caller (or a future policy layer) can still tell auth from conflict from
 * quota. CalDAVError and CardDAVError are the same class, so one check covers
 * both protocols.
 */
function wrap(err, extra) {
  if (!(err instanceof WebDAVError)) throw err;
  const hint = err.status === 401 || err.status === 403 ? AUTH_HINT : extra ?? '';
  const out = new Error(hint ? `${err.message}\n${hint}` : err.message);
  out.name = err.name;
  if (err.status !== undefined) out.status = err.status;
  if (err.body !== undefined) out.body = err.body;
  throw out;
}

/**
 * Decide which reminder list to write into — once, instead of leaving it to the
 * model on every call.
 *
 * Letting the agent re-derive this from activity stats had a blind spot: a
 * brand-new or empty list has no activity at all, so "pick the busiest list"
 * cannot tell it apart from a corpse. The configured list is the anchor — a human
 * confirmed it — and activity only decides when no configured list exists on this
 * account.
 *
 * @param {Array<{name: string, vtodos: string, count: number|null, newest: string|null}>} lists
 * @param {string} [configured]
 * @returns {{name: string, reason: string}|null}
 */
function pickRecommended(lists, configured) {
  const candidates = lists.filter((l) => l.vtodos !== 'no');
  if (candidates.length === 0) return null;

  if (configured) {
    const hit = candidates.find((l) => l.name.toLowerCase() === String(configured).toLowerCase());
    if (hit) return { name: hit.name, reason: '配置里的默认列表（人工确认过）' };
  }
  if (candidates.length === 1) {
    return { name: candidates[0].name, reason: '账号上唯一可写的提醒列表' };
  }
  const ranked = [...candidates].sort((a, b) => {
    const an = a.newest ? Date.parse(a.newest) : 0;
    const bn = b.newest ? Date.parse(b.newest) : 0;
    if (bn !== an) return bn - an;
    return (b.count ?? 0) - (a.count ?? 0);
  });
  const best = ranked[0];
  const bits = [];
  if (typeof best.count === 'number') bits.push(`${best.count} 条`);
  if (best.newest) bits.push(`最后活动 ${String(best.newest).slice(0, 10)}`);
  return {
    name: best.name,
    reason: bits.length ? `活跃度最高（${bits.join('，')}）` : '多个候选中条目最多',
  };
}

/**
 * iCalendar DATE / DATE-TIME → something a human can compare against the phone.
 *
 * Three shapes reach this function and they do NOT mean the same thing:
 *
 *   DUE;VALUE=DATE:20261113     all-day; there is no instant to convert
 *   DUE:20261113T130000Z        absolute UTC instant; render in local wall clock
 *   DUE:20261113T210000         floating wall clock — what iCloud actually stores
 *                               for reminders created on the phone
 *
 * The floating form must be echoed as-is. Running it through Date.UTC() and
 * then reading local getters shifts it by the machine's offset: a reminder due
 * at 21:00 local came back as 05:00 the next morning on a real account, because
 * the stored value carries no zone to convert from.
 */
function friendlyDue(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return value;
  const [, y, mo, d, hh, mi, , z] = m;
  if (!hh) return `${y}-${mo}-${d}`;
  if (!z) return `${y}-${mo}-${d} ${hh}:${mi}`;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi)));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

/**
 * Identity of one reminder for `skip_existing`: the title plus the DAY it is due
 * on. Title alone was wrong in both directions — two legitimate "交周报" rows for
 * different weeks collapsed into one, while a genuinely finished-plus-restarted
 * habit looked like a duplicate. Day granularity keeps the periodic-rerun case
 * (same list, same week, same titles) idempotent without merging different ones.
 *
 * Both sides are normalized to digits: an input "2026-11-12T09:00:00+08:00" and a
 * stored "20261112T010000Z" must land on the same key. Undated items key on the
 * title alone, which is why two undated "买牛奶" rows still dedupe.
 */
function dedupeKey(title, due) {
  const name = String(title ?? '').trim();
  if (!due) return `${name}\u0000`;
  const digits = String(due).replace(/^(\d{4})-(\d{2})-(\d{2}).*$/, '$1$2$3');
  return `${name}\u0000${digits.slice(0, 8)}`;
}

export function apply(ctx, config) {
  if (!config?.appleId) {
    ctx.logger?.warn?.('[apple-write] disabled: appleId not configured');
    return;
  }
  if (!config.appPassword && !config.appPasswordEnv) {
    ctx.logger?.warn?.('[apple-write] disabled: neither appPassword nor appPasswordEnv is set');
    return;
  }

  const remindersOn = config.enableReminders !== false;
  const contactsOn = config.enableContacts !== false;
  const timeout = Math.min(config.timeoutMs ?? 20000, 60000) + 5000;

  // ------------------------------------------------------------ reminders
  if (remindersOn) {
    ctx.tools.register(
      defineTool({
        name: 'reminder_add',
        description:
          `Target list: ${config.reminderList ? JSON.stringify(config.reminderList) : "the account's first writable list"} ` +
          '(already the live list; do not second-guess it). ' +
          "Add one item to the user's Apple Reminders on their iPhone. Writes a VTODO over CalDAV, " +
          'which the phone syncs within seconds. Use for errands, deadlines, and follow-ups the user asked ' +
          'to be reminded about. `due` accepts an ISO-8601 date-time ("2026-11-12T09:00:00+08:00") or a ' +
          'date-only string ("2026-11-12") for an all-day reminder. ' +
          'A date-time WITHOUT an offset is read as local time and echoed back with its resolved offset — ' +
          'check that echo if the user gave a wall-clock time.\n' +
          'OMIT `list` unless the user names a specific reminder list verbatim. The configured default is ' +
          'already the list the Reminders app shows. Wording such as "提醒" / "提醒事项" / "reminders" names ' +
          'the APP, not a list: translating it into a list called 「提醒」 has silently written into an ' +
          'abandoned list that iOS renders in Calendar instead of Reminders. If you truly need another ' +
          'list, call reminder_lists first and choose the entry with recent activity.',
        parameters: {
          title: { type: 'string', required: true, description: 'Short reminder title shown in the list.' },
          notes: { type: 'string', description: 'Optional body text.' },
          due: { type: 'string', description: 'ISO-8601 date-time, or YYYY-MM-DD for all-day.' },
          list: {
            type: 'string',
            description:
              'Only when the user names a specific list verbatim. Omit otherwise — the configured default is the live list.',
          },
          priority: {
            type: 'integer',
            enum: [0, 1, 5, 9],
            description: 'iCalendar PRIORITY: 0 none, 1 high, 5 medium, 9 low.',
          },
          alarm: {
            type: 'string',
            description:
              'Optional notification before the due time, e.g. "15m", "1h", "1d", or "0" to fire at the due ' +
              'moment. Omit for a silent reminder — a VTODO without VALARM shows in the list but never buzzes.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              uid: { type: 'string', required: true },
              list: { type: 'string', required: true },
              href: { type: 'string', required: true },
              due: { type: 'string' },
              vtodoDeclared: {
                type: 'boolean',
                required: true,
                description:
                  'The server declared this collection accepts VTODO. This is a protocol fact, NOT a promise ' +
                  'that the iPhone Reminders app renders the collection.',
              },
              listStale: {
                type: 'boolean',
                description: 'The target list looked abandoned when checked before writing (last activity > 90 days).',
              },
              listLastActivity: {
                type: 'string',
                description: 'ISO timestamp of the newest pre-existing item; only present when activity was sampled.',
              },
              alarm: {
                type: 'string',
                description: 'The TRIGGER that was written, e.g. "-PT15M"; only present when an alarm was requested.',
              },
            },
          },
          render: (_args, value) => {
            const lines = [
              `已加入提醒事项 → ${value.list}（uid ${value.uid}${value.due ? `，到期 ${value.due}` : ''}` +
                `${value.alarm ? `，${value.alarm} 提醒` : ''}）`,
            ];
            if (value.listStale) {
              lines.push(
                `⚠ 这个列表在写入前最后一次活动是 ${value.listLastActivity ? value.listLastActivity.slice(0, 10) : '很久以前'}。` +
                  '它很可能是 Reminders→CloudKit 迁移遗留的僵尸列表 —— iOS 只把它显示在日历里，' +
                  '提醒事项 app 看不到这条。用 reminder_lists 找出真正在用的列表后重写，并删掉这条。',
              );
            }
            if (value.vtodoDeclared === false) {
              lines.push(
                '注意：服务端没有声明该集合支持 VTODO。写入成功了，但要去 iPhone 上确认这条真的出现在列表里。',
              );
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          try {
            const created = await remindersClientFor(config, exec?.signal).createTodo(
              { title: args.title, notes: args.notes, due: args.due, priority: args.priority, alarm: args.alarm },
              { list: args.list || config.reminderList || undefined },
            );
            // Never emit `undefined`: an optional key that exists with an
            // undefined value fails DSH's lossless-JSON output check, so a
            // successful write of an undated reminder surfaced as
            // "invalid output" — the user saw an error for a write that landed.
            // Build the object conditionally instead of typing `due: undefined`.
            const out = {
              ok: true,
              uid: created.uid,
              list: created.list,
              href: created.href,
              vtodoDeclared: created.vtodoDeclared,
              listStale: created.stale,
            };
            if (args.due) out.due = created.dueResolved ?? args.due;
            if (args.alarm) out.alarm = created.alarmTrigger;
            if (created.activity?.newest) out.listLastActivity = created.activity.newest;
            return out;
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Add reminder: ${args.title}`,
          rawInput: args,
        }),
      }),
    );

    // Batch path: 30 items in one call instead of 30 round trips and 30 receipts.
    ctx.tools.register(
      defineTool({
        name: 'reminder_add_many',
        description:
          'Add several reminders in one call — prefer this over calling reminder_add N times. Writes ' +
          'sequentially into one list and reports created / skipped / failed SEPARATELY, so a partial ' +
          'failure never hides the items that did land. Pass skip_existing to make the call idempotent: an ' +
          'unfinished item with the same title AND the same due moment is skipped instead of duplicated, ' +
          'which is what makes a periodic re-run safe without collapsing "交周报（本周）" into "交周报（下周）".',
        parameters: {
          items: {
            type: 'array',
            required: true,
            description: 'Array of objects: {title (required), due?, notes?, priority?, alarm?}.',
            // A per-item schema, not a bare array: the model's arguments are the
            // only description of what it meant to write, so a typo ("titel")
            // must fail at the call boundary instead of becoming 30 separate
            // "title 为空" rows.
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                notes: { type: 'string' },
                due: { type: 'string' },
                priority: { type: 'integer', enum: [0, 1, 5, 9] },
                alarm: { type: 'string' },
              },
            },
          },
          list: { type: 'string', description: 'Target list; defaults to the configured list.' },
          skip_existing: {
            type: 'boolean',
            description:
              'Skip unfinished items whose title AND due match an existing reminder (default false).',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const parts = [];
            if (value.listStale) {
              parts.push(
                '⚠ 目标列表在写入前已经很久没有活动，可能是僵尸列表 —— iOS 可能只在日历里显示这些条目。',
              );
            }
            parts.push(
              `${value.list}：新增 ${value.created.length} 条，跳过 ${value.skipped.length} 条，失败 ${value.failed.length} 条`,
            );
            if (value.skipped.length) {
              parts.push(`  跳过：${value.skipped.map((s) => s.title).join('、')}`);
            }
            if (value.failed.length) {
              parts.push(
                `  失败：${value.failed.map((f) => `${f.title}（${f.error}）`).join('、')}`,
              );
            }
            return [{ type: 'text', text: parts.join('\n') }];
          },
        },
        timeoutMs: Math.max(timeout, 120000),
        async execute(args, exec) {
          const items = Array.isArray(args.items) ? args.items : [];
          if (!items.length) throw new Error('items 不能为空。');
          try {
            const client = remindersClientFor(config, exec?.signal);
            const collection = await client.resolveCollection(args.list || config.reminderList || undefined);
            // Resolve the list and sample its activity ONCE for the whole batch —
            const activity = await client.collectionStats(collection.url).catch(() => null);
            const staleDays =
              activity?.newest != null
                ? Math.floor((Date.now() - Date.parse(activity.newest)) / 86_400_000)
                : null;

            let existing = null;
            if (args.skip_existing) {
              const todos = await client.listTodos(collection.url);
              existing = new Set(
                todos.filter((t) => !t.done).map((t) => dedupeKey(t.summary, t.due)),
              );
            }

            const created = [];
            const skipped = [];
            const failed = [];
            for (const item of items) {
              const title = String(item?.title ?? '').trim();
              if (!title) {
                failed.push({ title: '(空标题)', error: 'title 为空' });
                continue;
              }
              const key = dedupeKey(title, item.due);
              if (existing?.has(key)) {
                skipped.push({ title, reason: '已存在同名同到期日的未完成条目' });
                continue;
              }
              try {
                const res = await client.createTodo(
                  { title, notes: item.notes, due: item.due, priority: item.priority, alarm: item.alarm },
                  { collection, verifyActivity: false },
                );
                const row = { uid: res.uid, title };
                if (res.alarmTrigger) row.alarm = res.alarmTrigger;
                created.push(row);
                existing?.add(key);
              } catch (err) {
                failed.push({ title, error: err.message });
              }
            }

            return {
              ok: failed.length === 0,
              list: collection.name,
              created,
              skipped,
              failed,
              listStale: staleDays !== null && staleDays > STALE_LIST_DAYS,
            };
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Add ${Array.isArray(args.items) ? args.items.length : 0} reminders`,
          rawInput: args,
        }),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'reminder_lists',
        description:
          'List the reminder lists this account exposes over CalDAV — VTODO support, activity stats, and a ' +
          '`recommended` verdict. This is the reminders half of apple_targets: when reminders are all you ' +
          'need, this single call is enough and running apple_targets as well is redundant. Write into ' +
          '`recommended` and do not re-derive the choice from item counts or list names. Real iCloud ' +
          'accounts often carry a zombie list that also declares VTODO — an abandoned leftover of the ' +
          'Reminders→CloudKit migration that iOS renders as a calendar instead of in the Reminders app. ' +
          '`unknown` means the server published no component set at all, which only a write settles.',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const describe = (l) => {
              const bits = [];
              if (typeof l.count === 'number') bits.push(`${l.count} 条`);
              if (l.newest) bits.push(`最后活动 ${String(l.newest).slice(0, 16)}`);
              if (l.vtodos === 'unknown') bits.push('组件类型未公布');
              const mark = l.name === value.recommended ? ' ★' : '';
              return `${l.name}${mark}${bits.length ? `（${bits.join('，')}）` : ''}`;
            };
            const parts = [];
            if (value.recommended) {
              parts.push(`建议写入：${value.recommended}（${value.recommendedReason}）`);
            }
            const yes = value.lists.filter((l) => l.vtodos === 'yes');
            const unknown = value.lists.filter((l) => l.vtodos === 'unknown');
            parts.push(
              yes.length
                ? `已确认支持 VTODO：\n  ${yes.map(describe).join('\n  ')}`
                : '没有任何列表公布 VTODO 支持。',
            );
            if (unknown.length) {
              parts.push(`组件类型未公布（只能靠写一条验证）：\n  ${unknown.map(describe).join('\n  ')}`);
            }
            return [{ type: 'text', text: parts.join('\n') }];
          },
        },
        timeoutMs: timeout,
        async execute(_args, exec) {
          try {
            const client = remindersClientFor(config, exec?.signal);
            const home = await client.discoverHome();
            const lists = await client.listCollections();
            // Enrich only VTODO candidates — a pure event calendar's activity is
            // irrelevant, and skipping it keeps this at one request per list.
            const enriched = await Promise.all(
              lists.map(async (l) => {
                if (l.vtodos === 'no') return { ...l, count: null, newest: null };
                const stats = await client.collectionStats(l.url).catch(() => null);
                return { ...l, count: stats?.count ?? null, newest: stats?.newest ?? null };
              }),
            );
            const pick = pickRecommended(enriched, config.reminderList);
            return {
              calendarHome: home,
              recommended: pick?.name ?? null,
              recommendedReason: pick?.reason ?? null,
              lists: enriched,
              reachable: enriched.some((l) => l.vtodos === 'yes'),
              unverifiedCount: enriched.filter((l) => l.vtodos === 'unknown').length,
            };
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'List reminder lists' }),
      }),
    );

    // Read path. Without it the only way to learn whether "11.16 计算机网络 lab4"
    // already exists is to write it again — which is how a weekly re-run turns
    // one item into five.
    ctx.tools.register(
      defineTool({
        name: 'reminder_list_items',
        description:
          'Read the reminders already in a list — check before writing, or resolve a uid. Filters on a ' +
          'case-insensitive title substring, a due-date window, and completion state. Completed items are ' +
          'excluded by default because they pile up; pass includeCompleted to see them. Use this to avoid ' +
          'duplicates when re-running a batch, and to find the uid that reminder_update needs.',
        parameters: {
          list: { type: 'string', description: 'List to read; defaults to the configured list.' },
          query: { type: 'string', description: 'Case-insensitive substring match on the title.' },
          dueFrom: { type: 'string', description: 'YYYY-MM-DD inclusive lower bound on the due date.' },
          dueTo: { type: 'string', description: 'YYYY-MM-DD inclusive upper bound on the due date.' },
          includeCompleted: { type: 'boolean', description: 'Include completed reminders (default false).' },
          limit: { type: 'integer', description: 'Max items returned (default 100, max 500).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              list: { type: 'string', required: true },
              matched: { type: 'integer', required: true },
              total: { type: 'integer', required: true },
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uid: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    due: { type: 'string' },
                    done: { type: 'boolean', required: true },
                    alarm: {
                      type: 'boolean',
                      description: 'Whether the reminder carries a VALARM notification.',
                    },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            const head = `${value.list}：匹配 ${value.matched} 条 / 共 ${value.total} 条`;
            if (!value.items.length) return [{ type: 'text', text: `${head}（没有符合条件的条目）` }];
            const lines = value.items.map((it) => {
              const bits = [];
              if (it.due) bits.push(`到期 ${it.due}`);
              bits.push(it.alarm ? '有提醒' : '无提醒');
              if (it.done) bits.push('已完成');
              bits.push(`uid ${it.uid}`);
              return `  · ${it.title}（${bits.join('，')}）`;
            });
            const more = value.matched > value.items.length ? `\n  …还有 ${value.matched - value.items.length} 条未显示` : '';
            return [{ type: 'text', text: `${head}\n${lines.join('\n')}${more}` }];
          },
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          try {
            const client = remindersClientFor(config, exec?.signal);
            const collection = await client.resolveCollection(args.list || config.reminderList || undefined);
            const all = await client.listTodos(collection.url);
            const needle = args.query ? String(args.query).toLowerCase() : null;
            const from = args.dueFrom ? String(args.dueFrom).replace(/-/g, '') : null;
            const to = args.dueTo ? String(args.dueTo).replace(/-/g, '') : null;
            const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));

            const matched = all.filter((it) => {
              if (!args.includeCompleted && it.done) return false;
              if (needle && !(it.summary ?? '').toLowerCase().includes(needle)) return false;
              if (from && (!it.due || it.due.slice(0, 8) < from)) return false;
              if (to && (!it.due || it.due.slice(0, 8) > to)) return false;
              return true;
            });
            // Undated items last: in a due-window read they carry the least signal.
            matched.sort((a, b) => {
              if (!a.due && !b.due) return (a.summary ?? '').localeCompare(b.summary ?? '');
              if (!a.due) return 1;
              if (!b.due) return -1;
              return a.due.localeCompare(b.due);
            });

            return {
              ok: true,
              list: collection.name,
              matched: matched.length,
              total: all.length,
              items: matched.slice(0, limit).map((it) => {
                const out = { uid: it.uid ?? '', title: it.summary ?? '', done: it.done };
                const friendly = friendlyDue(it.due);
                if (friendly) out.due = friendly;
                out.alarm = Boolean(it.alarm);
                return out;
              }),
            };
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'List reminders in a list' }),
      }),
    );

    // Undo path. Without this, a wrong-list write (or a typo'd title) can only be
    // repaired by hand on the phone — which is exactly the situation that made a
    // bad list pick so costly in the first place.
    ctx.tools.register(
      defineTool({
        name: 'reminder_remove',
        description:
          'Delete a reminder that was written by mistake. Match by `uid` (returned by reminder_add) or by ' +
          '`title` (exact SUMMARY match). Refuses to act when the match is ambiguous — a title matching ' +
          'several reminders is reported back rather than guessed. This is the repair path after writing ' +
          'into the wrong list.',
        parameters: {
          uid: { type: 'string', description: 'UID returned by reminder_add. Preferred: unambiguous.' },
          title: { type: 'string', description: 'Exact SUMMARY text of the reminder to delete.' },
          list: { type: 'string', description: 'List to search; defaults to all reminder lists.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              removed: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uid: { type: 'string' },
                    title: { type: 'string' },
                    list: { type: 'string' },
                    conditional: {
                      type: 'boolean',
                      description:
                        'Present as false when the server published no etag, so the delete could not detect a concurrent edit.',
                    },
                  },
                },
              },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.removed.length
                ? `已删除：${value.removed.map((r) => `${r.title || r.uid}（${r.list}）`).join('、')}`
                : '没有删除任何条目。',
            },
          ],
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          if (!args.uid && !args.title) {
            throw new Error('需要 uid 或 title 至少一个，否则无法定位要删除的那条。');
          }
          try {
            const client = remindersClientFor(config, exec?.signal);
            const collections = await client.listCollections();
            const targets = args.list
              ? [await client.resolveCollection(args.list)]
              : collections.filter((c) => c.vtodos !== 'no');

            const matches = [];
            // A collection whose REPORT fails must not be reported as "this
            // reminder does not exist". Keep the first error and, if nothing at
            // all could be read, surface that real cause instead of a wrong
            // "not found" — a stale credential otherwise looks like data loss.
            let listed = 0;
            let firstError = null;
            for (const collection of targets) {
              let todos;
              try {
                todos = await client.listTodos(collection.url);
                listed += 1;
              } catch (err) {
                firstError ??= err;
                continue;
              }
              for (const todo of todos) {
                const hit = args.uid
                  ? todo.uid === args.uid
                  : todo.summary === args.title;
                if (hit) matches.push({ ...todo, list: collection.name });
              }
            }
            if (listed === 0 && firstError) throw firstError;

            if (matches.length === 0) {
              throw new Error(
                `没有找到${args.uid ? ` uid=${args.uid}` : ` 标题精确等于 ${JSON.stringify(args.title)}`} 的提醒。` +
                  '标题是精确匹配，不做模糊匹配。',
              );
            }
            if (matches.length > 1) {
              const seen = matches.map((m) => `${m.summary}（${m.list}，uid ${m.uid}）`).join('；');
              throw new Error(
                `匹配到 ${matches.length} 条，无法确定删哪一条：${seen}。请改用 uid 精确指定。`,
              );
            }

            const only = matches[0];
            const gone = await client.deleteTodo(only.href, { etag: only.etag });
            const row = { uid: only.uid ?? '', title: only.summary ?? '', list: only.list };
            if (gone.conditional === false) row.conditional = false;
            return { ok: true, removed: [row] };
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Remove reminder: ${args.uid || args.title}`,
          rawInput: args,
        }),
      }),
    );

    // Batch undo. A single-call batch write needs a single-call batch repair —
    // otherwise cleaning up one bad 30-item batch means 30 separate tool calls,
    // each of which re-lists every collection.
    ctx.tools.register(
      defineTool({
        name: 'reminder_remove_many',
        description:
          'Delete several reminders in one call by uid (from reminder_add / reminder_list_items) or by exact ' +
          'title. Each title must resolve to exactly one reminder; an ambiguous title is reported as failed ' +
          'and nothing is deleted for it. Reports removed / notFound / failed separately, so a partial ' +
          'failure never hides what was deleted. This is the repair path for one bad reminder_add_many batch.',
        parameters: {
          uids: { type: 'array', description: 'uids to delete. Preferred: unambiguous.' },
          titles: { type: 'array', description: 'Exact SUMMARY strings to delete.' },
          list: { type: 'string', description: 'List to search; defaults to all reminder lists.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const parts = [`已删除 ${value.removed.length} 条`];
            if (value.notFound.length) parts.push(`  未找到：${value.notFound.join('、')}`);
            if (value.failed.length) {
              parts.push(`  失败：${value.failed.map((f) => `${f.key}（${f.error}）`).join('、')}`);
            }
            return [{ type: 'text', text: parts.join('\n') }];
          },
        },
        timeoutMs: Math.max(timeout, 120000),
        async execute(args, exec) {
          const uids = Array.isArray(args.uids) ? args.uids.filter((u) => typeof u === 'string' && u.trim()) : [];
          const titles = Array.isArray(args.titles)
            ? args.titles.filter((t) => typeof t === 'string' && t.trim())
            : [];
          if (!uids.length && !titles.length) {
            throw new Error('需要 uids 或 titles 至少一个非空数组，否则无法定位要删的条目。');
          }
          if (uids.length + titles.length > 200) {
            throw new Error('一次最多删除 200 条。分批调用，避免一次误删难以复核。');
          }
          try {
            const client = remindersClientFor(config, exec?.signal);
            const collections = await client.listCollections();
            const targets = args.list
              ? [await client.resolveCollection(args.list)]
              : collections.filter((c) => c.vtodos !== 'no');

            // One listing pass over the target collections, then resolve every
            // requested key locally — 30 deletes must not mean 30×N REPORTs.
            const byUid = new Map();
            const byTitle = new Map();
            let listed = 0;
            let firstError = null;
            for (const collection of targets) {
              let todos;
              try {
                todos = await client.listTodos(collection.url);
              } catch (err) {
                firstError ??= err;
                continue;
              }
              for (const todo of todos) {
                const row = { ...todo, list: collection.name };
                if (todo.uid) byUid.set(todo.uid, row);
                const list = byTitle.get(todo.summary) ?? [];
                list.push(row);
                byTitle.set(todo.summary, list);
              }
              listed += 1;
            }
            // Nothing readable at all is an auth/network/platform failure, not a
            // batch of 30 missing uids.
            if (listed === 0 && firstError) throw firstError;

            const removed = [];
            const notFound = [];
            const failed = [];
            const plan = [];
            for (const uid of uids) {
              const hit = byUid.get(uid);
              if (hit) plan.push({ key: uid, row: hit });
              else notFound.push(uid);
            }
            for (const title of titles) {
              const hits = byTitle.get(title) ?? [];
              if (hits.length === 0) notFound.push(title);
              else if (hits.length > 1) {
                failed.push({
                  key: title,
                  error: `标题匹配 ${hits.length} 条，改用 uid（${hits.map((h) => h.uid).join('/')}）`,
                });
              } else plan.push({ key: title, row: hits[0] });
            }

            for (const item of plan) {
              try {
                await client.deleteTodo(item.row.href, { etag: item.row.etag });
                removed.push({ uid: item.row.uid ?? '', title: item.row.summary ?? '', list: item.row.list });
              } catch (err) {
                failed.push({ key: item.key, error: err.message });
              }
            }

            return { ok: failed.length === 0, removed, notFound, failed };
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Remove ${(args.uids?.length ?? 0) + (args.titles?.length ?? 0)} reminders`,
          rawInput: args,
        }),
      }),
    );

    // Edit path. Delete-then-recreate leaves a window where the reminder does not
    // exist at all, and it loses anything this plugin does not model (alarms,
    // URLs, attachments) — patchVCalendar edits the resource in place instead.
    ctx.tools.register(
      defineTool({
        name: 'reminder_update',
        description:
          'Change fields of an existing reminder without recreating it. Locate with `uid` (preferred) or an ' +
          'exact `title`. Only the fields you pass change; everything else in the resource — alarms, notes, ' +
          'attachments, repetition — is preserved verbatim. Pass clear_due / clear_notes / clear_alarm to ' +
          'remove a value, and complete: true to mark it done. Runs a conditional write on the etag read ' +
          'moments earlier, so an edit made on the phone in between surfaces as a conflict instead of being ' +
          'overwritten.',
        parameters: {
          uid: { type: 'string', description: 'UID from reminder_add or reminder_list_items. Preferred.' },
          title: { type: 'string', description: 'Exact current SUMMARY, used to locate when uid is unknown.' },
          list: { type: 'string', description: 'List to search; defaults to all reminder lists.' },
          new_title: { type: 'string', description: 'Replacement title.' },
          new_due: { type: 'string', description: 'New due: YYYY-MM-DD for all-day, or ISO-8601 date-time.' },
          new_notes: { type: 'string', description: 'Replacement notes text.' },
          new_priority: { type: 'integer', enum: [0, 1, 5, 9], description: 'New iCalendar PRIORITY.' },
          new_alarm: {
            type: 'string',
            description: 'Replace the notification: "15m", "1h", "1d", or "0" for at the due moment.',
          },
          clear_due: { type: 'boolean', description: 'Remove the due date.' },
          clear_notes: { type: 'boolean', description: 'Remove the notes text.' },
          clear_alarm: { type: 'boolean', description: 'Remove the notification (VALARM).' },
          complete: { type: 'boolean', description: 'Mark the reminder completed.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              uid: { type: 'string', required: true },
              title: { type: 'string', required: true },
              list: { type: 'string', required: true },
              changed: { type: 'array', required: true },
              conditional: {
                type: 'boolean',
                description:
                  'Present as false when the server published no etag, so the write carried no If-Match and ' +
                  'could not detect a concurrent edit.',
              },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `已更新 ${value.title}（${value.list}）：${value.changed.join('、')}`,
            },
          ],
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          const changing = [
            args.new_title,
            args.new_due,
            args.new_notes,
            args.new_priority,
            args.new_alarm,
            args.clear_due,
            args.clear_notes,
            args.clear_alarm,
            args.complete,
          ].some((v) => v !== undefined);
          if (!changing) {
            throw new Error(
              '没有要改的字段：至少给 new_title / new_due / new_notes / new_priority / new_alarm / ' +
                'clear_due / clear_notes / clear_alarm / complete 之一。',
            );
          }
          try {
            const client = remindersClientFor(config, exec?.signal);
            const collections = await client.listCollections();
            const targets = args.list
              ? [await client.resolveCollection(args.list)]
              : collections.filter((c) => c.vtodos !== 'no');

            const matches = [];
            let listed = 0;
            let firstError = null;
            for (const collection of targets) {
              let todos;
              try {
                todos = await client.listTodos(collection.url);
                listed += 1;
              } catch (err) {
                firstError ??= err;
                continue;
              }
              for (const todo of todos) {
                const hit = args.uid ? todo.uid === args.uid : todo.summary === args.title;
                if (hit) matches.push({ ...todo, list: collection.name });
              }
            }
            if (listed === 0 && firstError) throw firstError;
            if (matches.length === 0) {
              throw new Error(
                `没有找到${args.uid ? ` uid=${args.uid}` : ` 标题精确等于 ${JSON.stringify(args.title)}`} 的提醒。`,
              );
            }
            if (matches.length > 1) {
              const seen = matches.map((m) => `${m.summary}（${m.list}，uid ${m.uid}）`).join('；');
              throw new Error(`匹配到 ${matches.length} 条，无法确定改哪一条：${seen}。请改用 uid。`);
            }

            const only = matches[0];
            const ics = await client.getTodo(only.href);

            const changes = {};
            const changed = [];
            if (args.new_title !== undefined) {
              changes.title = args.new_title;
              changed.push(`标题 → ${args.new_title}`);
            }
            if (args.new_due !== undefined) {
              changes.due = args.new_due;
              // Echo what it actually resolved to: an offset-less input is read in
              // local time, and silently shifting it is undetectable until the
              // phone is opened.
              const resolved = toIcalDate(args.new_due, {
                allDay: /^\d{4}-\d{2}-\d{2}$/.test(args.new_due),
              }).resolved;
              changed.push(`到期 → ${resolved}`);
            } else if (args.clear_due) {
              changes.due = null;
              changed.push('清除了到期日');
            }
            if (args.new_notes !== undefined) {
              changes.notes = args.new_notes;
              changed.push('备注已替换');
            } else if (args.clear_notes) {
              changes.notes = null;
              changed.push('清除了备注');
            }
            if (args.new_priority !== undefined) {
              changes.priority = args.new_priority;
              changed.push(`优先级 → ${args.new_priority}`);
            }
            if (args.new_alarm !== undefined) {
              changes.alarm = args.new_alarm;
              changed.push(`提醒 → ${alarmTrigger(args.new_alarm)}`);
            } else if (args.clear_alarm) {
              changes.alarm = null;
              changed.push('清除了提醒');
            }
            if (args.complete === true) {
              changes.status = 'COMPLETED';
              changed.push('标记完成');
            } else if (args.complete === false) {
              changes.status = 'NEEDS-ACTION';
              changed.push('重新标记未完成');
            }

            const next = patchVCalendar(ics, changes);
            const written = await client.updateTodo(only.href, next, { etag: only.etag });
            const out = {
              ok: true,
              uid: only.uid ?? '',
              title: args.new_title ?? only.summary ?? '',
              list: only.list,
              changed,
            };
            // Only present when the server sent no etag, i.e. the write could not
            // detect a concurrent edit. Silence there would overstate the guard.
            if (written.conditional === false) out.conditional = false;
            return out;
          } catch (err) {
            return wrap(err, CALDAV_HINT);
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Update reminder: ${args.uid || args.title}`,
          rawInput: args,
        }),
      }),
    );
  }

  // ------------------------------------------------------------- contacts
  if (contactsOn) {
    ctx.tools.register(
      defineTool({
        name: 'contact_add',
        description:
          "Add one person to the user's Apple Contacts on their iPhone. Writes a vCard 3.0 over CardDAV. " +
          'Use when the user asks to save someone they met, store a phone number, or keep a contact note. ' +
          '`phone` accepts multiple numbers separated by commas.',
        parameters: {
          name: { type: 'string', required: true, description: 'Display name, e.g. 张三.' },
          phone: { type: 'string', description: 'One or more phone numbers, comma-separated.' },
          email: { type: 'string', description: 'E-mail address.' },
          org: { type: 'string', description: 'Company or organisation.' },
          note: { type: 'string', description: 'Free-form note attached to the contact.' },
          book: { type: 'string', description: 'Address book name; defaults to the primary book.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              uid: { type: 'string', required: true },
              book: { type: 'string', required: true },
              href: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: `已存入通讯录 → ${value.book}（uid ${value.uid}）` },
          ],
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          try {
            const phones = (args.phone ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const created = await contactsClientFor(config, exec?.signal).createContact(
              {
                name: args.name,
                phone: phones.length ? phones : undefined,
                email: args.email,
                org: args.org,
                note: args.note,
              },
              { book: args.book || config.contactsBook || undefined },
            );
            return { ok: true, uid: created.uid, book: created.book, href: created.href };
          } catch (err) {
            return wrap(
              err,
              '通讯录走的是 CardDAV（contacts.icloud.com）。请确认这个 Apple ID 开启了 iCloud 通讯录。',
            );
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Add contact: ${args.name}`,
          rawInput: args,
        }),
      }),
    );

    // Read half of the contacts channel. Without it the only way to find out
    // whether a person is already saved is to write them again, and a mistyped
    // write could only be repaired by hand on the phone.
    ctx.tools.register(
      defineTool({
        name: 'contact_list',
        description:
          "Search the user's Apple Contacts over CardDAV. Filter by a name substring; returns uid, name, " +
          'phone numbers and e-mails for each match. Use it before contact_add when the person may already ' +
          'be saved, and to resolve the uid that contact_remove needs.',
        parameters: {
          query: { type: 'string', description: 'Case-insensitive substring match on the display name.' },
          book: { type: 'string', description: 'Address book name; defaults to the primary book.' },
          limit: { type: 'integer', description: 'Max contacts returned (default 50, max 500).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              book: { type: 'string', required: true },
              matched: { type: 'integer', required: true },
              contacts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uid: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    phones: { type: 'array' },
                    emails: { type: 'array' },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            const head = `${value.book}：匹配 ${value.matched} 位联系人`;
            if (!value.contacts.length) return [{ type: 'text', text: `${head}（没有匹配）` }];
            const lines = value.contacts.map((c) => {
              const bits = [];
              if (c.phones?.length) bits.push(c.phones.join(' / '));
              if (c.emails?.length) bits.push(c.emails.join(' / '));
              bits.push(`uid ${c.uid}`);
              return `  · ${c.name}（${bits.join('，')}）`;
            });
            return [{ type: 'text', text: `${head}\n${lines.join('\n')}` }];
          },
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          try {
            const client = contactsClientFor(config, exec?.signal);
            const book = args.book || config.contactsBook || undefined;
            const all = await client.listContacts(book);
            const needle = args.query ? String(args.query).toLowerCase() : null;
            const matches = needle
              ? all.filter((c) =>
                  [c.name, ...(c.phones ?? []), ...(c.emails ?? [])].join('\n').toLowerCase().includes(needle),
                )
              : all;
            const limit = Math.max(1, Math.min(Number(args.limit) || 50, 500));
            return {
              ok: true,
              book: all[0]?.book ?? '通讯录',
              matched: matches.length,
              contacts: matches.slice(0, limit).map((c) => {
                const out = { uid: c.uid || c.href, name: c.name || '(无姓名)' };
                if (c.phones?.length) out.phones = c.phones;
                if (c.emails?.length) out.emails = c.emails;
                return out;
              }),
            };
          } catch (err) {
            return wrap(
              err,
              '通讯录读取走 CardDAV（contacts.icloud.com）。若服务器拒绝 addressbook-query，' +
                '用 apple_targets 确认通讯录本身可达。',
            );
          }
        },
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'Search contacts' }),
      }),
    );

    // Delete half. Same rule as reminder_remove: an ambiguous name is reported,
    // never guessed — deleting the wrong person from iCloud syncs everywhere.
    ctx.tools.register(
      defineTool({
        name: 'contact_remove',
        description:
          'Delete one contact from the user\'s Apple Contacts by `uid` (from contact_list) or exact `name`. ' +
          'Refuses to act when a name matches several contacts; it lists them instead. This is the repair ' +
          'path for a wrong contact_add.',
        parameters: {
          uid: { type: 'string', description: 'uid from contact_list. Preferred: unambiguous.' },
          name: { type: 'string', description: 'Exact display name, used when uid is unknown.' },
          book: { type: 'string', description: 'Address book to search; defaults to the primary book.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              removed: { type: 'string', required: true },
              book: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: `已从通讯录删除 ${value.removed}（${value.book}）` },
          ],
        },
        timeoutMs: timeout,
        async execute(args, exec) {
          if (!args.uid && !args.name) {
            throw new Error('需要 uid 或 name 至少一个，否则无法定位要删除的联系人。');
          }
          try {
            const client = contactsClientFor(config, exec?.signal);
            const book = args.book || config.contactsBook || undefined;
            const all = await client.listContacts(book);
            const hit = args.uid
              ? all.filter((c) => c.uid === args.uid)
              : all.filter((c) => c.name === args.name);
            if (hit.length === 0) {
              throw new Error(
                `没有找到${args.uid ? ` uid=${args.uid}` : ` 姓名精确等于 ${JSON.stringify(args.name)}`} 的联系人。` +
                  '姓名是精确匹配；先用 contact_list 查一次。',
              );
            }
            if (hit.length > 1) {
              const seen = hit.map((c) => `${c.name}（uid ${c.uid || c.href}）`).join('；');
              throw new Error(`匹配到 ${hit.length} 位联系人，无法确定删哪一位：${seen}。请改用 uid 精确指定。`);
            }
            await client.deleteContact(hit[0].href, { etag: hit[0].etag });
            return { ok: true, removed: hit[0].name || hit[0].uid, book: hit[0].book };
          } catch (err) {
            return wrap(err, '通讯录删除走 CardDAV DELETE，失败时不会改动服务器上的联系人。');
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'other',
          title: `Remove contact: ${args.uid || args.name}`,
          rawInput: args,
        }),
      }),
    );
  }

  // --------------------------------------------------------------- targets
  if (remindersOn || contactsOn) {
    ctx.tools.register(
      defineTool({
        name: 'apple_targets',
        description:
          'Report every writable target this Apple account exposes, per channel: reminder lists (CalDAV) ' +
          'and address books (CardDAV). Each channel is probed independently, so one failure does not hide ' +
          'the other. Use this for the cross-channel view or when the task touches contacts; for reminders ' +
          'alone, reminder_lists is the reminders subset and one call is enough.',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const lines = [];
            for (const [channel, entry] of Object.entries(value)) {
              if (!entry.ok) {
                lines.push(`✗ ${channel}: ${entry.error}`);
                continue;
              }
              const names = entry.targets.map((t) => {
                const bits = [];
                if (typeof t.count === 'number') bits.push(`${t.count} 条`);
                if (t.newest) bits.push(String(t.newest).slice(0, 10));
                if (t.vtodos === 'unknown') bits.push('未公布组件');
                // A collection that only carries events is not a reminder list;
                // saying so keeps "5 targets" from reading as "5 places to write".
                if (t.vtodos === 'no') bits.push('仅日历');
                return bits.length ? `${t.name}[${bits.join(' ')}]` : t.name;
              });
              lines.push(`✓ ${channel}: ${names.join(', ') || '(空)'}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        timeoutMs: timeout,
        async execute(_args, exec) {
          const out = {};

          if (remindersOn) {
            try {
              const client = remindersClientFor(config, exec?.signal);
              const lists = await client.listCollections();
              const withStats = await Promise.all(
                lists.map(async (l) => {
                  const stats = l.vtodos === 'no' ? null : await client.collectionStats(l.url).catch(() => null);
                  return {
                    name: l.name,
                    url: l.url,
                    vtodos: l.vtodos,
                    count: stats?.count ?? null,
                    newest: stats?.newest ?? null,
                    lastModified: l.lastModified ?? null,
                  };
                }),
              );
              out.reminders = { ok: true, targets: withStats };
            } catch (err) {
              out.reminders = { ok: false, targets: [], error: err.message };
            }
          }

          if (contactsOn) {
            try {
              const books = await contactsClientFor(config, exec?.signal).listAddressbooks();
              out.contacts = { ok: true, targets: books.map((b) => ({ name: b.name, url: b.url })) };
            } catch (err) {
              out.contacts = { ok: false, targets: [], error: err.message };
            }
          }

          return out;
        },
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'List Apple write targets' }),
      }),
    );
  }
}

export { CalDAVError, CardDAVError };
export { RemindersClient } from './caldav.js';
export { ContactsClient, buildVCard } from './carddav.js';
