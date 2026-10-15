// node test/smoke.js : sanity checks for score.js (no browser needed)
global.window = {};
require('../score.js');
const S = window.TLScore;
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('FAIL', m); } else console.log('ok  ', m); };
const post = (t, o = {}) => ({ id: t, handle: 'a', text: t, ...o });

ok(S.scorePost(post('Unpopular opinion: pineapple is fine. Who else?'), []).baitKinds.includes('opinion hook'), 'opinion hook');
ok(S.scorePost(post('What is your favorite hobby? 👇'), []).isBait, 'question + pointer emoji is bait');
ok(S.scorePost(post('FOLLOW FOR FOLLOW giveaway tonight'), []).baitKinds.includes('giveaway / follow-for-follow'), 'giveaway');
ok(!S.scorePost(post('Finished soldering the header today, tested fine'), []).isBait, 'normal post not bait');
ok(S.scorePost(post('me when the build passes'), []).template, 'template');

const a = S.scoreAccount({ handle: 'amy48291', joined: '2025-11', followers: 12, threads: 900, fetchedAt: 1 }, ['2025-11']);
ok(a.level === 'flag' && a.reasons.length >= 3, 'suspicious account flagged with reasons');
ok(S.scoreAccount({ handle: 'solder', joined: '2020-01', followers: 800, threads: 400, bio: 'x', fetchedAt: 1 }).level === 'ok', 'established account ok');
ok(S.scoreAccount({ handle: 'x' }).level === 'unknown', 'no data => unknown');

const mk = (t, i, o = {}) => ({ rec: { id: '' + i, handle: 'u' + i, text: t }, f: S.scorePost(post(t, { id: '' + i, handle: 'u' + i }), []), acct: { level: 'ok' }, followed: true, ageH: 3, repeat: false, ...o });
const calm = ['soldering header board meter', 'sourdough starter finally rising', 'kids soccer practice rained out', 'new firmware flashed heltec node',
  'hiking Mount Evans saturday', 'recapping logic board capacitors', 'dentist appointment moved again', 'watch complication finally working',
  'coffee grinder burr replaced', 'pico temperature server running', 'garage shelving project done', 'solar panel wiring parallel fix'].map((t, i) => mk(t, i));
ok(S.feedState(calm).key === 'normal', 'calm followed feed => normal');
const angry = Array.from({ length: 12 }, (_, i) => mk('Unpopular opinion: THIS IS DISGUSTING and evil!!! wake up ' + i, i, { followed: false }));
ok(['emotional', 'shaped'].includes(S.feedState(angry).key), 'angry bait feed => emotional/shaped');
ok(S.feedState(calm.slice(0, 4)).key === 'calibrating', 'too few posts => calibrating');

// --- judgeAccount ---
const now = new Date(), ym = (back) => { const d = new Date(now.getFullYear(), now.getMonth() - back, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const J = S.judgeAccount;
ok(J({ handle: 'solder_guy' }, {}).verdict === 'insufficient', 'handle only => not enough data');
const bot = J({ handle: 'newuser482913', joined: ym(0), followers: 4, threads: 12, fetchedAt: 1, bio: '' }, { postN: 0 });
ok(bot.verdict === 'fake' && bot.fake.length >= 3, 'brand-new, tiny, digit handle => likely fake');
const est = J({ handle: 'solderguy', joined: ym(40), followers: 800, threads: 400, fetchedAt: 1, bio: 'hardware tinkerer' }, { postN: 8, baitN: 0, dupN: 0, emoN: 0, topic: { word: 'solder', share: 0.2 } });
ok(est.verdict === 'real' && est.confidence !== 'low', 'established, varied account => likely real');
const aged = J({ handle: 'agedacct', joined: ym(14), followers: 15, threads: 700, fetchedAt: 1, bio: '' }, { cohortSpike: true, watch: [ym(14)], postN: 5, baitN: 3, dupN: 1, topic: { word: 'vote', share: 0.8 }, emoN: 4 });
ok(aged.verdict === 'fake', 'aged/reserve-looking account with bait + one topic => fake (age alone is weak)');
ok(J({ handle: 'oldbutnew', joined: ym(40), followers: 350 }, {}).verdict !== 'real', 'age + followers alone never earn "real"');
ok(J({ handle: 'x', joined: ym(0), followers: 2, rating: 2 }, {}).verdict === 'real', 'your +2 rating overrides');
ok(J({ handle: 'x', joined: ym(40), followers: 900, rating: -2 }, {}).verdict === 'fake', 'your -2 rating overrides');
ok(S.topicShare(['politics vote election', 'vote today election', 'election vote now']).share >= 0.9, 'topicShare finds a dominant word');

// --- activity vs age ---
const tab = (n, complete = true) => ({ n, complete });
const silent = J({ handle: 'quietone', joined: ym(13), followers: 40, fetchedAt: 1, bio: '', tabs: { threads: tab(0), replies: tab(3) } }, {});
ok(silent.verdict === 'fake' && silent.fake.some((x) => /only 0 threads and 3 replies/.test(x.t)), 'a year old, 0 threads, 3 replies => likely fake');
const lurker = J({ handle: 'quietone', joined: ym(13), followers: 600, fetchedAt: 1, bio: 'hi', tabs: { threads: tab(0), replies: tab(3) } }, {});
ok(lurker.verdict !== 'fake', 'same silence but 600 followers and a bio is not enough to call fake');
ok(!J({ handle: 'newish', joined: ym(2), followers: 40, tabs: { threads: tab(0), replies: tab(3) } }, {}).fake.some((x) => /parked/.test(x.t)), 'a young account is not "parked"');
ok(!J({ handle: 'quietone', joined: ym(13), followers: 40, tabs: { threads: tab(0, false), replies: tab(3, false) } }, {}).fake.some((x) => /parked/.test(x.t)), 'incomplete counts never prove silence');
ok(J({ handle: 'chatty', joined: ym(30), followers: 500, fetchedAt: 1, bio: 'x', tabs: { threads: tab(40), replies: tab(120, false) } }, {}).real.some((x) => /talks with people/.test(x.t)), 'posts + many replies counts as real evidence');
ok(J({ handle: 'broadcaster', joined: ym(20), followers: 300, tabs: { threads: tab(60), replies: tab(0) } }, {}).fake.some((x) => /never replied/.test(x.t)), 'posts but never replies is flagged');

// --- calibrated on a real export ---
ok(!S.scorePost(post('4AG festival!!!'), []).emo, 'enthusiasm (caps/exclamations only) is not emotional pull');
ok(!S.scorePost(post('Yes sir… that is a REAL ALPINE PULL OUT!!!'), []).emo, 'shouting about a hobby is not emotional pull');
ok(S.scorePost(post('VOTE LIKE YOUR LIFE DEPENDS ON IT. LET US END THIS NIGHTMARE'), []).emo, 'charged word + caps is emotional pull');
ok(S.scorePost(post('This is a disgusting, evil betrayal'), []).emo, 'two charged words is emotional pull');
ok(S.cleanBody(['14h', 'Replying to @someone', 'Real sentence here']) === 'Real sentence here', 'cleanBody skips timestamps and reply labels');
ok(S.cleanBody(['14h', '12h12 hours ago']) === '', 'cleanBody returns empty for media-only posts');
ok(S.cleanBody(['04/17/25']) === '', 'a bare MM/DD/YY is the timestamp of an older post, not its body (43 of 43 matched the post date)');
ok(S.cleanBio('0 Followers • 6 Threads.') === '', 'bio artifact with no real bio => empty');
ok(S.cleanBio('986 Followers • 453 Threads • Snapshots from a beautiful world. See the latest conversations with @example.') === 'Snapshots from a beautiful world.', 'bio keeps only the bio text');
ok(S.cleanBio('Mom. Professor Emerita. See the latest…') === 'Mom. Professor Emerita.', 'truncated suffix removed');
ok(S.isUnavailable(['Post not available']), 'unavailable posts are detected');
ok(S.pageContext('/') === 'home' && S.pageContext('/following') === 'home', 'home contexts');
ok(S.pageContext('/@someone') === 'profile' && S.pageContext('/@someone/replies') === 'profile', 'profile contexts');
ok(S.pageContext('/@someone/post/Abc123') === 'thread', 'thread context');
ok(S.pageContext('/activity') === 'activity' && S.pageContext('/search') === 'search', 'activity/search contexts');
ok(S.isFeedCtx('home') && !S.isFeedCtx('profile') && !S.isFeedCtx('thread'), 'only home counts as the feed');

// --- per-post telltales ---
const TT = S.postTelltale, fe = (t, o = {}) => Object.assign({ f: S.scorePost(post(t), []), acct: { level: 'ok' }, followed: false, ageH: 2, repeat: false, authorRecent: 0 }, o);
const plain = 'Finished the soldering project today and it works';
ok(TT(fe(plain, { followed: true })).key === 'normal', 'followed + fresh => Normal');
ok(TT(fe(plain, { followed: true, ageH: 120 })).key === 'normal', 'followed but old stays Normal (they just post rarely)');
ok(TT(fe(plain, { followed: false, ageH: 2 })).key === 'neutral', 'fresh stranger, nothing unusual => Neutral');
const thr = TT(fe(plain, { followed: false, ageH: 72 }));
ok(thr.key === 'throttled' && /3 days old/.test(thr.reasons[0]), 'stale stranger => Throttled, reason names the age');
ok(TT(fe(plain, { followed: false, ageH: 30 })).key === 'throttled', 'a 30 h old stranger is already Throttled');
ok(TT(fe(plain, { followed: false, ageH: 10 })).key === 'neutral', 'a 10 h old stranger is not');
ok(TT(fe(plain, { followed: false, repeat: true })).key === 'baseline', 'seen before => Baseline');
ok(TT(fe(plain, { followed: false, authorRecent: 3 })).key === 'baseline', 'same stranger again and again => Baseline');
ok(TT(fe(plain, { followed: true, authorRecent: 3 })).key === 'normal', 'a followed author repeating is normal');
ok(TT(fe('Unpopular opinion: this is the way', { followed: false })).key === 'emotional', 'bait from a stranger => Emotional');
ok(TT(fe('Unpopular opinion: this is the way', { followed: true })).key === 'emotional', 'bait outranks Normal');
ok(TT(fe(plain, { followed: false, acct: { level: 'flag' } })).key === 'shaped', 'flagged account => Shaped');
ok(TT(fe(plain, { followed: false, f: Object.assign(S.scorePost(post(plain), []), { dup: 2 }) })).key === 'shaped', 'copied wording => Shaped');
ok(TT(fe(plain, { followed: null })) === null, 'not on the home feed => not rated');
ok(TT(fe('me when the build passes', { followed: true })).key === 'normal', 'a relatable template alone is not Emotional');
ok(!S.scorePost(post('Say no more.'), []).isBait, '"Say no more" is not comment bait');
ok(S.scorePost(post('Say yes if you agree'), []).isBait, '"say yes" still is');
ok(S.cleanBody(['Replied to someone in your thread']) === '', 'reply context header is not a post body');
// headline: strongest anomaly wins; Normal only when nothing else shows
const WORDS = 'soldering sourdough soccer firmware hiking capacitors dentist watchface coffee pico garage solar guitar marathon lasagna bicycle telescope gardening kayaking origami knitting chess pottery podcast fiddle compost mushroom lantern harbor glacier'.split(' ');
const mkw = (n, nStale) => Array.from({ length: n }, (_, i) => { const stale = i < nStale; const txt = WORDS[i % WORDS.length] + ' ' + WORDS[(i * 7 + 3) % WORDS.length]; const it = fe(txt, { followed: !stale, ageH: stale ? 72 : 2 }); it.rec = { id: '' + i, handle: 'u' + i, text: txt }; return it; });
ok(S.feedState(mkw(30, 6)).key === 'throttled', '6 stale strangers in 30 => headline Throttled');
ok(S.feedState(mkw(30, 2)).key === 'normal', '2 stale strangers in 30 => headline stays Normal');
console.log(fail ? fail + ' failed' : 'all passed');
process.exit(fail ? 1 : 0);
