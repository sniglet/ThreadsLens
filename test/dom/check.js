// DOM extraction check against test/dom/index.html (no Threads needed).
// 1. From the ThreadsLens folder: python3 -m http.server 8099
// 2. Open http://localhost:8099/test/dom/index.html, then in the console:
//      (0, eval)(await (await fetch('/test/dom/check.js')).text()); await runDomCheck()
//    It returns { pass, results }. The page is moved to "/" so the content script treats it as the home feed.
window.runDomCheck = async () => {
  history.replaceState(null, '', '/');
  window.chrome = { runtime: { id: 't', getManifest: () => ({ version: 'fixture' }) },
    storage: { local: { get: (k, cb) => cb({}), set() {}, remove() {} } } };
  for (const f of ['/score.js', '/content.js']) (0, eval)(await (await fetch(f)).text());
  await new Promise((r) => setTimeout(r, 1200));   // let the first scan run
  const posts = [...document.querySelectorAll('#feed > [data-pressable-container]')];
  const [outer, followed] = posts.map((c) => window.__tlExtract(c));
  const quoted = window.__tlExtract(posts[0].querySelector('[data-pressable-container] [data-pressable-container]'));
  const tagged = [...document.querySelectorAll('[data-tl-id]')].map((c) => c.dataset.tlId);
  const results = [];
  const ok = (c, m, got) => results.push({ ok: !!c, m, got });
  ok(outer.id === 'OUTER1' && outer.handle === 'outer_user', 'outer post id/handle', outer.id);
  ok(outer.likes === 123, 'outer likes are its own, not the quote\'s 17.1K', outer.likes);
  ok(outer.replies === 1100 && outer.reposts === 7, 'outer replies/reposts', [outer.replies, outer.reposts]);
  ok(outer.followed === false, 'outer has Follow => not followed', outer.followed);
  ok(outer.quote === 'QUOTED1', 'outer records what it quotes', outer.quote);
  ok(!/Quoted post/.test(outer.text), 'outer text excludes the quote', outer.text);
  ok(outer.ts === Date.parse('2026-11-03T10:21:46.000Z'), 'outer time is its own', outer.ts);
  ok(quoted.likes === 17100 && quoted.handle === 'quoted_user', 'quoted post read on its own', [quoted.handle, quoted.likes]);
  ok(followed.likes === 80, 'followed likes', followed.likes);
  ok(followed.replies === null && followed.reposts === null, 'missing counts stay null (no bleed from Share)', [followed.replies, followed.reposts]);
  ok(followed.followed === null, 'no Follow control => unknown at extract time', followed.followed);
  ok(tagged.length === 2 && !tagged.includes('QUOTED1'), 'home scan skips the nested quote', tagged);
  const pill = posts[0].querySelector('.tl-badge');
  ok(pill && pill.parentElement.classList.contains('row') && !posts[0].querySelector(':scope [data-pressable-container] .tl-badge'),
    'pill goes in the OUTER action row', pill && pill.parentElement.className);
  return { pass: results.every((r) => r.ok), results };
};
