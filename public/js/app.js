// UI for Market Radar. Works only with normalized records from bzp.js.
import { fetchTenders, isOpen, byDeadline, PROVINCES, SourceError } from './bzp.js';
import { simulatedFetch } from './simulate.js';

const STORE_KEY = 'market-radar:v1';
const DAY = 864e5;
const $ = (id) => document.getElementById(id);

const state = {
  data: null, // { items, fetchedAt, range, rawCount }
  loading: false,
  filters: { q: '', topic: true, deadline: '', province: '', sort: 'deadline', withAmount: false },
};

// ---------- persistence (browser only; per viewer) ----------

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.items) && s.fetchedAt && s.range?.from && s.range?.to && s.items.every((i) => i && i.id && i.title)) return s;
  } catch { /* storage blocked or corrupt */ }
  return null;
}
function save(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* quota or blocked: keep in memory */ }
}

// ---------- formatting ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tz = 'Europe/Warsaw';
const fmtDate = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const fmtDateTime = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtMoney = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NO_DATA = '<span class="none">Нет данных</span>';

function deadlineCell(iso) {
  if (!iso) return NO_DATA;
  const d = new Date(iso);
  const left = d.getTime() - Date.now();
  const days = Math.floor(left / DAY);
  let pill;
  if (left < DAY) pill = '<span class="pill hot">меньше суток</span>';
  else if (left < 2 * DAY) pill = '<span class="pill hot">через 1 день</span>';
  else if (left <= 7 * DAY) pill = `<span class="pill soon">через ${days} ${plural(days, 'день', 'дня', 'дней')}</span>`;
  else pill = `<span class="pill ok">через ${days} ${plural(days, 'день', 'дня', 'дней')}</span>`;
  return `<div class="dl">${fmtDate.format(d)}</div><div class="dl-time">до ${fmtTime.format(d)}</div>${pill}`;
}

function amountCell(a) {
  if (!a) return '<span class="none">Не указана</span>';
  const cur = a.currency ? ` ${esc(a.currency)}` : '';
  const note = a.currency ? 'оценка без VAT · из текста' : 'валюта не указана · оценка без VAT';
  return `<div class="amount">${fmtMoney.format(a.value)}${cur}</div><div class="amount-note" title="Оценочная стоимость заказа без VAT, извлечена из текста объявления (раздел 4.1.5/4.1.6). Это не цена контракта.">${note}</div>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- filtering ----------

function visibleItems() {
  if (!state.data) return [];
  const f = state.filters;
  const now = Date.now();
  const q = f.q.trim().toLowerCase();
  let list = state.data.items.filter((n) => isOpen(n, now));
  if (f.topic) list = list.filter((n) => n.topics?.length);
  if (q) list = list.filter((n) => [n.title, n.description, n.buyer, n.city, n.number, n.province].some((v) => v && v.toLowerCase().includes(q)));
  if (f.deadline) {
    const max = now + Number(f.deadline) * DAY;
    list = list.filter((n) => n.deadline && Date.parse(n.deadline) <= max);
  }
  if (f.province) list = list.filter((n) => n.province === f.province);
  if (f.withAmount) list = list.filter((n) => n.amount);
  const sorters = {
    deadline: byDeadline,
    published: (a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0),
    amount: (a, b) => (b.amount?.value ?? -1) - (a.amount?.value ?? -1) || byDeadline(a, b),
  };
  return list.sort(sorters[f.sort] || byDeadline);
}

// ---------- rendering ----------

function render() {
  const data = state.data;
  const rows = $('rows');
  const empty = $('empty');
  $('topicNote').hidden = !state.filters.topic;

  if (!data) {
    $('resultCount').textContent = '—';
    if (!state.loading) {
      rows.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = '<b>Данных пока нет</b>Нажмите «Обновить данные», чтобы загрузить закупки из BZP.';
    }
    return;
  }

  const now = Date.now();
  const open = data.items.filter((n) => isOpen(n, now));
  const topical = open.filter((n) => n.topics?.length);
  const scope = state.filters.topic ? topical : open;
  $('statAll').textContent = data.items.length;
  $('statOpen').textContent = open.length;
  $('statTopic').textContent = topical.length;
  $('statSoon').textContent = scope.filter((n) => n.deadline && Date.parse(n.deadline) - now <= 7 * DAY).length;

  const list = visibleItems();
  $('resultCount').textContent = `${list.length} ${plural(list.length, 'закупка', 'закупки', 'закупок')}`;
  $('rangeInfo').textContent = `Публикации ${fmtDate.format(new Date(data.range.from + 'T12:00:00Z'))} – ${fmtDate.format(new Date(data.range.to + 'T12:00:00Z'))}, только с открытым приёмом заявок`;

  if (!list.length) {
    rows.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = data.items.length
      ? '<b>Ничего не найдено</b>Измените фильтры или переключитесь на «Все IT».'
      : '<b>Источник не вернул закупок</b>За последние 30 дней по выбранным кодам CPV объявлений нет.';
    return;
  }
  empty.hidden = true;
  rows.innerHTML = list.map(rowHtml).join('');
}

function rowHtml(n) {
  const tags = (n.topics || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const place = [n.city, n.province].filter(Boolean).map(esc).join(', ');
  return `<tr>
    <td class="c-subject">
      <a class="title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      ${n.description ? `<div class="desc">${esc(n.description)}</div>` : ''}
      <div class="meta">${tags}<span class="num">${esc(n.number || '')}</span></div>
    </td>
    <td class="c-buyer" data-label="Заказчик">${n.buyer ? `<div class="buyer">${esc(n.buyer)}</div>` : NO_DATA}${place ? `<div class="place">${place}</div>` : ''}</td>
    <td class="c-deadline" data-label="Срок подачи">${deadlineCell(n.deadline)}</td>
    <td class="c-amount" data-label="Сумма">${amountCell(n.amount)}</td>
    <td class="c-pub">${n.published ? fmtDate.format(new Date(n.published)) : NO_DATA}</td>
    <td class="c-src"><a class="src" href="${esc(n.url)}" target="_blank" rel="noopener" title="Открыть объявление в BZP" aria-label="Открыть объявление в BZP">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a></td>
  </tr>`;
}

function renderSkeleton() {
  if (state.data) return; // keep showing previous data while loading
  $('empty').hidden = true;
  $('rows').innerHTML = Array.from({ length: 6 }, () =>
    '<tr class="skeleton"><td class="c-subject"><div style="width:85%"></div><div style="width:55%"></div></td><td class="c-buyer"><div></div></td><td class="c-deadline"><div></div></td><td class="c-amount"><div></div></td><td class="c-pub"><div></div></td><td class="c-src"></td></tr>').join('');
}

function renderLastChecked(extra = '') {
  const el = $('lastChecked');
  el.innerHTML = state.data
    ? `Последняя успешная проверка: <strong>${fmtDateTime.format(new Date(state.data.fetchedAt))}</strong>${extra}`
    : 'Данные ещё не загружались' + extra;
}

function showAlert(kind, html) {
  const a = $('alert');
  a.className = `alert ${kind}`;
  a.innerHTML = `<div>${html}</div><button class="alert-close" type="button" aria-label="Закрыть">×</button>`;
  a.hidden = false;
  a.querySelector('.alert-close').onclick = () => { a.hidden = true; };
}

function fillProvinces() {
  $('province').insertAdjacentHTML('beforeend',
    Object.values(PROVINCES).sort((a, b) => a.localeCompare(b, 'pl')).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join(''));
}

// ---------- refresh ----------

async function refresh() {
  if (state.loading) return; // ignore repeated clicks
  state.loading = true;
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('span').textContent = 'Загрузка…';
  $('alert').hidden = true;
  $('progress').hidden = false;
  $('progressBar').style.width = '4%';
  renderLastChecked(' · <strong>обновление…</strong>');
  renderSkeleton();

  const simulate = new URLSearchParams(location.search).get('simulate');
  try {
    const result = await fetchTenders({
      ...(simulate ? { fetchImpl: simulatedFetch(simulate), timeoutMs: 3000 } : {}),
      onProgress: (done, total) => { $('progressBar').style.width = `${Math.max(4, (done / total) * 100)}%`; },
    });
    state.data = { items: result.items, fetchedAt: result.fetchedAt, range: result.range, rawCount: result.rawCount, simulated: !!simulate };
    if (!simulate) save(state.data);
    renderLastChecked();
    if (simulate) showAlert('info', `<b>Тестовый режим (${esc(simulate)}).</b> Показаны тестовые данные, а не реальные закупки. Уберите <code>?simulate</code> из адреса.`);
    else if (result.skipped) showAlert('info', `Пропущено объявлений без названия или идентификатора: ${result.skipped}.`);
  } catch (e) {
    const why = e instanceof SourceError ? e.message : `Непредвиденная ошибка: ${e?.message || e}`;
    const kept = state.data ? 'Показаны предыдущие результаты.' : 'Предыдущих результатов нет.';
    showAlert('error', `<b>Обновление не удалось.</b> ${esc(why)}. ${kept} Попробуйте ещё раз через минуту.`);
    renderLastChecked();
    console.error('[market-radar] refresh failed', e);
  } finally {
    state.loading = false;
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('span').textContent = 'Обновить данные';
    $('progress').hidden = true;
    render();
  }
}

// ---------- wiring ----------

function bind() {
  $('refreshBtn').addEventListener('click', refresh);
  $('q').addEventListener('input', (e) => { state.filters.q = e.target.value; render(); });
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      state.filters.topic = b.dataset.topic === '1';
      document.querySelectorAll('.seg-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
  }
  for (const id of ['deadline', 'province', 'sort']) $(id).addEventListener('change', (e) => { state.filters[id] = e.target.value; render(); });
  $('withAmount').addEventListener('change', (e) => { state.filters.withAmount = e.target.checked; render(); });
}

fillProvinces();
bind();
const simulateMode = new URLSearchParams(location.search).get('simulate');
state.data = simulateMode ? null : loadSaved();
renderLastChecked();
render();
if (!state.data) refresh(); // first visit: load once automatically
setInterval(() => { if (!state.loading) render(); }, 60000); // deadlines move while the tab stays open
