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
  const [outer, odo, followed] = posts.map((c) => window.__tlExtract(c));
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
  ok(followed.replies === 0 && followed.reposts === 0, 'icon without a number is 0 (no bleed from Share\'s 9)', [followed.replies, followed.reposts]);
  ok(followed.followed === null, 'no Follow control => unknown at extract time', followed.followed);
  ok(odo.likes === 120 && odo.reposts === 129, 'animating odometer counts read as the incoming value', [odo.likes, odo.reposts]);
  ok(odo.replies === 24, 'plain count next to odometers', odo.replies);
  ok(tagged.length === 3 && !tagged.includes('QUOTED1'), 'home scan skips the nested quote', tagged);
  const pill = posts[0].querySelector('.tl-badge');
  ok(pill && pill.parentElement.classList.contains('row') && !posts[0].querySelector(':scope [data-pressable-container] .tl-badge'),
    'pill goes in the OUTER action row', pill && pill.parentElement.className);
  return { pass: results.every((r) => r.ok), results };
};

// Pills on a page where the quoted post is recorded too (thread/profile: nested containers are not skipped there).
// Run on a FRESH load of index.html:  (0, eval)(await (await fetch('/test/dom/check.js')).text()); await runPillCheck()
// Regression: the outer post used to grab the quote's pill and pills piled up in its row on every scan.
window.runPillCheck = async () => {
  history.replaceState(null, '', '/@outer_user/post/OUTER1');
  window.chrome = { runtime: { id: 't', getManifest: () => ({ version: 'fixture' }) },
    storage: { local: { get: (k, cb) => cb({}), set() {}, remove() {} } } };
  for (const f of ['/score.js', '/content.js']) (0, eval)(await (await fetch(f, { cache: 'no-store' })).text());
  await new Promise((r) => setTimeout(r, 4000));   // several scans: each new pill is a DOM mutation that triggers another
  const outer = document.querySelector('#feed > [data-pressable-container]');
  const quote = outer.querySelector(':scope [data-pressable-container]');
  const own = (c) => [...c.querySelectorAll('.tl-badge')].filter((b) => b.closest('[data-pressable-container]') === c);
  const results = [];
  const ok = (c, m, got) => results.push({ ok: !!c, m, got });
  ok(quote.dataset.tlId === 'QUOTED1', 'quote is recorded on a thread page', quote.dataset.tlId);
  ok(own(outer).length === 1, 'outer post has exactly one pill', own(outer).length);
  ok(own(quote).length === 1, 'quoted post has exactly one pill', own(quote).length);
  ok(own(outer)[0] && own(outer)[0].parentElement.classList.contains('row'), 'outer pill sits in the outer row', own(outer)[0] && own(outer)[0].parentElement.className);
  ok(document.querySelectorAll('.tl-badge').length === document.querySelectorAll('[data-tl-id]').length, 'one pill per recorded post',
    [document.querySelectorAll('.tl-badge').length, document.querySelectorAll('[data-tl-id]').length]);
  return { pass: results.every((r) => r.ok), results };
};
