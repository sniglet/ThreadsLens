// Stress harness: seeds a mature store, loads the extension (with a debug hook), then scrolls a virtualized feed.
window.startStress = async function (label, batches, gapMs) {
  history.replaceState(null, '', '/');   // the extension only rates posts on the home feed (path "/")
  const seedPosts = {}, seedAcc = {};
  for (let i = 0; i < 4000; i++) seedPosts['s' + i] = { id: 's' + i, handle: 'seed' + (i % 1500), text: 'seeded post about ' + ['alpha','bravo','charlie','delta','echo','fjord','golf','hotel'][i % 8] + ' and ' + ['river','stone','cloud','ember','frost','grove','harbor','island'][(i >> 3) % 8] + ' number ' + i, ts: Date.now() - (i % 200) * 3600e3, ctx: 'home', kind: 'post', followed: i % 2 === 0, read: i % 3 === 0, seenAt: Date.now() - (4000 - i) * 60e3, dwell: 0 };
  for (let i = 0; i < 1500; i++) seedAcc['seed' + i] = { handle: 'seed' + i, followers: 100 + i, threads: 50 + (i % 400), fetchedAt: 1, bio: 'bio ' + i };
  localStorage.setItem('stub', JSON.stringify({ tl: { posts: seedPosts, accounts: seedAcc, reads: [], likers: {}, history: [], settings: {} } }));
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
  window.chrome = { runtime: { id: 'test', getManifest: () => ({ version: 'stress' }) }, storage: { local: {
    get: (k, cb) => cb(JSON.parse(localStorage.getItem('stub') || '{}')),
    set: (o) => localStorage.setItem('stub', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('stub') || '{}'), o))), remove() {} } } };
  let longTasks = 0, longMs = 0, maxLong = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longMs += e.duration; maxLong = Math.max(maxLong, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch {}
  let lagMax = 0, last = performance.now();
  setInterval(() => { const n = performance.now(); lagMax = Math.max(lagMax, n - last - 50); last = n; }, 50);
  await (await fetch('/score.js')).text().then((t) => (0, eval)(t));
  let src = await (await fetch('/content.js')).text();
  src = src.replace(/\}\)\(\);\s*$/, 'window.__dbg=()=>({els: typeof els!=="undefined"?els.size:0, dwell: typeof dwellTimers!=="undefined"?dwellTimers.size:0, featCache: typeof featCache!=="undefined"?featCache.size:0, recentPosts: typeof recentPosts!=="undefined"?recentPosts.length:0, posts: Object.keys(store.posts).length, accounts: Object.keys(store.accounts).length});})();');
  (0, eval)(src);
  await new Promise((r) => setTimeout(r, 1000));
  const mem = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  const res = { label, samples: [], start: { heapMB: mem(), dbg: window.__dbg() } };
  window.__res = res;
  const t0 = performance.now();
  for (let b = 0; b < batches; b++) {
    window.batch(20);
    await new Promise((r) => setTimeout(r, gapMs));
    if ((b + 1) % 10 === 0) res.samples.push({ batch: b + 1, heapMB: mem(), domPosts: document.querySelectorAll('[data-pressable-container]').length, dbg: window.__dbg(), lagMaxMs: Math.round(lagMax), longTasks, longTaskMs: Math.round(longMs), maxLongMs: Math.round(maxLong) });
  }
  res.seconds = Math.round((performance.now() - t0) / 1000); res.done = true;
};

// Count how many created post elements are still reachable after real memory pressure (WeakRef.deref is non-null while alive).
window.leakCheck = async () => {
  const total = window.__refs.length;
  for (let round = 0; round < 10; round++) {
    const bufs = [];
    for (let i = 0; i < 4; i++) { const u = new Uint8Array(48 * 1024 * 1024); u.fill(round + 1); bufs.push(u); }
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 1500));
  return { createdTotal: total, stillAlive: window.__refs.filter((r) => r.deref()).length, onPageNow: document.querySelectorAll('[data-pressable-container]').length };
};
