// Reads the family Google Calendar (secret iCal address) and summarizes
// who is out during dinner (6-8 PM) on each night of a planning week.
// Called by the site as /.netlify/functions/calendar?start=YYYY-MM-DD
//
// Netlify environment variables (Site configuration → Environment variables):
//   GCAL_ICS_URL               Google Calendar "Secret address in iCal format"
//   SUPABASE_URL               https://xoanixovtmtmhiwohbwv.supabase.co
//   SUPABASE_PUBLISHABLE_KEY   sb_publishable_...
//   FAMILY_TZ (optional)       defaults to America/New_York

import ICAL from 'ical.js';

const TZ = process.env.FAMILY_TZ || 'America/New_York';
const DINNER_START = 18 * 60;   // 6:00 PM, in minutes
const DINNER_END = 20 * 60;     // 8:00 PM

const FAMILY = ['Tim', 'Erica', 'Molly', 'Taylor', 'Charlotte'];
const PARENTS = ['Tim', 'Erica'];

// How calendar events are tagged. Single letters must be capitals ("M", not "m").
const CODES = {
  M: 'Molly', T: 'Taylor', C: 'Charlotte', E: 'Erica',
  MOM: 'Erica', DAD: 'Tim',
  MOLLY: 'Molly', TAYLOR: 'Taylor', CHARLOTTE: 'Charlotte', ERICA: 'Erica', TIM: 'Tim',
  FAMILY: FAMILY, ALL: FAMILY,
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default async (req) => {
  const start = new URL(req.url).searchParams.get('start');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return json({ error: 'Missing start date' }, 400);

  const user = await verify(req);
  if (!user) return json({ error: 'Sign in first' }, 401);

  if (!process.env.GCAL_ICS_URL) return json({ error: 'Calendar not connected' }, 503);
  const res = await fetch(process.env.GCAL_ICS_URL);
  if (!res.ok) return json({ error: 'Could not read the calendar' }, 502);

  let days;
  try { days = buildWeek(start, await res.text()); }
  catch (e) { return json({ error: 'Could not read the calendar' }, 502); }

  // Kids see only how busy each night is; admins see the details.
  if (user.role !== 'admin') days = days.map(({ date, flag }) => ({ date, flag }));
  return json({ days });
};

// Only signed-in family members may call this.
async function verify(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  const u = await fetch(`${base}/auth/v1/user`, { headers });
  if (!u.ok) return null;
  const { id } = await u.json();
  const p = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=role`, { headers });
  const rows = p.ok ? await p.json() : [];
  return { id, role: rows[0]?.role || 'member' };
}

// Who an event belongs to, from tags at the start ("M - Soccer", "Mom & C: dentist")
// or in parentheses anywhere ("Swim meet (T)").
export function peopleIn(summary) {
  const s = (summary || '').trim();
  const found = new Set();
  const add = (tok) => {
    const v = CODES[tok.length === 1 ? tok : tok.toUpperCase()];
    if (!v) return false;
    (Array.isArray(v) ? v : [v]).forEach((n) => found.add(n));
    return true;
  };
  const re = /[A-Za-z]+/g;
  let m, last = 0;
  while ((m = re.exec(s))) {
    if (last && !/^[\s,&+\/]*$/.test(s.slice(last, m.index))) break;   // ":" or "-" ends the tags
    if (last && m[0].toLowerCase() === 'and') { last = re.lastIndex; continue; }
    if (m[0].length === 1 && /^-[A-Za-z]/.test(s.slice(re.lastIndex))) break;  // "T-ball" is not a tag
    if (!add(m[0])) break;
    last = re.lastIndex;
  }
  for (const p of s.matchAll(/\(([^)]+)\)/g)) p[1].split(/[\s,&+\/]+/).forEach((t) => t && add(t));
  return FAMILY.filter((n) => found.has(n));
}

function buildWeek(start, text) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(new ICAL.Timezone(vtz)); } catch {}
  }
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const weekEnd = addDays(start, 7);
  const occ = expand(comp, start, weekEnd);

  return dates.map((date) => {
    const ws = zonedToUtc(date, DINNER_START), we = zonedToUtc(date, DINNER_END);
    const events = occ
      .filter((o) => o.allDay ? (o.startDay <= date && date < o.endDay) : (o.start < we && o.end > ws))
      .sort((a, b) => (a.allDay ? 0 : a.start) - (b.allDay ? 0 : b.start));

    const away = new Set();
    let untagged = 0;
    for (const e of events) {
      if (e.allDay) continue;                     // all-day items are shown, but don't mark anyone out
      if (e.people.length) e.people.forEach((p) => away.add(p)); else untagged++;
    }
    const out = FAMILY.filter((n) => away.has(n));
    const parentsOut = PARENTS.filter((n) => away.has(n)).length;
    let flag = 'home';
    if (out.length >= 3 || parentsOut === 2) flag = 'away';
    else if (out.length || untagged) flag = 'tight';

    return {
      date, flag, untagged,
      away: out,
      home: FAMILY.filter((n) => !away.has(n)),
      events: events.map((e) => ({
        title: e.title, allDay: e.allDay, people: e.people,
        start: e.allDay ? null : e.start.toISOString(),
        end: e.allDay ? null : e.end.toISOString(),
      })),
    };
  });
}

// Every event occurrence touching the week, with repeating events expanded.
function expand(comp, weekStart, weekEnd) {
  const rangeStart = zonedToUtc(weekStart, 0), rangeEnd = zonedToUtc(weekEnd, 0);
  const stopAfter = new Date(rangeEnd.getTime() + 7 * 864e5);
  const out = [];

  const add = (item, sd, ed) => {
    if (!sd) return;
    if ((item.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    const title = item.summary || 'Busy';
    if (sd.isDate) {
      const startDay = sd.toString().slice(0, 10);
      const endDay = ed ? ed.toString().slice(0, 10) : addDays(startDay, 1);
      if (endDay > weekStart && startDay < weekEnd) out.push({ title, allDay: true, startDay, endDay, people: peopleIn(title) });
      return;
    }
    const start = instant(sd), end = ed ? instant(ed) : start;
    if (end > rangeStart && start < rangeEnd) out.push({ title, allDay: false, start, end, people: peopleIn(title) });
  };

  const events = comp.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
  const masters = new Map();
  for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of events) {
    if (!e.isRecurrenceException()) continue;
    const m = masters.get(e.uid);
    if (m) m.relateException(e); else masters.set(`${e.uid}#${e.recurrenceId}`, e);
  }

  for (const ev of masters.values()) {
    if (!ev.isRecurring()) { add(ev, ev.startDate, ev.endDate); continue; }
    const it = ev.iterator();
    let next, n = 0;
    while ((next = it.next()) && n++ < 20000) {
      if (instant(next) > stopAfter) break;
      const det = ev.getOccurrenceDetails(next);
      add(det.item, det.startDate, det.endDate);
    }
  }
  return out;
}

// An ICAL.Time as a real moment; times with no known zone are read as family time.
function instant(t) {
  const tzid = t.zone && t.zone.tzid;
  if (t.isDate || !tzid || tzid === 'floating') {
    const d = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
    return zonedToUtc(d, t.hour * 60 + t.minute);
  }
  return t.toJSDate();
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// A wall-clock time on a date in the family's time zone, as a UTC Date.
function zonedToUtc(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off = tzOffset(new Date(guess));
  let t = guess - off;
  const off2 = tzOffset(new Date(t));
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

function tzOffset(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}
