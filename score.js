// Pure scoring functions. No DOM, no network. Tunable lexicons live at the top.
(() => {
  // [kind, patterns]: the kind names are shown on the BAIT badge tooltip.
  const BAIT_KINDS = [
    ['comment-farm', [/\bcomment\b.*\b(below|if|your)\b/i, /\bdrop (a|your)\b/i, /\btag (a|someone)\b/i, /\bsay (yes|amen)\b/i, /\bsay no\b(?!\s+more)/i,
      /\breply with\b/i, /\bgive me your\b/i, /\bname (a|one|your)\b/i]],
    ['opinion hook', [/unpopular opinion/i, /hot take/i, /change my mind/i, /\bwho else\b/i, /\b(agree|thoughts)\?/i,
      /am i the only one/i, /be honest/i, /\bwould you\b.*\?/i, /\bwhich (one|is)\b.*\?/i]],
    ['giveaway / follow-for-follow', [/\bgiveaway\b/i, /\bfollow (me|for|back)\b/i, /\bf4f\b/i, /\bfollow4follow\b/i,
      /\bturn on notifications\b/i]],
    ['hype / urgency', [/this is your sign/i, /nobody (talks|is talking) about/i, /let that sink in/i,
      /they don'?t want you to (know|see)/i, /\bwake up\b/i, /\bsave this\b/i, /\bshare this\b/i, /\brepost if\b/i,
      /\bratio\b/i, /read that again/i]],
  ];
  const EMO = new Set(('disgusting outrageous furious pathetic traitor traitors corrupt evil terrifying insane ' +
    'unbelievable betrayed enemy enemies destroy destroyed crisis collapse exposed shocking cult sheep disgrace ' +
    'shameful scum lying liars criminal criminals invasion nightmare horrifying rage hate hated sick vile threat ' +
    'panic fear disaster catastrophe slaughter massacre war').split(' '));
  const TEMPLATE = [/\bme when\b/i, /\bpov:/i, /\bnobody:/i, /tell me you/i, /\bnot me\b/i,
    /\bthe way (i|he|she|they)\b/i, /\breal ones\b/i, /\bno because\b/i, /\bwe need to talk about\b/i];
  const STOP = new Set(('the and for that this with have from they will your what when just about there their been ' +
    'were would could should which than then them into more some also only very over such like dont does cant here ' +
    'know think people because really still being those these other after before where while thing things going ' +
    'make made much even every never always').split(' '));

  const clamp = (x) => Math.max(0, Math.min(1, x));
  const tokens = (t) => (t || '').toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean);
  const shCache = new Map();   // text -> shingle set; the near-duplicate search compares each post with ~200 others, so never rebuild these
  const shingles = (t) => {
    let s = shCache.get(t); if (s) return s;
    const w = tokens(t); s = new Set();
    for (let i = 0; i + 2 < w.length; i++) s.add(w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]);
    if (shCache.size >= 2000) shCache.delete(shCache.keys().next().value);
    shCache.set(t, s);
    return s;
  };
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let i = 0; for (const x of a) if (b.has(x)) i++;
    return i / (a.size + b.size - i);
  };
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // others: [{handle, text}] recent posts from the store, used for near-duplicate detection.
  function scorePost(rec, others) {
    const t = rec.text || '', toks = tokens(t);
    const kinds = BAIT_KINDS.filter(([, rs]) => rs.some((r) => r.test(t))).map(([k]) => k);
    if (t.length < 160 && t.includes('?') && (t.includes('👇') || t.includes('⬇')) && !kinds.includes('comment-farm')) kinds.push('comment-farm');
    const bait = kinds.length;
    const emotion = toks.filter((w) => EMO.has(w)).length;
    const letters = t.replace(/[^A-Za-z]/g, '');
    const caps = letters.length > 20 ? t.replace(/[^A-Z]/g, '').length / letters.length : 0;
    const excl = (t.match(/!/g) || []).length;
    const template = TEMPLATE.some((r) => r.test(t));
    const conflict = (rec.likes || 0) >= 20 && (rec.replies || 0) / Math.max(rec.likes, 1) > 0.5;
    let dup = 0;
    const sh = shingles(t);
    if (sh.size >= 4) {
      for (const o of others) {
        if (o.handle === rec.handle || o.id === rec.id) continue;
        if (jaccard(sh, shingles(o.text)) >= 0.6) dup++;
      }
    }
    const tags = [];
    if (bait) tags.push('engagement bait (' + kinds.join(', ') + ')');
    // Calibrated on a real 1,900-post feed: caps/exclamations alone were enthusiasm (54 of 61 hits), so they only count alongside charged words.
    const emo = emotion >= 2 || (emotion >= 1 && (caps > 0.4 || excl >= 2));
    if (emo) tags.push('emotional language');
    if (template) tags.push('recycled template');
    if (conflict) tags.push('high reply:like (conflict)');
    if (dup) tags.push('near-duplicate of ' + dup + ' other author(s)');
    const isBait = bait > 0 || template;
    const baitKinds = template ? kinds.concat('relatable template') : kinds;
    return { bait, isBait, baitKinds, emo, emotion, caps: +caps.toFixed(2), excl, template, conflict, dup, tags };
  }

  // 'YYYY-MM' -> months ago
  const monthsAgo = (ym, now = new Date()) => {
    const [y, m] = ym.split('-').map(Number);
    return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  };

  function scoreAccount(a, watch = []) {
    const reasons = []; let s = 0;
    if (a.joined) {
      if (watch.includes(a.joined)) { s += 0.25; reasons.push('joined in watched cohort ' + a.joined); }
      if (monthsAgo(a.joined) <= 3) { s += 0.15; reasons.push('account under 3 months old'); }
    }
    if (a.followers != null && a.threads != null && a.threads > 500 && a.followers < 100) {
      s += 0.2; reasons.push('high output (' + a.threads + ' threads), tiny audience (' + a.followers + ')');
    }
    if (a.followers != null && a.followers < 20) { s += 0.1; reasons.push('under 20 followers'); }
    if (/\d{4,}$/.test(a.handle || '') || /^[a-z]+_[a-z]+\d{3,}$/i.test(a.handle || '')) {
      s += 0.15; reasons.push('auto-style handle');
    }
    if (a.fetchedAt && a.bio === '') { s += 0.05; reasons.push('empty bio'); }
    if (a.cohortSpike) { s += 0.2; reasons.push('part of a join-month spike among accounts you see'); }
    const known = a.fetchedAt || a.joined;
    s = clamp(s);
    return { score: +s.toFixed(2), level: !known ? 'unknown' : s >= 0.5 ? 'flag' : s >= 0.25 ? 'watch' : 'ok', reasons };
  }

  // Join months that are over-represented among the non-followed accounts you have seen.
  function cohortSpikes(accounts) {
    const by = {}; let total = 0;
    for (const a of Object.values(accounts)) if (a.joined) { by[a.joined] = (by[a.joined] || 0) + 1; total++; }
    const months = Object.keys(by);
    if (total < 15 || months.length < 3) return new Set();
    const avg = total / months.length, out = new Set();
    for (const m of months) if (by[m] >= 4 && by[m] >= 2.5 * avg) out.add(m);
    return out;
  }

  // ---------- per-post telltales ----------
  // Every post on the home feed gets one label saying which feed reading it supports; the feed bars are built from these same labels,
  // so the chips on posts and the bars in the panel cannot disagree.
  const STALE_H = 24;   // calibrated on 3 days of a real feed: older than this was ~8% of non-followed posts outside mornings, ~26% in the morning
  const TELL_LABEL = { normal: 'Normal', baseline: 'Baseline', throttled: 'Throttled', emotional: 'Emotional', shaped: 'Shaped', neutral: 'Neutral' };
  const fmtAge = (h) => (h == null ? '' : h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' days');

  // it: { followed: true|false|null, ageH, repeat, authorRecent, f: scorePost features, acct: {level} }
  // followed === null means "not a home-feed post / unknown", and such posts are not rated.
  function postTelltale(it) {
    if (!it || it.followed === null || it.followed === undefined) return null;
    const f = it.f || {}, age = it.ageH == null ? null : Math.max(0, it.ageH), followed = it.followed === true;
    const stale = age != null && age > STALE_H;
    const sc = { normal: 0, baseline: 0, throttled: 0, emotional: 0, shaped: 0 };
    const why = { normal: [], baseline: [], throttled: [], emotional: [], shaped: [] };
    if (f.dup > 0) { sc.shaped = 0.9; why.shaped.push('wording nearly identical to ' + f.dup + ' other author(s)'); }
    if (it.acct && it.acct.level === 'flag') { sc.shaped = Math.max(sc.shaped, 0.8); why.shaped.push('from an account with several authenticity signals'); }
    const em = [];
    if (f.emo) em.push('charged language');
    if (f.conflict) em.push('lots of arguing underneath');
    if ((f.bait || 0) > 0) em.push('engagement bait (' + (f.baitKinds || []).filter((k) => k !== 'relatable template').join(', ') + ')');
    if (em.length) { sc.emotional = Math.min(1, 0.65 + 0.1 * em.length); why.emotional = em; }
    if (stale && !followed) {
      sc.throttled = 0.5 + 0.5 * Math.min(1, (age - STALE_H) / 72);
      why.throttled.push(fmtAge(age) + ' old and from an account you do not follow: older posts filling in for fresh ones');
    }
    if (it.repeat) { sc.baseline = 0.9; why.baseline.push('you have seen this exact post before'); }
    if (!followed && (it.authorRecent || 0) >= 2) {
      sc.baseline = Math.max(sc.baseline, Math.min(0.9, 0.5 + 0.15 * (it.authorRecent - 1)));
      why.baseline.push('post ' + (it.authorRecent + 1) + ' from this account in your recent feed (not followed)');
    }
    if (followed) {
      sc.normal = stale ? 0.5 : age != null && age <= 3 ? 1 : 0.8;
      why.normal.push('from an account you follow' + (age != null ? ', ' + fmtAge(age) + ' old' : '') + (stale ? ' (they just post rarely)' : ''));
      sc.normal *= 1 - Math.max(sc.emotional, sc.shaped);
    }
    let key = 'neutral', best = 0.4;
    for (const k of ['shaped', 'emotional', 'throttled', 'baseline', 'normal']) if (sc[k] > best) { key = k; best = sc[k]; }
    const also = Object.keys(sc).filter((k) => k !== key && sc[k] >= 0.4);
    const reasons = key === 'neutral' ? [(age != null ? fmtAge(age) + ' old, ' : '') + 'from an account you do not follow; nothing unusual'] : why[key];
    return { key, label: TELL_LABEL[key], score: +best.toFixed(2), scores: sc, reasons, also };
  }

  // items: [{rec, f, acct, followed, ageH, repeat, authorRecent, tell?}]  (tell = the stored arrival-time label, else computed)
  function feedState(items, minWindow = 10) {
    const n = items.length;
    if (n < minWindow) return { key: 'calibrating', label: 'Calibrating (' + n + '/' + minWindow + ' posts read)', scores: {}, evidence: [] };
    const tells = items.map((i) => i.tell || postTelltale(i) || { key: 'neutral', scores: {} });
    const count = (k) => tells.filter((t) => t.key === k).length;
    // share of recent posts carrying a label, scaled so that this share means "fully this reading"
    // throttled 0.4: the headline needs ~5 stale strangers in the last 30. On 3 days of a real feed that fired in 30% of morning windows and ~0% of the rest of the day (0.25 fired all day).
    const SAT = { normal: 0.5, baseline: 0.25, throttled: 0.4, emotional: 0.2, shaped: 0.2 };
    const scores = {};
    for (const k of Object.keys(SAT)) scores[k] = clamp(count(k) / n / SAT[k]);

    const freq = {};
    for (const i of items) for (const w of new Set(tokens(i.rec.text).filter((w) => w.length > 4 && !STOP.has(w)))) freq[w] = (freq[w] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const topicConc = top[1] / n;
    scores.shaped = Math.max(scores.shaped, clamp((topicConc - 0.2) / 0.25));   // one topic dominating the window is a feed-level cue

    const known = items.filter((i) => i.followed !== null && i.followed !== undefined);
    const followedShare = known.length ? known.filter((i) => i.followed).length / known.length : 0;
    const ages = items.map((i) => i.ageH).filter((x) => x != null);
    const nonFollowed = items.filter((i) => i.followed === false && i.ageH != null);
    const pct = (x) => Math.round(x * 100) + '%';
    const names = ['normal', 'neutral', 'throttled', 'baseline', 'emotional', 'shaped'];
    const evidence = [
      'rated: ' + names.map((k) => TELL_LABEL[k] + ' ' + count(k)).join(' · '),
      'from accounts you follow: ' + pct(followedShare) + ' · distinct authors: ' + pct(new Set(items.map((i) => i.rec.handle)).size / n),
      'median post age: ' + fmtAge(median(ages)) + ' · older than ' + STALE_H + 'h: ' + pct(ages.length ? ages.filter((a) => a > STALE_H).length / ages.length : 0)
        + (nonFollowed.length ? ' (strangers only: ' + pct(nonFollowed.filter((i) => i.ageH > STALE_H).length / nonFollowed.length) + ')' : ''),
      'top topic word "' + top[0] + '" in ' + pct(topicConc) + ' of posts',
    ];
    const labels = {
      normal: 'Normal follower interaction', baseline: 'Reticulating splines — continue scrolling',
      throttled: 'Possibly throttled (low confidence)', emotional: 'Pulling for an emotional reaction',
      shaped: 'Oddly shaped: looks like opinion-steering',
    };
    // the headline names the strongest anomaly; "normal" only wins when nothing else is showing
    let key = ['shaped', 'emotional', 'throttled', 'baseline'].sort((a, b) => scores[b] - scores[a])[0];
    if (scores[key] < 0.4) key = scores.normal >= 0.4 ? 'normal' : 'mixed';
    return key === 'mixed' ? { key, label: 'Mixed / unclear', scores, evidence } : { key, label: labels[key], scores, evidence };
  }

  // Text that is Threads chrome, not the post body (found in a real export: timestamps, "Replying to", "12h12 hours ago").
  const JUNK_BODY = [/^\d+\s?[smhdw]$/i, /^\d+\s?[smhdw]\s?\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i,
    /^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i, /^replying to\b/i, /^replied to\b.*\bin your thread$/i, /^post not available$/i,
    /^\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?$/];   // older posts show their date (MM/DD/YY) where newer ones show "14h"
  const cleanBody = (texts) => (texts || []).map((t) => (t || '').trim()).filter((t) => t && !JUNK_BODY.some((r) => r.test(t)))
    .sort((a, b) => b.length - a.length)[0] || '';
  // og:description looks like "986 Followers • 453 Threads • <bio>. See the latest conversations with @x." Keep only the bio.
  const cleanBio = (str) => (str || '')
    .replace(/^\s*[\d.,]+\s*[KMB]?\s+Followers?\s*[•·]\s*[\d.,]+\s*[KMB]?\s+Threads?\.?\s*[•·]?\s*/i, '')
    .replace(/\s*See the latest conversations with.*$/i, '').replace(/\s*See the latest\W*$/i, '').trim();
  const isUnavailable = (texts) => (texts || []).some((t) => /^post not available$/i.test((t || '').trim()));

  // Which kind of page we are on. Only 'home' (For you / Following / custom feeds) should feed the feed readings.
  function pageContext(pathname) {
    const p = ((pathname || '/').replace(/\/+$/, '')) || '/';
    if (p === '/' || /^\/(following|for_you|foryou|custom_feed\/.+)$/.test(p)) return 'home';
    if (/^\/@[^/]+\/post\//.test(p)) return 'thread';
    if (/^\/@[^/]+(\/(replies|reposts|media))?$/.test(p)) return 'profile';
    if (/^\/activity/.test(p)) return 'activity';
    if (/^\/search/.test(p)) return 'search';
    return 'other';
  }
  const isFeedCtx = (c) => c === 'home';

  // Share of an account's posts that revolve around the single most common content word.
  function topicShare(texts) {
    const freq = {}, n = texts.length;
    for (const t of texts) for (const w of new Set(tokens(t).filter((w) => w.length > 4 && !STOP.has(w)))) freq[w] = (freq[w] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0] || ['', 0];
    return { word: top[0], share: n ? top[1] / n : 0 };
  }

  // Two-sided estimate for one account: evidence for fake vs evidence for real, each with a weight and a plain reason.
  // c = { watch:[months], cohortSpike, postN, baitN, dupN, emoN, topic:{word,share}, likedN }
  function judgeAccount(a, c = {}) {
    const fake = [], real = [], missing = [];
    const add = (arr, w, t) => arr.push({ w, t });
    let cats = 0;   // how many independent kinds of evidence we actually have
    // Activity vs age, from the Threads / Replies tabs of the profile (counts are only trusted when the list looked complete).
    const ageM = a.joined ? monthsAgo(a.joined) : null, tabs = a.tabs || {};
    const T = tabs.threads ? { n: tabs.threads.n, ok: !!tabs.threads.complete } : a.threads != null ? { n: a.threads, ok: true } : null;
    const R = tabs.replies ? { n: tabs.replies.n, ok: !!tabs.replies.complete } : null;
    const exact = !!(T && R && T.ok && R.ok);
    const parked = exact && ageM != null && ageM >= 6 && T.n + R.n <= 5;   // old, but almost silent
    if (a.joined) {
      cats++;
      const m = monthsAgo(a.joined);
      if (m <= 3) add(fake, 0.20, m <= 0 ? 'account was created this month' : 'account is only ' + m + ' month(s) old');
      else if (m >= 12 && !parked) add(real, 0.12, 'account is ' + Math.floor(m / 12) + '+ year(s) old (weak evidence: aged accounts get bought and resold)');
      if ((c.watch || []).includes(a.joined)) add(fake, 0.15, 'joined in a watched cohort (' + a.joined + ')');
      if (c.cohortSpike) add(fake, 0.15, 'joined in a month that is over-represented among accounts you see');
    } else missing.push('join date (open "About this profile")');
    if (a.followers != null) {
      cats++;
      if (a.followers < 20) add(fake, 0.12, 'under 20 followers');
      else if (a.followers >= 1000) add(real, 0.20, a.followers.toLocaleString() + ' followers');
      else if (a.followers >= 300) add(real, 0.15, a.followers.toLocaleString() + ' followers');
      if (a.threads != null && a.threads > 500 && a.followers < 100) add(fake, 0.20, 'posts a lot (' + a.threads + ' threads) to almost no audience (' + a.followers + ')');
      else if (a.threads != null && a.threads >= 30 && a.followers >= 100) add(real, 0.08, 'steady output (' + a.threads + ' threads) with a real audience');
    } else missing.push('follower count (scroll to the top of their profile)');
    if (T && R) {
      const total = T.n + R.n;
      if (exact) cats++;
      if (exact && ageM != null) {
        const why = 'only ' + T.n + ' threads and ' + R.n + ' replies in ' + ageM + ' months (parked-account pattern; pure lurkers look like this too)';
        if (ageM >= 12 && total <= 5) add(fake, 0.35, why);
        else if (ageM >= 6 && total <= 5) add(fake, 0.25, why);
        else if (ageM >= 12 && total <= 15 && total / ageM < 0.5) add(fake, 0.15, 'very little activity for its age (' + total + ' threads and replies in ' + ageM + ' months)');
      }
      if (exact && T.n >= 10 && R.n === 0) add(fake, 0.12, 'posts threads but has never replied to anyone');
      if (R.n >= 10 && T.n >= 3) add(real, 0.12, 'both posts and talks with people (' + R.n + (R.ok ? '' : '+') + ' replies)');
    }
    if (!T) missing.push('their Threads tab (open their profile)');
    if (!R) missing.push('their Replies tab (click Replies on their profile)');
    if (a.fetchedAt && a.bio !== undefined) {
      cats++;
      if (a.bio) add(real, 0.05, 'has a bio'); else add(fake, 0.05, 'empty bio');
    } else missing.push('bio (needs a lookup)');
    if (/\d{4,}$/.test(a.handle || '') || /^[a-z]+_[a-z]+\d{3,}$/i.test(a.handle || '')) add(fake, 0.12, 'auto-style handle');
    if ((c.postN || 0) >= 3) {
      cats++;
      if (c.baitN / c.postN >= 0.4) add(fake, 0.15, c.baitN + ' of ' + c.postN + ' of their posts you saw are engagement bait');
      if (c.dupN >= 1) add(fake, 0.15, c.dupN + ' of their posts nearly duplicate another account\'s wording');
      if (c.postN >= 4 && c.topic && c.topic.share >= 0.6) add(fake, 0.10, 'nearly every post circles the same topic ("' + c.topic.word + '")');
      if (c.postN >= 4 && c.emoN / c.postN >= 0.5) add(fake, 0.10, 'mostly emotionally charged posts');
      if (c.postN >= 5 && !c.baitN && !c.dupN && (!c.topic || c.topic.share < 0.35)) add(real, 0.15, 'varied, non-bait posts (' + c.postN + ' seen)');
    } else missing.push('their posts (3+ seen in your feed)');
    if ((c.likedN || 0) >= 3 && a.followers != null && a.followers < 100) add(fake, 0.10, 'liked ' + c.likedN + ' posts whose likes list you inspected, with almost no audience');
    const r = a.rating || 0;
    if (r) add(r > 0 ? real : fake, Math.abs(r) * 0.25, 'your rating (' + (r > 0 ? '+' : '') + r + ')');
    const sum = (arr) => arr.reduce((x, y) => x + y.w, 0), by = (x, y) => y.w - x.w;
    const net = sum(fake) - sum(real), mag = Math.abs(net);
    let verdict;
    if (r >= 2) verdict = 'real';
    else if (r <= -2) verdict = 'fake';
    else if (cats < 2) verdict = 'insufficient';
    else if (net >= 0.35) verdict = 'fake';
    else if (net <= -0.30 && cats >= 3) verdict = 'real';   // "real" must be earned by several kinds of evidence
    else verdict = 'unclear';
    const confidence = Math.abs(r) >= 2 ? 'your call' : (verdict === 'insufficient' || verdict === 'unclear') ? ''
      : cats >= 4 && mag >= 0.6 ? 'high' : cats >= 3 && mag >= 0.35 ? 'medium' : 'low';
    const label = { fake: 'Likely fake', real: 'Likely real', unclear: 'Unclear', insufficient: 'Not enough data yet' }[verdict];
    return { verdict, label, confidence, fake: fake.sort(by), real: real.sort(by), missing, net: +net.toFixed(2), cats };
  }

  window.TLScore = { scorePost, scoreAccount, cohortSpikes, feedState, monthsAgo, topicShare, judgeAccount, cleanBody, cleanBio, isUnavailable, pageContext, isFeedCtx, postTelltale, STALE_H };
})();
