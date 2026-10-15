// ThreadsLens content script: passive reader + slow, human-paced profile lookups + overlay.
// All selectors that may break when Threads changes its markup live in SEL / the extract* functions.
(() => {
  if (window.__threadsLens) return;
  window.__threadsLens = true;
  const S = window.TLScore;

  const CFG = {
    readMs: 1500,            // visible this long = "read"
    window: 30,              // feed state computed over the last N read posts
    minWindow: 10,
    watchCohorts: ['2025-11', '2024-11'],
    maxPosts: 4000,
    maxAccounts: 6000,       // oldest un-rated, un-looked-up accounts are dropped past this
    fetch: { minGap: 40000, maxGap: 110000, perHour: 25, idleMs: 60000 },
  };
  const SEL = {
    container: '[data-pressable-container="true"]',
    postLink: 'a[href*="/post/"]',
    time: 'time[datetime]',
    follow: 'svg[aria-label="Follow"], [role="button"][aria-label^="Follow"]',
  };

  let store = { posts: {}, accounts: {}, reads: [], likers: {}, history: [], settings: { glance: false } };
  let lastInput = Date.now(), lastFetch = 0, nextGap = 60000, backoffUntil = 0;
  const fetchLog = [];
  const pageLoadIds = new Set();   // ids that existed in storage before this page load (=> repeats)
  const dwellTimers = new Map();
  const observed = new WeakSet();  // containers the IntersectionObserver currently watches (weak: must never keep a removed post alive)
  const recentPosts = [];          // the newest ~200 post records, for near-duplicate search (kept in order, so no sorting per call)
  const featCache = new Map();     // post id -> { text, likes, replies, f }: scorePost is not cheap, so compute it once per post

  // ---------- storage ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage;
  let dead = false;
  // After the extension is reloaded, this orphaned copy loses chrome.* access. Stop quietly and ask for a page refresh.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  const die = () => {
    if (dead) return; dead = true;
    try { const b = root.getElementById('bar'); b.replaceChildren(h('div', { textContent: 'ThreadsLens was updated. Refresh this page.' })); } catch {}
  };
  let saveT = null, dataVersion = 0, dirtySince = 0;
  // Drop the oldest items so memory and storage stay bounded.
  const prune = () => {
    const ids = Object.keys(store.posts);
    if (ids.length > CFG.maxPosts) {
      ids.sort((a, b) => store.posts[a].seenAt - store.posts[b].seenAt)
        .slice(0, ids.length - CFG.maxPosts).forEach((id) => { delete store.posts[id]; featCache.delete(id); });
    }
    store.reads = store.reads.slice(-500);
    const lk = Object.keys(store.likers);
    if (lk.length > 80) lk.sort((a, b) => store.likers[a].firstSeen - store.likers[b].firstSeen).slice(0, lk.length - 80).forEach((k) => delete store.likers[k]);
    const hs = Object.keys(store.accounts);
    if (hs.length > CFG.maxAccounts) {
      const precious = (a) => a.rating || a.joined || a.tabs || a.liker;       // anything you did, or that took effort to learn
      const cost = (a) => (a.fetchedAt ? 1e15 : 0) + (a.seen || 0);            // never-looked-up and long-unseen go first
      hs.filter((h) => !precious(store.accounts[h])).sort((x, y) => cost(store.accounts[x]) - cost(store.accounts[y]))
        .slice(0, hs.length - CFG.maxAccounts + 500).forEach((h) => delete store.accounts[h]);
    }
  };
  const flushSave = () => {
    clearTimeout(saveT); saveT = null;
    if (!dirtySince) return;
    dirtySince = 0;
    prune();
    if (!alive()) return die();
    try { if (hasChrome) chrome.storage.local.set({ tl: store }); } catch { die(); }
  };
  // Debounced with a 20 s ceiling. It used to be a pure debounce, so continuous scrolling reset the timer forever:
  // nothing was saved or trimmed until you paused (a stress run reached 6,000 posts against a 4,000 cap).
  const save = () => {
    dataVersion++;
    const now = Date.now(); if (!dirtySince) dirtySince = now;
    clearTimeout(saveT);
    saveT = setTimeout(flushSave, now - dirtySince >= 20000 ? 0 : 5000);
  };
  addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  // Cached scorePost features (valid while the text and the engagement counts are unchanged).
  const featOf = (p) => {
    const c = featCache.get(p.id);
    if (c && c.text === p.text && c.likes === p.likes && c.replies === p.replies) return c.f;
    const f = S.scorePost(p, recentPosts);
    if (featCache.size >= 1500) featCache.delete(featCache.keys().next().value);
    featCache.set(p.id, { text: p.text, likes: p.likes, replies: p.replies, f });
    return f;
  };

  // ---------- extraction ----------
  const parseCount = (t) => {
    if (!t) return null;
    const m = t.trim().replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
  };
  const metric = (c, label) => {
    const svg = c.querySelector('svg[aria-label="' + label + '"]');
    if (!svg) return null;
    let el = svg.closest('[role="button"], a, button') || svg.parentElement;
    for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
      const m = (el.textContent || '').trim().match(/[\d.,]+\s*[KMB]?$/i);
      if (m) return parseCount(m[0]);
    }
    return null;
  };
  const extract = (c) => {
    const link = c.querySelector(SEL.postLink);
    if (!link) return null;
    const m = link.getAttribute('href').match(/^\/@([^/]+)\/post\/([^/?#]+)/);
    if (!m) return null;
    const spans = [...c.querySelectorAll('span[dir="auto"]')]
      .filter((s) => !s.closest('a[href^="/@"]') && !s.closest('time') && !s.closest('[role="button"]'));
    const texts = spans.map((s) => s.textContent.trim()).filter(Boolean);
    if (S.isUnavailable(texts)) return null;
    const text = S.cleanBody(texts);
    const t = c.querySelector(SEL.time);
    return {
      id: m[2], handle: m[1], text,
      ts: t ? Date.parse(t.getAttribute('datetime')) : null,
      likes: metric(c, 'Like') ?? metric(c, 'Unlike'), replies: metric(c, 'Reply'), reposts: metric(c, 'Repost'),
      followed: c.querySelector(SEL.follow) ? false : null, // null = unknown; we only know when a Follow control is shown
    };
  };

  // ---------- scan / observe ----------
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.tlId; if (!id) continue;
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        if (!dwellTimers.has(id)) dwellTimers.set(id, setTimeout(() => { dwellTimers.delete(id); markRead(id); }, CFG.readMs));
      } else if (dwellTimers.has(id)) { clearTimeout(dwellTimers.get(id)); dwellTimers.delete(id); }
    }
  }, { threshold: [0, 0.6, 1] });

  // ---------- rate each home-feed post as it arrives ----------
  const recentFeed = [];   // handles of recent home-feed arrivals, newest last (author-saturation signal)
  // `repeat`: this exact post was already in an earlier feed view; `ar`: how many of the last 40 arrivals were by the same author.
  function rateArrival(rec, opts) {
    if (rec.followed == null || rec.handle === store.settings.me) return;
    const it = { rec, f: featOf(rec), acct: acctScore(rec.handle), followed: rec.followed,
      ageH: rec.ts ? Math.max(0, Date.now() - rec.ts) / 3600e3 : null, repeat: opts.repeat, authorRecent: opts.ar };
    const t = S.postTelltale(it); if (!t) return;
    const was = rec.tell;
    rec.tell = { k: t.key, s: t.score, r: t.reasons, a: t.also, ar: opts.ar, rep: opts.repeat, t: Date.now() };
    if (opts.keepUser && was && was.u) { rec.tell.u = was.u; rec.tell.ut = was.ut; }   // a genuinely new arrival (repeat) starts fresh
  }

  let scanT = null;
  const scan = () => {
    if (dead) return;
    renderProfileCard();
    const threadPage = /\/post\//.test(location.pathname);
    const ctx = S.pageContext(location.pathname);
    if (ctx === 'activity') return;   // notifications list: rows there are not posts (a real export showed 49 junk rows from it)
    let first = true;
    document.querySelectorAll(SEL.container).forEach((c) => {
      if (c.dataset.tlId) {
        const old = store.posts[c.dataset.tlId];
        // the Follow badge can render a moment after the post itself: re-check for a few seconds after arrival
        if (old && old.tell && S.isFeedCtx(ctx) && Date.now() - old.tell.t < 5000) {
          const f2 = c.querySelector(SEL.follow) ? false : true;
          if (f2 !== old.followed) { old.followed = f2; if (f2 === false && store.accounts[old.handle]) store.accounts[old.handle].followedSeen = false; rateArrival(old, { repeat: old.tell.rep, ar: old.tell.ar, keepUser: true }); save(); }
        }
        if (!observed.has(c)) { io.observe(c); observed.add(c); }
        ensureBadge(c); return;
      }
      const x = extract(c); if (!x) return;
      c.dataset.tlId = x.id;
      const prev = store.posts[x.id];
      // On the home feed a post without a Follow control is from someone you follow; elsewhere "no control" proves nothing.
      if (x.followed === null && S.isFeedCtx(ctx)) x.followed = true;
      if (prev && S.isFeedCtx(prev.ctx)) pageLoadIds.add(x.id);
      const upgraded = prev && S.isFeedCtx(ctx) && !S.isFeedCtx(prev.ctx);   // first met on a profile, now seen in the feed
      if (upgraded) prev.read = false;
      store.posts[x.id] = Object.assign(prev || { seenAt: Date.now(), dwell: 0, read: false }, x,
        { kind: threadPage && !first ? 'reply' : 'post', ctx: S.isFeedCtx(ctx) ? ctx : (prev && prev.ctx) || ctx });
      first = false;
      const rec = store.posts[x.id];
      if (!prev) { recentPosts.push(rec); if (recentPosts.length > 200) recentPosts.shift(); }
      if (S.isFeedCtx(ctx)) {
        const repeat = !!prev && S.isFeedCtx(prev.ctx) && Date.now() - prev.seenAt > 600e3;   // 10 min guard: Threads recycles nodes while you scroll
        const arrival = !prev || upgraded || repeat;
        if (arrival || !rec.tell) {
          const ar = arrival ? recentFeed.slice(-40).filter((h) => h === rec.handle).length : (rec.tell ? rec.tell.ar : 0);
          rateArrival(rec, { repeat, ar });
          if (arrival) { recentFeed.push(rec.handle); if (recentFeed.length > 80) recentFeed.shift(); }
        }
      }
      if (x.likes != null) {
        const sn = rec.snaps || (rec.snaps = []), last = sn[sn.length - 1];
        if (!last || last[1] !== x.likes) { sn.push([Date.now(), x.likes]); if (sn.length > 20) sn.shift(); }
      }
      const a = store.accounts[x.handle] || (store.accounts[x.handle] = { handle: x.handle });
      a.seen = Date.now();
      if (x.followed === false) a.followedSeen = false;
      if (!prev) { a.postN = (a.postN || 0) + 1; if (featOf(rec).isBait) a.baitN = (a.baitN || 0) + 1; }
      io.observe(c); observed.add(c); ensureBadge(c); save();
    });
  };
  // When Threads removes a post from the page, stop watching it and drop its dwell timer so nothing keeps the node alive.
  const forget = (node) => {
    const list = node.matches && node.matches('[data-tl-id]') ? [node] : [];
    if (node.querySelectorAll) list.push(...node.querySelectorAll('[data-tl-id]'));
    for (const c of list) {
      io.unobserve(c); observed.delete(c);
      const id = c.dataset.tlId;
      if (dwellTimers.has(id)) { clearTimeout(dwellTimers.get(id)); dwellTimers.delete(id); }
    }
  };
  let scanSince = 0;
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.removedNodes) if (n.nodeType === 1) forget(n);
    const now = Date.now(); if (!scanSince) scanSince = now;
    clearTimeout(scanT);   // 500 ms debounce, but never starve a scan for more than 1.5 s of constant page churn
    scanT = setTimeout(() => { scanSince = 0; scan(); }, now - scanSince >= 1500 ? 0 : 500);
  }).observe(document.body, { childList: true, subtree: true });

  function markRead(id) {
    const p = store.posts[id]; if (!p || p.read) return;
    p.read = true; p.dwell = CFG.readMs; store.reads.push(id); save(); refresh();
  }

  // ---------- passive capture of "About this profile" (join date) ----------
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  // ---------- Post activity dialog (likes list) ----------
  const AGO = (t) => { const m = /^(\d+)([smhdw])$/.exec(t || ''); return m ? +m[1] * { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 }[m[2]] : null; };
  const hash = (str) => { let x = 5381; for (const c of str) x = ((x << 5) + x + c.charCodeAt(0)) | 0; return (x >>> 0).toString(36); };
  const FOLLOWTXT = /^(Follow|Following)$/;
  const followBtns = (root) => {
    const all = [...root.querySelectorAll('[role="button"], button')].filter((b) => FOLLOWTXT.test((b.innerText || '').trim()));
    return all.filter((b) => !all.some((o) => o !== b && o.contains(b)));   // outermost only
  };
  // Threads can keep several role=dialog nodes mounted; never assume the first one is the one we want.
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
  const JOINED = /Joined\s*[A-Za-z]+\s*\d{4}/;
  // The "About this profile" sheet: any dialog containing "Joined <Month> <Year>", else any ancestor of a bare "Joined" label.
  const aboutRoot = () => {
    const d = dialogs().find((x) => JOINED.test(x.innerText || ''));
    if (d) return d;
    if (!document.body.textContent.includes('Joined')) return null;
    const leaf = document.evaluate("//*[normalize-space(text())='Joined']", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    for (let el = leaf, i = 0; el && i < 8; el = el.parentElement, i++) {
      const t = el.innerText || '';
      if (JOINED.test(t) && /\(@[\w.]+\)/.test(t)) return el;
    }
    return null;
  };
  const isActivity = (d) => { const t = d ? d.innerText || '' : ''; return /\bLikes\b/.test(t) && !/Joined\s*[A-Za-z]+\s*\d{4}/.test(t); };
  // One entry per row of the list: handle, whether you follow them, minutes since their activity (the "35m" next to the name).
  function activityRows(d) {
    const out = [], btns = followBtns(d);
    for (const btn of btns) {
      let row = btn;
      while (row.parentElement && row.parentElement !== d && followBtns(row.parentElement).length <= 1) row = row.parentElement;
      const link = row.querySelector('a[href^="/@"]');
      const tokens = (row.innerText || '').trim().split(/\s+/);
      const hl = link && (link.getAttribute('href').match(/^\/@([^/?#]+)/) || [])[1];
      const h = hl ? decodeURIComponent(hl) : tokens[0];
      if (!h || !/^[\w.]+$/.test(h) || FOLLOWTXT.test(h)) continue;
      const tIdx = tokens.findIndex((x) => /^\d+[smhdw]$/.test(x));
      out.push({ h, following: btn.innerText.trim() === 'Following', ago: tIdx >= 0 ? AGO(tokens[tIdx]) : null });
    }
    return out;
  }
  let activityKey = null, activityOpen = false;
  function captureLikers() {
    const d = dialogs().find(isActivity); if (!d) return 0;
    const txt = d.innerText || '', head = txt.split(/\bLikes\b/)[0];
    const pm = location.pathname.match(/^\/@([^/]+)\/post\/([^/?#]+)/);
    const owner = pm ? decodeURIComponent(pm[1]) : (head.match(/(?:Sort|Post activity)\s+(\S+)/) || [])[1];
    if (!owner) return 0;
    if (!store.settings.me && /\bInsights\b/.test(txt)) store.settings.me = owner;   // only your own posts have Insights
    const pid = pm ? pm[2] : 'h' + hash(head.replace(/\s+/g, ' ').slice(-120)), key = owner + '/' + pid;
    activityKey = key;
    const now = Date.now();
    const L = store.likers[key] || (store.likers[key] = { owner, pid, firstSeen: now, handles: {}, when: {} });
    L.when = L.when || {};
    const postAgo = AGO((head.match(/\b(\d+[smhdw])\b/) || [])[1]);
    if (postAgo != null && !L.postAt) L.postAt = now - postAgo * 60e3;
    let entries = activityRows(d);
    if (!entries.length) {   // fallback: any profile links in the dialog
      entries = [...d.querySelectorAll('a[href^="/@"]')].map((l) => (l.getAttribute('href').match(/^\/@([^/?#]+)\/?$/) || [])[1]).filter(Boolean)
        .map((h) => ({ h: decodeURIComponent(h), following: false, ago: null }));
    }
    let added = 0;
    for (const e of entries) {
      if (e.h === owner || L.handles[e.h]) continue;
      L.handles[e.h] = now; added++;
      if (e.ago != null) L.when[e.h] = now - e.ago * 60e3;
      const a = store.accounts[e.h] || (store.accounts[e.h] = { handle: e.h });
      a.liker = true;
      if (!e.following && a.followedSeen === undefined) a.followedSeen = false;
      const lp = a.likedPosts || (a.likedPosts = []);
      if (!lp.includes(key)) { lp.push(key); if (lp.length > 100) lp.shift(); }
    }
    if (added) { L.lastSeen = now; const p = store.posts[pid]; if (p) { L.total = p.likes; L.postTs = p.ts; } save(); refresh(); }
    return added;
  }

  // The scrollable list inside the dialog.
  const scrollerOf = (d) => [d, ...d.querySelectorAll('*')]
    .filter((e) => e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  let scanning = false, scanStop = false, deepActive = false;
  const likerCount = () => Object.keys((store.likers[activityKey] || {}).handles || {}).length;
  // User-initiated: scrolls ONLY the open dialog, at a human pace (about 55-75% of a screen every 1.4-3 s), until the end, a cap or Stop.
  async function scanLikes() {
    if (scanning) { scanStop = true; return; }
    scanning = true; scanStop = false; refresh();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      let still = 0, last = -1;
      for (let step = 0; step < 300 && !scanStop && !dead; step++) {
        const d = dialogs().find(isActivity); if (!d) break;
        const sc = scrollerOf(d); if (!sc) break;
        captureLikers();
        sc.scrollBy({ top: Math.round(sc.clientHeight * (0.55 + Math.random() * 0.2)), behavior: 'smooth' });
        await sleep(1400 + Math.random() * 1600);
        while (document.visibilityState !== 'visible' && !scanStop) await sleep(1000);
        captureLikers();
        const n = likerCount(), atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 6;
        still = atEnd && n === last ? still + 1 : 0; last = n;
        if (still >= 2 || n >= 600) break;
      }
    } finally { scanning = false; refresh(); }
  }
  setInterval(() => {
    if (dead) return;
    if (profileHandle()) renderProfileCard();
    if (!scanning) captureLikers();
    const act = dialogs().some(isActivity);
    if (act !== activityOpen) { activityOpen = act; refresh(); }
    const d = aboutRoot(); if (!d) return;
    const txt = d.innerText || d.textContent;
    const m = txt.match(/Joined\s*([A-Za-z]+)\s*(\d{4})/); if (!m) return;
    const link = d.querySelector('a[href^="/@"]');
    const tm = txt.match(/\(@([\w.]+)\)/);
    const handle = tm ? tm[1] : link ? link.getAttribute('href').replace(/^\/@/, '').split('/')[0] : (location.pathname.match(/^\/@([^/]+)/) || [])[1];
    const mo = MONTHS[m[1].toLowerCase()]; if (!handle || !mo) return;
    const a = store.accounts[handle] || (store.accounts[handle] = { handle });
    const ym = m[2] + '-' + String(mo).padStart(2, '0');
    const extra = ((txt.match(/Joined\s*[A-Za-z]+\s*\d{4}\s*[·•]\s*([^\n]+)/) || [])[1] || '').trim();   // e.g. "100M+": meaning unknown, kept raw
    // Only write when something changed: this runs every 1.5 s while the sheet is open, and an unconditional save() keeps resetting the debounce.
    if (a.joined !== ym || (extra && a.joinedNote !== extra)) { a.joined = ym; if (extra) a.joinedNote = extra; save(); refresh(); }
  }, 1500);

  // ---------- slow background profile lookups ----------
  const parseProfile = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = (p) => (doc.querySelector('meta[property="' + p + '"]') || {}).content || '';
    const desc = meta('og:description');
    const f = desc.match(/([\d.,]+\s*[KMB]?)\s+Followers/i), t = desc.match(/([\d.,]+\s*[KMB]?)\s+Threads/i);
    const bio = S.cleanBio(desc);
    return { name: meta('og:title').replace(/\s*\(@.*$/, ''), followers: f ? parseCount(f[1]) : null, threads: t ? parseCount(t[1]) : null, bio };
  };
  setInterval(async () => {
    const now = Date.now();
    const deep = deepActive;   // user pressed "Look up these accounts": liker list only, faster pacing, hard cap
    if (dead || (!store.settings.glance && !deep) || document.visibilityState !== 'visible') return;
    if ((!deep && now - lastInput > CFG.fetch.idleMs) || now < backoffUntil || now - lastFetch < nextGap) return;
    while (fetchLog.length && now - fetchLog[0] > 3600e3) fetchLog.shift();
    if (fetchLog.length >= (deep ? 90 : CFG.fetch.perHour)) return;
    const readHandles = new Set(Object.values(store.posts).filter((p) => p.read).map((p) => p.handle));
    const queue = deep
      ? Object.keys((store.likers[activityKey] || {}).handles || {}).map((h) => store.accounts[h]).filter((a) => a && !a.fetchedAt)
      : Object.values(store.accounts).filter((a) => !a.fetchedAt && a.followedSeen === false && (readHandles.has(a.handle) || a.liker));
    if (!queue.length) { if (deep) { deepActive = false; refresh(); } return; }
    // most recently read first
    const lastSeen = (h) => (store.accounts[h] && store.accounts[h].liker ? Date.now() : 0) + Math.max(0, ...Object.values(store.posts).filter((p) => p.handle === h && p.read).map((p) => p.seenAt));
    queue.sort((a, b) => lastSeen(b.handle) - lastSeen(a.handle));
    const a = queue[0];
    lastFetch = now; nextGap = deep ? 20000 + Math.random() * 25000 : CFG.fetch.minGap + Math.random() * (CFG.fetch.maxGap - CFG.fetch.minGap);
    fetchLog.push(now);
    try {
      const r = await fetch('/@' + encodeURIComponent(a.handle), { credentials: 'include' });
      if (r.status === 429 || r.status >= 500) { backoffUntil = now + 15 * 60e3; return; }
      if (r.ok) Object.assign(a, parseProfile(await r.text()), { fetchedAt: Date.now() });
      else a.fetchedAt = Date.now();
      save(); refresh();
    } catch { backoffUntil = now + 5 * 60e3; }
  }, 5000);
  ['scroll', 'mousemove', 'keydown', 'click', 'wheel'].forEach((ev) =>
    addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));

  // ---------- scoring glue ----------
  let spikes = new Set();
  const acctScore = (h) => {
    const a = store.accounts[h]; if (!a) return { level: 'unknown', score: 0, reasons: [] };
    a.cohortSpike = !!(a.joined && spikes.has(a.joined));
    let res = S.scoreAccount(a, CFG.watchCohorts);
    const r = a.rating || 0;
    if (a.postN >= 3 && a.baitN / a.postN >= 0.4) {
      const sc0 = Math.min(1, res.score + 0.15);
      res = { score: +sc0.toFixed(2), reasons: res.reasons.concat(a.baitN + ' of ' + a.postN + ' posts you saw are engagement bait'),
        level: sc0 >= 0.5 ? 'flag' : sc0 >= 0.25 ? 'watch' : 'ok' };
    }
    if (!r) return res;
    const sc = Math.max(0, Math.min(1, res.score - r * 0.2));
    return { score: +sc.toFixed(2), reasons: res.reasons.concat('you rated ' + (r > 0 ? '+' : '') + r),
      level: r >= 2 ? 'ok' : r <= -2 ? 'flag' : sc >= 0.5 ? 'flag' : (sc >= 0.25 || r < 0) ? 'watch' : 'ok' };
  };
  const itemFor = (id) => {
    const p = store.posts[id]; if (!p) return null;
    const tk = p.tell ? (p.tell.u || p.tell.k) : null;   // your re-categorization wins over the automatic label
    const tell = p.tell ? { key: tk, label: TELL_NAME[tk], score: p.tell.u ? 1 : p.tell.s, reasons: p.tell.r || [], also: p.tell.a || [], scores: {}, user: !!p.tell.u, auto: p.tell.k } : null;
    return { rec: p, f: featOf(p), acct: acctScore(p.handle), followed: p.followed,
      ageH: p.ts ? (Date.now() - p.ts) / 3600e3 : null, repeat: pageLoadIds.has(id), authorRecent: p.tell ? p.tell.ar : 0, tell };
  };

  // ---------- overlay ----------
  const COLORS = { normal: '#2e9e5b', baseline: '#6b7c93', throttled: '#d99a1c', emotional: '#d9482b', shaped: '#8a4fd1', neutral: '#6e6e6e', mixed: '#7a7a7a', calibrating: '#7a7a7a' };
  const TELL_NAME = { normal: 'Normal', baseline: 'Baseline', throttled: 'Throttled', emotional: 'Emotional', shaped: 'Shaped', neutral: 'Neutral' };
  const NAMES = { normal: 'Normal', baseline: 'Baseline/thin', throttled: 'Throttled?', emotional: 'Emotional pull', shaped: 'Shaped' };
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:8px;right:12px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    '.bar{font:12px/1.35 -apple-system,system-ui,sans-serif;background:#111c;color:#fff;border-radius:10px;padding:8px 10px;width:260px;backdrop-filter:blur(8px);box-shadow:0 2px 12px #0006;cursor:pointer}' +
    '.top{display:flex;align-items:center;gap:6px;font-weight:600}.dot{width:10px;height:10px;border-radius:50%}' +
    '.row{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:11px}.row span:first-child{width:92px;opacity:.8}' +
    '.track{flex:1;height:5px;background:#fff3;border-radius:3px;overflow:hidden}.fill{height:100%}' +
    '.det{margin-top:6px;font-size:11px;opacity:.9;border-top:1px solid #fff3;padding-top:6px}.det div{margin:2px 0}' +
    'button{font:11px system-ui;margin:6px 4px 0 0;padding:2px 7px;border-radius:5px;border:1px solid #fff5;background:#fff2;color:#fff;cursor:pointer}' +
    '</style><div class="bar" id="bar"></div>';
  document.documentElement.appendChild(host);
  let open = false;
  const h = (tag, props = {}, kids = []) => {
    const e = document.createElement(tag); Object.assign(e, props);
    kids.forEach((k) => e.append(k)); return e;
  };

  const csv = (rows) => rows.map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\n/g, ' ') + '"').join(',')).join('\n');
  const download = (name, text, type = 'text/csv') => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);   // a blob URL pins its data in memory until revoked
  };
  const exportAll = () => {
    download('threadslens-posts.csv', csv([['id', 'handle', 'kind', 'text', 'posted', 'likes', 'replies', 'reposts', 'followed', 'read', 'tags', 'seen', 'ctx', 'telltale', 'telltale_why', 'telltale_user']]
      .concat(Object.values(store.posts).map((p) => [p.id, p.handle, p.kind, p.text, p.ts ? new Date(p.ts).toISOString() : '', p.likes, p.replies, p.reposts, p.followed, p.read, featOf(p).tags.join('; '), new Date(p.seenAt).toISOString(), p.ctx || '', p.tell ? p.tell.k : '', p.tell ? (p.tell.r || []).join('; ') : '', p.tell && p.tell.u ? p.tell.u : '']))));
    download('threadslens-likers.csv', csv([['post_owner', 'post_id', 'post_posted', 'liker', 'level', 'score', 'joined', 'followers', 'threads', 'your_rating', 'captured', 'liked_min_after_post']]
      .concat(Object.values(store.likers).flatMap((L) => Object.entries(L.handles).map(([hd, t]) => {
        const a = store.accounts[hd] || {}, sc = acctScore(hd);
        return [L.owner, L.pid, L.postTs ? new Date(L.postTs).toISOString() : '', hd, sc.level, sc.score, a.joined, a.followers, a.threads, a.rating || 0, new Date(t).toISOString(), L.when && L.when[hd] && L.postAt ? Math.round((L.when[hd] - L.postAt) / 60e3) : ''];
      })))));
    download('threadslens-accounts.csv', csv([['handle', 'joined', 'followers', 'threads', 'bio', 'level', 'score', 'verdict', 'confidence', 'your_rating', 'reasons', 'threads_seen', 'replies_seen', 'reposts_seen']]
      .concat(Object.values(store.accounts).map((a) => { const s = acctScore(a.handle), jd = judgeFor(a.handle); return [a.handle, a.joined, a.followers, a.threads, a.bio, s.level, s.score, jd.label, jd.confidence, a.rating || 0, s.reasons.join('; '), ...['threads', 'replies', 'reposts'].map((k) => (a.tabs && a.tabs[k] ? a.tabs[k].n + (a.tabs[k].complete ? '' : '+') : ''))]; }))));
  };

  // ---------- liker stats ----------
  function likerStats() {
    const by = {};
    for (const L of Object.values(store.likers)) {
      const o = by[L.owner] || (by[L.owner] = { owner: L.owner, posts: 0, shown: 0, total: 0, set: new Set(), delays: [] });
      for (const [hd, t] of Object.entries(L.when || {})) if (L.postAt) o.delays.push((t - L.postAt) / 60e3);
      o.posts++; o.shown += Object.keys(L.handles).length; o.total += L.total || 0;
      Object.keys(L.handles).forEach((h) => o.set.add(h));
    }
    return Object.values(by).map((o) => {
      const hs = [...o.set], sc = hs.map(acctScore), acc = (h) => store.accounts[h] || {};
      return { owner: o.owner, posts: o.posts, n: hs.length, shown: o.shown, total: o.total,
        flag: sc.filter((x) => x.level === 'flag').length, watch: sc.filter((x) => x.level === 'watch').length,
        unknown: sc.filter((x) => x.level === 'unknown').length,
        delays: o.delays.length, medDelay: o.delays.length ? [...o.delays].sort((x, y) => x - y)[o.delays.length >> 1] : null,
        early: o.delays.length ? o.delays.filter((x) => x <= 60).length / o.delays.length : null,
        suspects: hs.map((h) => ({ h, s: acctScore(h) })).filter((x) => x.s.level === 'flag' || x.s.level === 'watch').sort((x, y) => y.s.score - x.s.score).slice(0, 6),
        recent: hs.filter((h) => acc(h).joined && S.monthsAgo(acc(h).joined) <= 3).length,
        spike: hs.filter((h) => acc(h).joined && spikes.has(acc(h).joined)).length };
    }).sort((a, b) => b.posts - a.posts).slice(0, 3);
  }
  // Likes that arrived while a post was older than 24h, from your own count snapshots (only posts whose likes list you opened).
  function lateLikes() {
    const owners = new Set(Object.values(store.likers).map((l) => l.owner));
    let gained = 0, posts = 0;
    for (const p of Object.values(store.posts)) {
      const sn = p.snaps; if (!owners.has(p.handle) || !sn || sn.length < 2 || !p.ts) continue;
      let g = 0;
      for (let i = 1; i < sn.length; i++) if ((sn[i][0] - p.ts) / 3.6e6 > 24 && sn[i][1] > sn[i - 1][1]) g += sn[i][1] - sn[i - 1][1];
      if (g) { gained += g; posts++; }
    }
    return { gained, posts };
  }

  // ---------- 48h history of the feed readings ----------
  const HOUR = 3600e3;
  function sampleHistory(st) {
    const now = Date.now(), last = store.history.length ? store.history[store.history.length - 1].t : 0;
    if (st.key === 'calibrating' || now - last < 5 * 60e3) return;
    const pt = { t: now };
    for (const [k, v] of Object.entries(st.scores)) pt[k] = +v.toFixed(2);
    store.history.push(pt);
    while (store.history.length && store.history[0].t < now - 48 * HOUR) store.history.shift();
    save();
  }
  const sv = (tag, attrs = {}) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  function historyGraph() {
    const now = Date.now(), W = 240, H = 58, T = 4, B = 14, keys = Object.keys(NAMES);
    const BK = 192, buckets = Array.from({ length: BK }, () => null);   // 15-minute buckets over 48h
    for (const p of store.history) {
      const i = BK - 1 - Math.floor((now - p.t) / (HOUR / 4)); if (i < 0 || i > BK - 1) continue;
      const b = buckets[i] || (buckets[i] = { n: 0 }); b.n++;
      for (const k of keys) b[k] = (b[k] || 0) + (p[k] || 0);
    }
    const msg = (t) => h('div', { textContent: t, style: 'opacity:.6;font-size:10px;margin-top:6px' });
    if (store.history.length < 2 || buckets.filter(Boolean).length < 2) {
      return msg('Last 48h: ' + store.history.length + ' reading(s) so far; a reading is saved every 5 min once 10 posts are read.');
    }
    const x = (i) => (((i + 0.5) / BK) * W).toFixed(1), y = (v) => (T + (1 - v) * (H - T - B)).toFixed(1);
    const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, style: 'display:block;margin-top:6px' });
    [0, 0.5, 1].forEach((g) => svg.append(sv('line', { x1: 0, x2: W, y1: y(g), y2: y(g), stroke: '#fff', 'stroke-opacity': 0.15, 'stroke-width': 1 })));
    for (const k of keys) {
      let d = '';
      buckets.forEach((b, i) => {
        if (!b) return;
        d += (buckets[i - 1] ? 'L' : 'M') + x(i) + ' ' + y(b[k] / b.n);
        if (!buckets[i - 1] && !buckets[i + 1]) svg.append(sv('circle', { cx: x(i), cy: y(b[k] / b.n), r: 1.6, fill: COLORS[k] }));
      });
      svg.append(sv('path', { d, fill: 'none', stroke: COLORS[k], 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    [['48h ago', 0, 'start'], ['24h', W / 2, 'middle'], ['now', W, 'end']].forEach(([t, px, anchor]) => {
      const tx = sv('text', { x: px, y: H - 3, 'text-anchor': anchor, 'font-size': 9, fill: '#fff', 'fill-opacity': 0.6 }); tx.textContent = t; svg.append(tx);
    });
    const box = h('div', {}, [svg]); box.title = 'Feed readings over the last 48 hours, 15-minute average (same colors as the bars above)';
    return box;
  }

  // Structure-only snapshot of a few visible posts (tags, roles, short UI labels, counts; NO post text, usernames or long labels).
  // Lets selectors be fixed from a real page without sharing anyone's content.
  function skeleton(el, depth = 0, budget = { n: 0 }) {
    if (!el || depth > 16 || budget.n++ > 700 || (el.classList && el.classList.contains('tl-badge'))) return null;
    const o = { t: el.tagName.toLowerCase() };
    for (const a of ['role', 'aria-label', 'aria-selected', 'dir', 'datetime', 'data-pressable-container', 'href']) {
      let v = el.getAttribute && el.getAttribute(a); if (v == null) continue;
      if (a === 'href') v = v.replace(/^\/@[^/?#]+/, '/@USER').replace(/post\/[^/?#]+/, 'post/ID').replace(/[?#].*$/, '');
      else if (a === 'aria-label' && (v.length > 24 || v.includes('@'))) v = '[' + v.length + ' chars]';
      o[a] = v;
    }
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) o.text = /^[\d.,]+\s?[KMB]?$|^\d+\s?[smhdw]$|^(Like|Reply|Repost|Share|Follow|Following|Translate|More|Quote)$/i.test(own) ? own : '[' + own.length + ' chars]';
    const kids = [...el.children].map((k) => skeleton(k, depth + 1, budget)).filter(Boolean);
    if (kids.length) o.c = kids;
    return o;
  }
  const exportDomSample = () => {
    const vis = [...document.querySelectorAll(SEL.container)].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).slice(0, 3);
    download('threadslens-dom-sample.json', JSON.stringify({ path: location.pathname.replace(/@[^/]+/, '@USER').replace(/post\/[^/?#]+/, 'post/ID'), ctx: S.pageContext(location.pathname), version, containers: vis.map((c) => skeleton(c)) }, null, 1), 'application/json');
  };

  const version = (() => { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })();
  // Merge a backup into the current store. Existing values win; the backup only fills gaps and adds unseen items.
  function mergeStore(inc) {
    for (const [k, v] of Object.entries(inc.accounts || {})) {
      const ex = store.accounts[k] || {};
      const merged = Object.assign({}, v, ex);
      if (v.rating && !ex.rating) merged.rating = v.rating;
      merged.likedPosts = [...new Set([...(v.likedPosts || []), ...(ex.likedPosts || [])])].slice(-100);
      store.accounts[k] = merged;
    }
    for (const [k, v] of Object.entries(inc.posts || {})) {
      const ex = store.posts[k]; store.posts[k] = Object.assign({}, v, ex || {});
      if (ex && v.read) store.posts[k].read = true;
    }
    for (const [k, v] of Object.entries(inc.likers || {})) {
      const ex = store.likers[k] || {}; store.likers[k] = Object.assign({}, v, ex, { handles: Object.assign({}, v.handles, ex.handles), when: Object.assign({}, v.when, ex.when) });
    }
    const seen = new Set(store.history.map((p) => p.t));
    store.history = store.history.concat((inc.history || []).filter((p) => !seen.has(p.t))).sort((a, b) => a.t - b.t)
      .filter((p) => p.t > Date.now() - 48 * HOUR);
  }
  const importBackup = () => {
    const inp = h('input', { type: 'file', accept: '.json,application/json' });
    inp.onchange = async () => {
      try { mergeStore(JSON.parse(await inp.files[0].text())); save(); refresh(); alert('Backup merged.'); }
      catch { alert('That file is not a valid ThreadsLens backup.'); }
    };
    inp.click();
  };

  function refresh() {
    if (dead) return;
    spikes = S.cohortSpikes(store.accounts);
    const feedReads = store.reads.filter((id) => { const p = store.posts[id]; return p && S.isFeedCtx(p.ctx) && p.handle !== store.settings.me; });
    const items = feedReads.slice(-CFG.window).map(itemFor).filter(Boolean);
    const st = S.feedState(items, CFG.minWindow);
    sampleHistory(st);
    const bar = root.getElementById('bar'); bar.replaceChildren();
    bar.append(h('div', { className: 'top' }, [h('span', { className: 'dot', style: 'background:' + COLORS[st.key] }), st.label]));
    for (const [k, v] of Object.entries(st.scores)) {
      const fill = h('div', { className: 'fill', style: 'width:' + Math.round(v * 100) + '%;background:' + COLORS[k] });
      bar.append(h('div', { className: 'row' }, [h('span', { textContent: NAMES[k] }), h('div', { className: 'track' }, [fill]), h('span', { textContent: Math.round(v * 100) + '%', style: 'width:28px;text-align:right' })]));
    }
    bar.append(historyGraph());
    if (activityOpen || scanning || deepActive) {
      const n = likerCount(), got = Object.keys((store.likers[activityKey] || {}).handles || {}).filter((hd) => (store.accounts[hd] || {}).fetchedAt).length;
      const act = h('div', { className: 'det' }, [h('div', { textContent: 'Post activity: ' + n + ' accounts captured · ' + got + ' looked up' })]);
      act.append(h('button', { textContent: scanning ? 'Stop scan' : 'Scan likers in this list', title: 'Scrolls only this dialog at a human pace and records each account', onclick: (e) => { e.stopPropagation(); scanLikes(); } }));
      if (n) act.append(h('button', { textContent: deepActive ? 'Stop lookups' : 'Look up these accounts', title: 'One profile every 20-45 s (max 90/hour) to get join date and followers; stops when done', onclick: (e) => { e.stopPropagation(); deepActive = !deepActive; refresh(); } }));
      bar.append(act);
    }
    if (open) {
      const det = h('div', { className: 'det' }, st.evidence.map((t) => h('div', { textContent: t })));
      const accts = Object.values(store.accounts);
      det.append(h('div', { textContent: 'accounts: ' + accts.length + ' seen · ' + accts.filter((a) => a.fetchedAt).length + ' looked up · ' + accts.filter((a) => a.joined).length + ' with join date' + (spikes.size ? ' · join spikes: ' + [...spikes].join(', ') : '') }));
      const hs = stats();
      det.append(h('div', { textContent: 'Memory: ' + hs.posts.toLocaleString() + ' posts · ' + hs.accounts.toLocaleString() + ' accounts · ' + (hs.kb >= 1024 ? (hs.kb / 1024).toFixed(1) + ' MB' : hs.kb + ' KB') + ' stored · ' + hs.pills + ' live pills' + (hs.heapMB ? ' · page heap ' + hs.heapMB + ' MB' : ''), style: 'opacity:.7;margin-top:6px' }));
      if (hs.corrections) det.append(h('div', { textContent: 'You have re-categorized ' + hs.corrections + ' post(s).', style: 'opacity:.7' }));
      const ls = likerStats();
      if (ls.length) {
        det.append(h('div', { textContent: 'Likers (from likes lists you opened):', style: 'margin-top:6px;font-weight:600' }));
        for (const o of ls) {
          const pc = (x) => (o.n ? Math.round((x / o.n) * 100) + '%' : '0%');
          det.append(h('div', { textContent: '@' + o.owner + ': ' + o.n + ' likers over ' + o.posts + ' post(s)' + (o.total ? ' (captured ' + o.shown + ' of ~' + o.total + ' likes)' : '') + ' · flagged ' + pc(o.flag) + ' · watch ' + pc(o.watch) + ' · joined ≤3 mo ' + pc(o.recent) + ' · join-spike months ' + pc(o.spike) + ' · no data yet ' + pc(o.unknown) }));
          if (o.delays) det.append(h('div', { textContent: 'Like timing (' + o.delays + ' likes, minute/hour resolution): median ' + (o.medDelay < 90 ? Math.round(o.medDelay) + ' min' : (o.medDelay / 60).toFixed(1) + ' h') + ' after posting · ' + Math.round(o.early * 100) + '% within the first hour', style: 'opacity:.8' }));
          if (o.suspects.length) det.append(h('div', { textContent: 'Top suspects: ' + o.suspects.map((x) => '@' + x.h + ' ' + Math.round(x.s.score * 100) + '%').join(' · '), style: 'opacity:.8' }));
        }
        const ll = lateLikes();
        det.append(h('div', { textContent: ll.posts ? 'Late likes: ' + ll.gained + ' like(s) arrived after 24h across ' + ll.posts + ' of your post(s).' : 'Late likes: none recorded yet (needs revisits to your posts over several days).', style: 'opacity:.8' }));
      }
      const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
      const rt = h('input', { type: 'checkbox', checked: store.settings.rate !== false, onchange: (e) => { e.stopPropagation(); store.settings.rate = rt.checked; save(); refresh(); } });
      rt.onclick = (e) => e.stopPropagation();
      det.append(h('label', { title: 'Show a Normal / Baseline / Throttled / Emotional / Shaped / Neutral chip on each home-feed post', style: 'display:flex;gap:6px;align-items:center;margin-top:6px;cursor:pointer' }, [rt, h('span', { textContent: 'Rate each post' })]));
      const sw = h('input', { type: 'checkbox', checked: !!store.settings.glance, onchange: (e) => { e.stopPropagation(); store.settings.glance = sw.checked; save(); refresh(); } });
      sw.onclick = (e) => e.stopPropagation();
      det.append(h('label', { title: 'Review user accounts I look at explicitly', style: 'display:flex;gap:6px;align-items:center;margin-top:6px;cursor:pointer' }, [sw, h('span', { textContent: 'User glance' })]));
      det.append(h('div', { textContent: store.settings.glance ? 'Looking up accounts of posts you read, slowly.' : 'Off: reads only what is on screen; no extra requests.', style: 'opacity:.7' }));
      det.append(h('button', { textContent: 'Export CSV', onclick: stop(exportAll) }));
      det.append(h('button', { textContent: 'Export DOM sample', title: 'Structure of the posts on screen, with no post text or usernames. For fixing the page-reading code.', onclick: stop(exportDomSample) }));
      det.append(h('button', { textContent: 'Backup JSON', title: 'Full backup you can import on another computer', onclick: stop(() => download('threadslens-backup.json', JSON.stringify(store), 'application/json')) }));
      det.append(h('button', { textContent: 'Import backup', title: 'Merge a backup JSON; your current values win, the backup fills gaps', onclick: stop(importBackup) }));
      det.append(h('button', { textContent: 'Clear data', onclick: stop(() => { if (confirm('Delete all ThreadsLens data?')) { store = { posts: {}, accounts: {}, reads: [], likers: {}, history: [], settings: { glance: false } }; if (hasChrome) chrome.storage.local.remove('tl'); refresh(); } }) }));
      det.append(h('div', { textContent: 'Signals, not verdicts. Real people trip these too. · ThreadsLens v' + version, style: 'opacity:.6;margin-top:6px' }));
      bar.append(det);
    }
    document.querySelectorAll('[data-tl-id]').forEach(ensureBadge);
    renderProfileCard();
  }
  root.getElementById('bar').addEventListener('click', () => { open = !open; refresh(); });

  // ---------- per-post badge: dot + manual genuineness rating (- 0 +) ----------
  const rate = (handle, d, axis = 'rating') => {
    const a = store.accounts[handle] || (store.accounts[handle] = { handle });
    a[axis] = d === 0 ? 0 : Math.max(-3, Math.min(3, (a[axis] || 0) + d));
    save(); refresh();
  };
  // Golden pulse for BAIT chips, driven by ONE shared timer that restyles the chips currently on the page.
  // A per-chip Element.animate() with infinite iterations kept every removed post (and its whole subtree) alive: found with a WeakRef leak test.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setInterval(() => {
      if (dead || document.visibilityState !== 'visible') return;
      const k = (Math.sin((Date.now() / 1600) * 2 * Math.PI) + 1) / 2;
      const shadow = '0 0 ' + (2 + 8 * k).toFixed(1) + 'px ' + (3 * k).toFixed(1) + 'px rgba(255,204,0,' + (0.6 + 0.4 * k).toFixed(2) + ')';
      for (const chip of document.querySelectorAll('.tl-bait')) if (chip.style.display !== 'none') chip.style.boxShadow = shadow;
    }, 100);
  }

  // ---------- re-categorize a post (click its chip) ----------
  let tellMenu = null;
  const menuOutside = (e) => { if (tellMenu && !e.composedPath().includes(tellMenu)) closeTellMenu(); };
  const menuKey = (e) => { if (e.key === 'Escape') closeTellMenu(); };
  function closeTellMenu() {
    if (!tellMenu) return;
    tellMenu.remove(); tellMenu = null;
    document.removeEventListener('pointerdown', menuOutside, true);
    document.removeEventListener('keydown', menuKey, true);
    removeEventListener('scroll', closeTellMenu, true);
  }
  function chooseTell(rec, key) {
    if (key && key !== rec.tell.k) { rec.tell.u = key; rec.tell.ut = Date.now(); }
    else { delete rec.tell.u; delete rec.tell.ut; }   // picking the automatic label, or Undo, clears your override
    closeTellMenu(); save(); refresh();
  }
  function openTellMenu(rec, anchor) {
    closeTellMenu();
    const host = document.createElement('div'), sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = '<style>.m{font:12px/1.4 -apple-system,system-ui,sans-serif;background:#1b1b1bf2;color:#fff;border-radius:10px;padding:6px;box-shadow:0 4px 18px #000a;min-width:200px}' +
      '.t{opacity:.65;padding:2px 8px 6px;font-size:11px;max-width:230px}.o{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer}' +
      '.o:hover{background:#ffffff1f}.d{width:10px;height:10px;border-radius:50%}.on{font-weight:700}.a{opacity:.55;font-weight:400}.x{border-top:1px solid #fff3;margin-top:4px;padding-top:7px;opacity:.8}</style><div class="m" id="m"></div>';
    const m = sh.getElementById('m'), cur = rec.tell.u || rec.tell.k;
    m.append(h('div', { className: 't', textContent: rec.tell.u ? 'You set ' + TELL_NAME[rec.tell.u] + ' (automatic said ' + TELL_NAME[rec.tell.k] + ')' : 'Re-categorize this post (automatic says ' + TELL_NAME[rec.tell.k] + ')' }));
    for (const k of ['normal', 'neutral', 'throttled', 'baseline', 'emotional', 'shaped']) {
      m.append(h('div', { className: 'o' + (k === cur ? ' on' : ''), onclick: (e) => { e.stopPropagation(); chooseTell(rec, k); } },
        [h('span', { className: 'd', style: 'background:' + COLORS[k] }), TELL_NAME[k], h('span', { className: 'a', textContent: k === rec.tell.k ? 'automatic' : '' })]));
    }
    if (rec.tell.u) m.append(h('div', { className: 'o x', textContent: 'Undo: back to automatic', onclick: (e) => { e.stopPropagation(); chooseTell(rec, null); } }));
    document.documentElement.append(host);
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0';
    const r = anchor.getBoundingClientRect(), mr = m.getBoundingClientRect();
    host.style.left = Math.max(8, Math.min(innerWidth - mr.width - 8, r.left)) + 'px';
    host.style.top = (r.top - mr.height - 6 >= 8 ? r.top - mr.height - 6 : Math.max(8, Math.min(innerHeight - mr.height - 8, r.bottom + 6))) + 'px';
    tellMenu = host;
    document.addEventListener('pointerdown', menuOutside, true);
    document.addEventListener('keydown', menuKey, true);
    addEventListener('scroll', closeTellMenu, true);
  }

  // ---------- health: what this extension is holding in memory ----------
  let sizeCache = { t: 0, bytes: 0 };
  const stats = () => {
    const now = Date.now();
    if (now - sizeCache.t > 15000) sizeCache = { t: now, bytes: JSON.stringify(store).length };
    const posts = Object.values(store.posts);
    return { posts: posts.length, accounts: Object.keys(store.accounts).length, likers: Object.keys(store.likers).length, history: store.history.length,
      kb: Math.round(sizeCache.bytes / 1024), pills: document.querySelectorAll('.tl-badge').length, featCache: featCache.size, timers: dwellTimers.size, recent: recentPosts.length,
      corrections: posts.filter((p) => p.tell && p.tell.u).length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
  };
  window.__tlStats = stats;

  // Put the pill at the end of the Like/Reply/Repost/Share row; fall back to the post's bottom-right corner.
  function placeInActionRow(c, b) {
    const like = c.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]');
    let row = like && like.parentElement;
    while (row && row !== c && !row.querySelector('svg[aria-label="Reply"]')) row = row.parentElement;
    if (row && row !== c && row.querySelector('svg[aria-label="Repost"]')) {
      if (b.parentElement !== row) row.append(b);
      b.style.position = 'static'; b.style.marginLeft = 'auto'; b.style.alignSelf = 'center';
    } else if (b.parentElement !== c) {
      c.append(b); b.style.position = 'absolute'; b.style.marginLeft = '';
    }
  }
  function ensureBadge(c) {
    if (!c.isConnected) return;
    const id = c.dataset.tlId, it = itemFor(id); if (!it) return;
    let b = c.querySelector('.tl-badge');
    if (!b) {
      if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
      b = document.createElement('div'); b.className = 'tl-badge';
      b.style.cssText = 'position:absolute;bottom:6px;right:6px;z-index:5;display:flex;align-items:center;gap:2px;padding:2px 5px;border-radius:10px;background:#111b;color:#fff;font:600 11px system-ui;user-select:none';
      ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((ev) =>
        b.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === 'click') e.preventDefault(); }));
      const mk = (cls, txt, title, css, fn) => {
        const e = document.createElement('span'); e.className = cls; e.textContent = txt; e.title = title; e.style.cssText = css;
        if (fn) e.addEventListener('click', () => fn(store.posts[c.dataset.tlId].handle)); return e;
      };
      const grp = (label, axis, tipL, tipM, tipP) => {
        const g = document.createElement('span'); g.style.cssText = 'display:inline-flex;align-items:center;margin-left:5px';
        g.append(mk('tl-l', label, tipL, 'opacity:.7;margin-right:2px'),
          mk('tl-m-' + axis, '\u2212', tipM, 'cursor:pointer;padding:0 3px', (h) => rate(h, -1, axis)),
          mk('tl-v-' + axis, '0', 'Click to reset', 'min-width:16px;text-align:center;cursor:pointer', (h) => rate(h, 0, axis)),
          mk('tl-p-' + axis, '+', tipP, 'cursor:pointer;padding:0 3px', (h) => rate(h, 1, axis)));
        return g;
      };
      const chip = mk('tl-bait', 'BAIT', '', 'display:none;margin-left:5px;padding:0 6px;border-radius:8px;font:800 9px/15px system-ui;letter-spacing:.5px;color:#3a2a00;background:linear-gradient(135deg,#ffe27a,#d4a017)');
      const tellChip = mk('tl-tell', '', '', 'display:none;margin-left:4px;padding:0 6px;border-radius:8px;font:800 9px/15px system-ui;letter-spacing:.5px;color:#fff;cursor:pointer');
      tellChip.addEventListener('click', () => { const rec = store.posts[c.dataset.tlId]; if (rec && rec.tell) openTellMenu(rec, tellChip); });
      b.append(mk('tl-dot', '', '', 'width:9px;height:9px;border-radius:50%;display:inline-block'), chip, tellChip,
        grp('real', 'rating', 'Is this account real/genuine?', 'Feels less genuine', 'Feels more genuine'));
      c.append(b);
    }
    placeInActionRow(c, b);
    const acc = store.accounts[it.rec.handle] || {}, r = acc.rating || 0;
    const reasons = [].concat(it.f.tags, it.acct.level === 'watch' || it.acct.level === 'flag' || r ? ['@' + it.rec.handle + ': ' + it.acct.reasons.join(', ')] : []);
    const auto = it.acct.level === 'flag' ? COLORS.shaped : it.f.dup ? COLORS.shaped
      : it.f.tags.length ? COLORS.emotional : it.acct.level === 'watch' ? COLORS.throttled : it.acct.level === 'unknown' ? '#9aa' : COLORS.normal;
    // your rating takes precedence over post-level signals: vouching turns the dot green, distrust keeps it at the account level
    const color = r > 0 ? COLORS.normal : r < 0 ? (it.acct.level === 'flag' ? COLORS.shaped : COLORS.throttled) : auto;
    const chip = b.querySelector('.tl-bait');
    chip.style.display = it.f.isBait ? 'inline-block' : 'none';
    chip.title = 'Looks like engagement bait: ' + it.f.baitKinds.join(', ');
    const tc = b.querySelector('.tl-tell'), tl = it.tell;
    if (tl && store.settings.rate !== false) {
      tc.style.display = 'inline-block'; tc.textContent = tl.label.toUpperCase() + (tl.user ? ' \u270E' : ''); tc.style.background = COLORS[tl.key] || COLORS.neutral;
      tc.style.opacity = tl.key === 'neutral' ? '0.75' : '1';
      tc.style.boxShadow = tl.user ? '0 0 0 1.5px #fff' : '';
      tc.title = (tl.user ? 'You set ' + tl.label + ' (automatic: ' + TELL_NAME[tl.auto] + '). ' : tl.label + ' (' + Math.round(tl.score * 100) + '%): ')
        + tl.reasons.join('; ') + (tl.also.length && !tl.user ? '. Also: ' + tl.also.map((k) => TELL_NAME[k]).join(', ') : '') + '. Click to re-categorize.';
    } else tc.style.display = 'none';
    const dot = b.querySelector('.tl-dot');
    dot.style.background = color;
    dot.style.boxShadow = r ? '0 0 0 2px ' + (r > 0 ? '#6fdc9a' : '#ff8a73') : '';
    const head = it.acct.level === 'unknown' ? 'account not looked up yet' : 'account score ' + Math.round(it.acct.score * 100) + '% (' + it.acct.level + ')' + (r ? ', includes your rating ' + (r > 0 ? '+' : '') + r : '');
    dot.title = [head].concat(reasons.length ? reasons : ['no signals']).join('\n');
    for (const [axis, val] of [['rating', r]]) {
      const v = b.querySelector('.tl-v-' + axis);
      v.textContent = (val > 0 ? '+' : '') + val;
      v.style.color = val > 0 ? '#6fdc9a' : val < 0 ? '#ff8a73' : '#fff';
    }
  }

  // Real/fake estimate for one account from everything stored about it (light = skip near-duplicate search, for bulk export).
  const judgeFor = (handle) => {
    const a = store.accounts[handle] || { handle };
    const mine = Object.values(store.posts).filter((p) => p.handle === handle && p.text);
    const feats = mine.map(featOf);
    return S.judgeAccount(a, {
      watch: CFG.watchCohorts, cohortSpike: !!(a.joined && spikes.has(a.joined)), postN: mine.length,
      baitN: feats.filter((f) => f.isBait).length, dupN: feats.filter((f) => f.dup > 0).length,
      emoN: feats.filter((f) => f.emo).length,
      topic: mine.length >= 4 ? S.topicShare(mine.map((p) => p.text)) : null, likedN: (a.likedPosts || []).length,
    });
  };

  // ---------- profile page card ----------
  const profileHandle = () => {
    const m = location.pathname.match(/^\/@([^/]+)(?:\/(?:replies|reposts|media))?\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  let pcard = null;
  function readProfileStats(handle) {
    const main = document.querySelector('main') || document.body;
    const f = ((main.innerText || '').slice(0, 3000)).match(/([\d.,]+\s*[KMB]?)\s+followers/i);
    if (!f) return;
    const n = parseCount(f[1].replace(/\s+/g, ''));
    const a = store.accounts[handle] || (store.accounts[handle] = { handle });
    if (n != null && a.followers !== n) { a.followers = n; a.fetchedAt = a.fetchedAt || Date.now(); save(); }
  }
  // Counts what a profile shows on its Threads / Replies / Reposts tab (tab comes from the URL: /@h, /@h/replies, /@h/reposts).
  // A count is marked complete when the tab says "No ... yet", or a short list (<= 8) stopped changing for 4 s; otherwise it is a lower bound.
  const tabSeen = {};
  const profileTab = () => { const m = location.pathname.match(/^\/@[^/]+\/(replies|reposts|media)\/?$/); return m ? m[1] : 'threads'; };
  function readProfileTabs(handle) {
    const tab = profileTab(); if (tab === 'media') return;
    const main = document.querySelector('main') || document.body, ids = new Set();
    main.querySelectorAll(SEL.postLink).forEach((l) => {
      const m = l.getAttribute('href').match(/^\/@([^/]+)\/post\/([^/?#]+)/);
      if (m && decodeURIComponent(m[1]) === handle) ids.add(m[2]);
    });
    const n = ids.size, key = handle + '/' + tab, now = Date.now();
    const rec = tabSeen[key] || (tabSeen[key] = { n: -1, changed: now });
    if (n !== rec.n) { rec.n = n; rec.changed = now; }
    const settled = now - rec.changed >= 4000;
    const empty = n === 0 && (settled || new RegExp('No ' + tab + ' yet', 'i').test(main.textContent.slice(0, 6000)));
    const complete = empty || (n > 0 && n <= 8 && settled);
    const a = store.accounts[handle] || (store.accounts[handle] = { handle });
    const prev = (a.tabs && a.tabs[tab]) || null;
    if (prev && prev.complete && !complete) return;   // do not downgrade a known-complete count on a half-loaded page
    const next = complete ? { n, complete: true } : { n: Math.max(n, prev ? prev.n : 0), complete: false };
    if (!prev || prev.n !== next.n || prev.complete !== next.complete) { (a.tabs || (a.tabs = {}))[tab] = Object.assign(next, { at: now }); save(); }
  }
  function renderProfileCard() {
    const handle = profileHandle();
    if (!handle || dead) { if (pcard) { pcard.host.remove(); pcard = null; } return; }
    readProfileStats(handle);
    readProfileTabs(handle);
    if (pcard && pcard.handle === handle && pcard.host.isConnected && pcard.ver === dataVersion) return;
    const a = store.accounts[handle] || (store.accounts[handle] = { handle });
    const jd = judgeFor(handle);
    const mine = Object.values(store.posts).filter((p) => p.handle === handle);
    const tagged = mine.filter((p) => featOf(p).tags.length).length;
    if (!pcard || pcard.handle !== handle) {
      if (pcard) pcard.host.remove();
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.c{font:12px/1.4 -apple-system,system-ui,sans-serif;background:#111e;color:#fff;border-radius:12px;padding:10px 12px;max-width:360px}' +
        '.t{display:flex;align-items:center;gap:6px;font-weight:700;font-size:14px}.d{width:11px;height:11px;border-radius:50%}.s{opacity:.75;margin-top:3px}' +
        '.r{margin-top:6px}.b{cursor:pointer;border:1px solid #fff5;background:#fff2;color:#fff;border-radius:6px;padding:0 9px;font:600 13px system-ui}' +
        '.v{display:inline-block;min-width:24px;text-align:center;cursor:pointer;font-weight:600}.g{font-weight:600;opacity:.9;margin-top:6px}</style><div class="c" id="c"></div>';
      pcard = { host, root, handle };
    }
    pcard.ver = dataVersion;
    if (!pcard.host.isConnected) {
      const h1 = document.querySelector('main h1') || document.querySelector('h1');
      const anchor = h1 && h1.parentElement && h1.parentElement.parentElement;
      if (anchor && anchor.parentElement) { anchor.after(pcard.host); pcard.host.style.cssText = 'display:block;margin:8px 16px'; }
      else { document.documentElement.append(pcard.host); pcard.host.style.cssText = 'position:fixed;top:150px;right:12px;z-index:2147483646;width:300px'; }
    }
    const VC = { fake: COLORS.emotional, real: COLORS.normal, unclear: '#b0b0b0', insufficient: '#9aa' };
    const c = pcard.root.getElementById('c'); c.replaceChildren();
    c.append(h('div', { className: 't' }, [h('span', { className: 'd', style: 'background:' + VC[jd.verdict] }), jd.label + (jd.confidence ? ' · ' + jd.confidence + (jd.confidence === 'your call' ? '' : ' confidence') : '')]));
    c.append(h('div', { className: 's', textContent: '@' + handle + ' · an estimate from the signals I can see; you decide' }));
    if (jd.fake.length) { c.append(h('div', { className: 'g', textContent: 'Points to fake' })); jd.fake.slice(0, 5).forEach((x) => c.append(h('div', { className: 's', textContent: '✗ ' + x.t }))); }
    if (jd.real.length) { c.append(h('div', { className: 'g', textContent: 'Points to real' })); jd.real.slice(0, 5).forEach((x) => c.append(h('div', { className: 's', textContent: '✓ ' + x.t }))); }
    if (jd.missing.length) c.append(h('div', { className: 's', textContent: 'To sharpen this: ' + jd.missing.slice(0, 3).join('; ') + '.', style: 'opacity:.55;margin-top:6px' }));
    c.append(h('div', { className: 's', style: 'margin-top:6px', textContent: [a.joined ? 'joined ' + a.joined : null, a.followers != null ? a.followers.toLocaleString() + ' followers' : null, a.threads != null ? a.threads.toLocaleString() + ' threads' : null].filter(Boolean).join(' · ') || 'no account details captured yet' }));
    const tb = a.tabs || {}, fmtTab = (k, lbl) => (tb[k] ? tb[k].n + (tb[k].complete ? '' : '+') + ' ' + lbl : null);
    const acts = [fmtTab('threads', 'threads'), fmtTab('replies', 'replies'), fmtTab('reposts', 'reposts')].filter(Boolean);
    if (acts.length) c.append(h('div', { className: 's', textContent: 'Seen on their profile: ' + acts.join(' · ') + (acts.some((x) => x.includes('+')) ? ' (+ = at least; list not fully loaded)' : '') }));
    if (a.likedPosts && a.likedPosts.length) c.append(h('div', { className: 's', textContent: 'Liked ' + a.likedPosts.length + ' post(s) whose likes list you opened.' }));
    if (a.postN) c.append(h('div', { className: 's', textContent: (a.baitN || 0) + ' of ' + a.postN + ' posts you saw look like engagement bait', style: a.baitN ? 'color:#ffd24d' : '' }));
    c.append(h('div', { className: 's', textContent: mine.length ? 'You have seen ' + mine.length + ' post(s) from them; ' + tagged + ' with bait/emotion/template signals.' : 'No posts from them seen in your feed yet.' }));
    const rowFor = (axis, label, tipM, tipP) => {
      const rt = a[axis] || 0;
      const btn = (txt, d, title) => h('button', { className: 'b', textContent: txt, title, onclick: (e) => { e.stopPropagation(); rate(handle, d, axis); } });
      return h('div', { className: 'r' }, [btn('−', -1, tipM), h('span', { className: 'v', textContent: (rt > 0 ? '+' : '') + rt, title: 'Click to reset', onclick: () => rate(handle, 0, axis), style: 'color:' + (rt > 0 ? '#6fdc9a' : rt < 0 ? '#ff8a73' : '#fff') }), btn('+', 1, tipP), ' ' + label]);
    };
    c.append(rowFor('rating', 'your call (±2 overrides the estimate)', 'Feels less genuine', 'Feels more genuine'));
  }

  // ---------- boot ----------
  const boot = (saved) => {
    if (saved && saved.tl) { store = Object.assign(store, saved.tl); store.settings = Object.assign({ glance: false }, store.settings); store.likers = store.likers || {}; store.history = store.history || []; Object.values(store.accounts).forEach((a) => { if (typeof a.bio === 'string') a.bio = S.cleanBio(a.bio); }); Object.entries(store.posts).forEach(([id, p]) => { if (S.isFeedCtx(p.ctx)) pageLoadIds.add(id); }); }
    recentPosts.push(...Object.values(store.posts).sort((a, b) => a.seenAt - b.seenAt).slice(-200));
    // posts loaded from storage must not count as "repeat" for ids first seen in this load, so only prior-session ids are tracked.
    scan(); refresh();
  };
  if (hasChrome) chrome.storage.local.get('tl', boot); else boot(null);
})();
