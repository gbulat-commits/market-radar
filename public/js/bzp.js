// BZP (Biuletyn Zamówień Publicznych, e-Zamówienia) source adapter.
// The API has no published spec: everything here is based on real responses
// checked on 2026-10-14. If the format changes, fix this file only — the UI
// works with the normalized records returned by fetchTenders().

export const API_URL = 'https://ezamowienia.gov.pl/mo-board/api/v1/notice';
export const NOTICE_URL = 'https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/';
export const PAGE_SIZE = 500; // API maximum; it has no working page parameter
export const DAYS_BACK = 30;

// The CpvCode filter matches an exact code among a notice's codes (no
// sub-categories), so each relevant code is queried separately.
// A wrong code returns [] just like "no notices", so only verified codes are listed.
export const CPV_CODES = [
  ['72000000-5', 'Usługi informatyczne'],
  ['72200000-7', 'Programowanie i doradztwo'],
  ['72210000-0', 'Programowanie pakietów oprogramowania'],
  ['72211000-7', 'Programowanie oprogramowania systemowego i użytkowego'],
  ['72212000-4', 'Programowanie oprogramowania aplikacyjnego'],
  ['72230000-6', 'Oprogramowanie na zamówienie'],
  ['72232000-0', 'Oprogramowanie do przetwarzania transakcji'],
  ['72260000-5', 'Usługi w zakresie oprogramowania'],
  ['72262000-9', 'Usługi rozbudowy oprogramowania'],
  ['72400000-4', 'Usługi internetowe'],
  ['72413000-8', 'Projektowanie stron WWW'],
  ['72415000-2', 'Prowadzenie stron WWW'],
  ['72421000-7', 'Aplikacje klienckie internetowe'],
  ['72422000-4', 'Aplikacje serwerowe internetowe'],
  ['48000000-8', 'Pakiety oprogramowania i systemy informatyczne'],
];

// Topic filter: websites and applications. Matched in title + short description.
export const TOPIC_KEYWORDS = [
  ['strona internetowa', /stron\p{L}*\s+(internetow|www)\p{L}*|serwis\p{L}*\s+internetow\p{L}*/iu],
  ['portal', /portal\p{L}*/iu],
  ['aplikacja', /aplikac\p{L}*/iu],
  ['platforma', /platform\p{L}*/iu],
  ['e-usługi', /e-?usług\p{L}*/iu],
];
// Boilerplate mentions that are not the subject of the contract.
const TOPIC_NOISE = /platform\p{L}*\s+(e-?zamówie\p{L}*|zakupow\p{L}*|przetargow\p{L}*)|za\s+pośrednictwem\s+platform\p{L}*/giu;

export const PROVINCES = {
  PL02: 'dolnośląskie', PL04: 'kujawsko-pomorskie', PL06: 'lubelskie', PL08: 'lubuskie',
  PL10: 'łódzkie', PL12: 'małopolskie', PL14: 'mazowieckie', PL16: 'opolskie',
  PL18: 'podkarpackie', PL20: 'podlaskie', PL22: 'pomorskie', PL24: 'śląskie',
  PL26: 'świętokrzyskie', PL28: 'warmińsko-mazurskie', PL30: 'wielkopolskie', PL32: 'zachodniopomorskie',
};

export class SourceError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind; // network | timeout | http | format | truncated
    Object.assign(this, details);
  }
}

// ---------- text helpers ----------

export function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeEntities(
    html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', oacute: 'ó', Oacute: 'Ó' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e] ?? m;
  });
}

// Polish number: "264000,00", "1 234 567,89", "1.234.567,89", "431200"
export function parsePolishNumber(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\s ]/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Estimated contract value from the notice text (BZP form, section 4.1.5/4.1.6).
// The form states it is net of VAT. There is no structured field for it in the API,
// so the result is marked source: 'text'. Contract prices from award notices are
// a different thing and are never read here.
const AMOUNT_NUMBER = String.raw`(\d{1,3}(?:[ \u00a0.]\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s*(PLN|EUR|zł)?(?!\p{L})`;
const AMOUNT_PATTERNS = [
  String.raw`Wartość zamówienia stanowiącego przedmiot tego postępowania \(bez VAT\)`,
  String.raw`Łączna wartość poszczególnych części zamówienia`,
  String.raw`Wartość zamówienia`,
].map((label) => new RegExp(String.raw`4\.1\.\d\.\)\s*${label}:\s*${AMOUNT_NUMBER}`, 'iu'));

export function extractAmount(text) {
  if (!text) return null;
  for (const re of AMOUNT_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const value = parsePolishNumber(m[1]);
    if (value === null || value <= 0) continue;
    const cur = m[2] ? (m[2].toLowerCase() === 'zł' ? 'PLN' : m[2].toUpperCase()) : null; // null: not stated, never guessed
    return { value, currency: cur, kind: 'estimate_net', source: 'text' };
  }
  return null;
}

export function extractDescription(text) {
  if (!text) return '';
  const m = text.match(/Krótki opis przedmiotu zamówienia\s*:?\s*([\s\S]*?)(?=\s\d+\.\d+(\.\d+)*\.?\)\s|$)/i);
  if (!m) return '';
  const d = m[1].trim();
  return d.length > 420 ? d.slice(0, 417).replace(/\s+\S*$/, '') + '…' : d;
}

export function topicMatches(title, description) {
  const hay = `${title || ''} ${description || ''}`.replace(TOPIC_NOISE, ' ');
  return TOPIC_KEYWORDS.filter(([, re]) => re.test(hay)).map(([k]) => k);
}

// ---------- normalization ----------

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isoOrNull = (v) => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// Returns a normalized record, or null if the item lacks the fields we cannot do without.
export function normalizeNotice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.objectId);
  const title = str(raw.orderObject);
  if (!id || !title) return null;
  const text = htmlToText(raw.htmlBody);
  let description = extractDescription(text);
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (norm(description).startsWith(norm(title).slice(0, 80))) description = ''; // just repeats the title
  return {
    id,
    number: str(raw.noticeNumber) || str(raw.bzpNumber),
    title: title.replace(/\s+/g, ' '),
    description,
    buyer: str(raw.organizationName),
    city: str(raw.organizationCity),
    province: PROVINCES[str(raw.organizationProvince)] || null,
    deadline: isoOrNull(raw.submittingOffersDate),
    published: isoOrNull(raw.publicationDate),
    orderType: str(raw.orderType),
    cpv: str(raw.cpvCode),
    amount: extractAmount(text),
    topics: topicMatches(title, description),
    url: NOTICE_URL + encodeURIComponent(id),
  };
}

export function mergeUnique(lists) {
  const byId = new Map();
  for (const list of lists) for (const n of list) if (n && !byId.has(n.id)) byId.set(n.id, n);
  return [...byId.values()];
}

// Open = deadline in the future. Without a deadline we cannot tell, so keep it
// (shown as "Нет данных" and sorted last).
export function isOpen(n, now = Date.now()) {
  return !n.deadline || Date.parse(n.deadline) > now;
}

export function byDeadline(a, b) {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return Date.parse(a.deadline) - Date.parse(b.deadline);
}

// ---------- fetching ----------

export function dateRange(now = new Date(), days = DAYS_BACK) {
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(d); // YYYY-MM-DD
  return { from: fmt(new Date(now.getTime() - days * 864e5)), to: fmt(now) };
}

export function buildUrl(cpv, from, to) {
  const p = new URLSearchParams({
    NoticeType: 'ContractNotice', CpvCode: cpv,
    PublicationDateFrom: from, PublicationDateTo: to, PageSize: String(PAGE_SIZE),
  });
  return `${API_URL}?${p}`;
}

async function getJson(url, { fetchImpl, timeoutMs, signal }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) throw new SourceError('aborted', 'Запрос отменён');
  signal?.addEventListener('abort', onAbort);
  // The timer also covers reading the body: responses can be several MB.
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  const failed = () => (signal?.aborted
    ? new SourceError('aborted', 'Запрос отменён')
    : new SourceError('timeout', `Источник не ответил за ${Math.round(timeoutMs / 1000)} с`));
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    } catch {
      if (ctrl.signal.aborted) throw failed();
      // Browsers report CORS blocks and offline as the same TypeError.
      throw new SourceError('network', 'Сеть недоступна или источник заблокировал запрос (CORS)');
    }
    if (!res.ok) throw new SourceError('http', `Источник ответил ошибкой HTTP ${res.status}`, { status: res.status });
    let data;
    try { data = await res.json(); } catch {
      if (ctrl.signal.aborted) throw failed();
      throw new SourceError('format', 'Источник вернул не JSON');
    }
    if (!Array.isArray(data)) throw new SourceError('format', 'Неожиданный формат ответа: ожидался список объявлений');
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const addDays = (ymd, d) => new Date(Date.parse(ymd + 'T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);

// One CPV code over a date range. The API caps a response at PAGE_SIZE and has no
// paging, so a full page means "maybe more": split the range and query halves.
async function fetchCpvRange(cpv, from, to, opts) {
  const raw = await withRetry(() => getJson(buildUrl(cpv, from, to), opts), opts);
  if (raw.length < PAGE_SIZE) return raw;
  if (from === to) throw new SourceError('truncated', `Код ${cpv}: за ${from} больше ${PAGE_SIZE} объявлений, источник отдаёт не все`);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
  const mid = addDays(from, Math.floor(days / 2));
  const [a, b] = await Promise.all([
    fetchCpvRange(cpv, from, mid, opts),
    fetchCpvRange(cpv, addDays(mid, 1), to, opts),
  ]);
  return a.concat(b);
}

async function withRetry(fn, { retries }) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const retriable = e.kind === 'network' || e.kind === 'timeout' || (e.kind === 'http' && (e.status >= 500 || e.status === 429));
      if (!retriable || i >= retries) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// Fetches all CPV codes. All-or-nothing: if any code fails, the whole refresh
// fails with a SourceError, so a partial set is never shown as complete.
// The first definitive failure stops the remaining requests (fail fast).
export async function fetchTenders({
  fetchImpl = (...a) => fetch(...a), now = new Date(), codes = CPV_CODES.map(([c]) => c),
  timeoutMs = 30000, retries = 1, concurrency = 4, signal, onProgress,
} = {}) {
  const { from, to } = dateRange(now);
  const stop = new AbortController();
  signal?.addEventListener('abort', () => stop.abort(), { once: true });
  const opts = { fetchImpl, timeoutMs, retries, signal: stop.signal };
  let done = 0;
  const results = await pool(codes, concurrency, async (cpv) => {
    if (stop.signal.aborted) return { cpv, error: new SourceError('aborted', 'Запрос отменён') };
    try {
      const raw = await fetchCpvRange(cpv, from, to, opts);
      return { cpv, raw };
    } catch (error) {
      stop.abort();
      return { cpv, error };
    } finally {
      onProgress?.(++done, codes.length);
    }
  });

  const failed = results.filter((r) => r.error && r.error.kind !== 'aborted');
  if (failed.length || results.some((r) => r.error)) {
    if (!failed.length) throw new SourceError('aborted', 'Обновление отменено');
    const first = failed[0].error;
    const which = failed.length === codes.length
      ? `не выполнен ни один из ${codes.length} запросов`
      : `ошибка по ${failed.length === 1 ? 'коду' : 'кодам'} CPV ${failed.map((f) => f.cpv).join(', ')}, остальные запросы остановлены`;
    throw new SourceError(first.kind || 'network', `${first.message}; ${which}`,
      { failedCodes: failed.map((f) => f.cpv) });
  }

  let rawCount = 0, skipped = 0;
  const lists = results.map(({ raw }) => raw.map((r) => {
    rawCount++;
    const n = normalizeNotice(r);
    if (!n) skipped++;
    return n;
  }));
  if (rawCount > 0 && skipped === rawCount) {
    throw new SourceError('format', 'Неожиданный формат ответа: в объявлениях нет objectId/orderObject');
  }
  const all = mergeUnique(lists);
  return { items: all, range: { from, to }, rawCount, skipped, fetchedAt: new Date().toISOString() };
}
