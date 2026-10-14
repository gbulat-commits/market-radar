// Test mode for checking error handling: open the page with ?simulate=<mode>.
// The first refresh returns clearly marked TEST notices; every later refresh
// behaves according to the mode. Nothing here is real procurement data, and
// simulated results are never saved to the browser cache.
//   ok       always succeed with test data
//   empty    succeed with no notices
//   network  later refreshes fail as offline / CORS
//   http     later refreshes get HTTP 503
//   format   later refreshes get a non-list JSON
//   partial  later refreshes: one CPV code fails, others succeed
//   timeout  later refreshes never answer (aborted by the adapter timeout)

const day = 864e5;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

export function testNotices() {
  const body = (desc, amountLine) =>
    `<h3>4.2.2.) Krótki opis przedmiotu zamówienia: ${desc}</h3><h3>4.1.4.) Czy zamawiający przewiduje unieważnienie postępowania: Nie</h3>${amountLine}<h3>4.1.8.) Możliwe jest składanie ofert częściowych: Nie</h3>`;
  return [
    { objectId: 'test-0001', noticeNumber: 'TEST/BZP 0001/01', orderObject: 'TEST — Wykonanie nowej strony internetowej gminy', organizationName: 'TEST Gmina Przykładowa', organizationCity: 'Testowo', organizationProvince: 'PL14', submittingOffersDate: iso(1.5 * day), publicationDate: iso(-3 * day), htmlBody: body('Projekt i wdrożenie serwisu WWW.', '<h3>4.1.5.) Wartość zamówienia: 120000,00 PLN</h3>') },
    { objectId: 'test-0002', noticeNumber: 'TEST/BZP 0002/01', orderObject: 'TEST — Aplikacja mobilna dla mieszkańców', organizationName: 'TEST Miasto Próbne', organizationCity: null, organizationProvince: null, submittingOffersDate: iso(10 * day), publicationDate: iso(-1 * day), htmlBody: body('Aplikacja na Android i iOS.', '') },
    { objectId: 'test-0003', noticeNumber: 'TEST/BZP 0003/01', orderObject: 'TEST — Dostawa licencji oprogramowania biurowego', organizationName: null, organizationCity: 'Testowo', organizationProvince: 'PL30', submittingOffersDate: iso(5 * day), publicationDate: null, htmlBody: body('Licencje.', '<h3>4.1.5.) Wartość zamówienia: 241112,50</h3>') },
    { objectId: 'test-0004', noticeNumber: 'TEST/BZP 0004/01', orderObject: 'TEST — Portal e-usług (termin minął)', organizationName: 'TEST Urząd', organizationCity: 'Testowo', organizationProvince: 'PL02', submittingOffersDate: iso(-1 * day), publicationDate: iso(-20 * day), htmlBody: body('Portal.', '') },
  ];
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export function simulatedFetch(mode) {
  const counter = (simulatedFetch.calls ??= new Map());
  return async (url, { signal } = {}) => {
    await new Promise((r) => setTimeout(r, 150));
    const cpv = new URL(url).searchParams.get('CpvCode');
    const first = !counter.has(cpv);
    counter.set(cpv, (counter.get(cpv) || 0) + 1);
    // Test notices come from one code; the duplicate under a second code checks dedup.
    const ok = () => json(cpv === '72000000-5' ? testNotices() : cpv === '72413000-8' ? testNotices().slice(0, 1) : []);
    if (mode === 'ok' || first) return mode === 'empty' ? json([]) : ok();
    switch (mode) {
      case 'empty': return json([]);
      case 'network': throw new TypeError('Failed to fetch');
      case 'http': return json({ title: 'Service Unavailable' }, 503);
      case 'format': return json({ unexpected: true });
      case 'partial': if (cpv === '72413000-8') throw new TypeError('Failed to fetch'); return ok();
      case 'timeout': return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      default: return ok();
    }
  };
}
