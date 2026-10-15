# ThreadsLens: handoff for continuing development

Chrome MV3 extension (load unpacked) that passively reads the Threads feed as the owner (Mike) reads it and shows
signals about (a) how the feed is being shaped and (b) how authentic posts/accounts look. Everything is local
(`chrome.storage.local`); nothing is sent anywhere. Current version: see `manifest.json` (0.5.1).

## Files
- `manifest.json`: content script on threads.com / threads.net; permissions `storage`, `unlimitedStorage`.
- `PROMPT.md`: a self-contained brief describing the whole app; paste it into a fresh session (keep it in sync when behaviour changes).
- `score.js`: pure functions on `window.TLScore` (no DOM): `scorePost`, `scoreAccount`, `judgeAccount`, `postTelltale`, `feedState`, `cohortSpikes`, `topicShare`,
  `cleanBody`, `cleanBio`, `isUnavailable`, `pageContext`, `isFeedCtx`, `monthsAgo`, `STALE_H`. Lexicons (BAIT_KINDS, EMO, TEMPLATE, STOP) and all thresholds live in this file.
- `content.js`: everything with a DOM: extraction (`SEL`, `extract`, `metric`), IntersectionObserver "read" detection (1.5 s at 60% visible),
  storage (`store`, `save`), slow profile lookups, About-dialog join-date capture, liker capture, scoring glue (`acctScore`, `itemFor`),
  overlay panel (`refresh`), 48h history graph, per-post pill (`ensureBadge`, `placeInActionRow`), profile-page card (`renderProfileCard`),
  CSV/JSON export, backup import (`mergeStore`).
- `test/smoke.js`: `node test/smoke.js` checks scoring behavior. Run it plus `node --check content.js score.js` after every edit.

## Product decisions already made (do not re-litigate)
- **Passive only.** Mike wants "look over my shoulder": the extension reads what is on screen as he reads. Claude must not scroll, click, or
  navigate his Threads session. Background profile fetches exist but are behind the **User glance** toggle (off by default), slow
  (40-110 s jitter, 25/hour, only while he is actively scrolling, 15 min backoff on 429/5xx), and only for authors he read or whose likes list he opened.
- **Judgement is an estimate, shown privately.** The profile-page card gives Likely fake / Likely real / Unclear / Not enough data with a confidence and the reasons in BOTH directions (`judgeAccount` in score.js). "Real" must be earned by 3+ kinds of evidence (age and followers alone never do it, because aged accounts get resold); `rating` of +2/-2 overrides. Per-post dots and the feed panel stay "signals"; the panel keeps its "Signals, not verdicts" line. Never publish/share a named list of accounts judged fake; never attribute to state actors.
- **One user rating per account:** `real` -3..+3 (`a.rating`). It shifts the score by 0.2/step, forces OK at >= +2 and flagged at <= -2, and takes precedence
  over post-level signals for the dot color. An `interesting` axis was built and removed on request (he just unfollows); do not re-add.
- **Age is not trust.** Aged/reserve accounts (Nov 2024, Nov 2025 cohorts) are suspected. Planned but NOT built: history analysis on profile pages
  (dormant-then-burst gaps, topic pivot, cadence, former usernames, "established" positive mark, automatic multi-year cohort scan).
- Feed readings (0..1 each): normal, baseline (shown as "Reticulating splines — continue scrolling"), throttled (weakest, inferred from stale posts),
  emotional, shaped. Window = last 30 read posts, needs 10. History sampled every 5 min, drawn as 15-minute buckets over 48 h.
  Planned idea: detect throttling by comparing Following tab vs For You; not built.
- Golden pulsing **BAIT** chip (ONE shared 100 ms timer sets its glow; never a per-element animation, see the leak section; respects reduced-motion) with bait kinds on hover; per-account bait rate (>=40% of >=3 posts => +0.15).
- Phone use is the Threads app, which extensions cannot see; Mike tracks desktop (Chrome on his Mac "Keystone") only. A Safari/iOS port with CloudKit merge-sync was scoped and declined.
- Not for store distribution; maybe 2-3 friends via zip, no support, lookups off by default.

## Memory, leaks and performance (v0.5.1): what was wrong and how it was proven
Stress test (`test/stress/`, see its README): 2,000 posts scrolled with 40 on the page, on a 4,000-post / 1,500-account store.
| | v0.5.0 | v0.5.1 |
|---|---|---|
| post elements still alive (WeakRef + memory pressure, 1,200 created) | 1,200 | 40 (= on the page) |
| stored posts after 2,000 (cap 4,000) | 6,000, never trimmed | ~4,000-4,400, trimmed |
| long tasks (>50 ms) in 66 s | 51, 2.7 s total | 0 |
Causes: (1) `els` Map held every post container (unused); (2) **a per-chip `Element.animate()` with infinite iterations retained every removed post and its whole subtree** (found only after the first fix did not change the WeakRef count; the isolated micro-test with plain / animated / cancelled elements showed it);
(3) `save()` was a pure debounce, so continuous scrolling starved it: nothing saved or trimmed until a 4 s pause; (4) `recentOthers()` sorted all 4,000 posts on every call, and `refresh()` called it once per post on the page; (5) accounts had no cap; (6) blob URLs from exports were never revoked.
Fixes: no `els`; IntersectionObserver `unobserve` + dwell-timer cleanup via a MutationObserver `removedNodes` hook, with a `WeakSet`; `recentPosts` rolling array (O(1)) and a capped `featCache`; shingle memo in score.js; save has a 20 s ceiling, flushes on `pagehide`/tab hide, and `prune()` caps posts 4,000 / accounts 6,000 (rated, joined, tabs, likers kept; never-looked-up and long-unseen go first) / likers 80;
scan has a 1.5 s ceiling under constant DOM churn; the BAIT glow is ONE shared 100 ms timer that sets box-shadow on chips currently on the page; blob URLs revoked. The panel shows a Memory line (posts, accounts, stored KB, live pills, page heap) and `window.__tlStats()` exists for tests.
Method lessons: `usedJSHeapSize` cannot show a leak (garbage dominates; my first "settles at 9.4 MB" and the micro-test conclusions were wrong); use `leakCheck()` with the old build as a control. The pane is hidden, so animation events are never delivered there; do not infer animation behaviour of a visible Chrome from it, which is why the glow no longer uses animations at all.

## Re-categorize a post (v0.5.1)
Clicking a post's chip opens a menu (Normal / Neutral / Throttled / Baseline / Emotional / Shaped, the automatic one marked, plus Undo). The choice is stored as `rec.tell.u` (+ `ut`); the chip then shows the label with a pencil and a white ring; `itemFor` uses the user's label as the effective key, so the feed bars use it too.
It survives the 5 s Follow-badge re-check (`keepUser`) but a genuine repeat arrival starts fresh. The posts CSV has `telltale` (automatic) and `telltale_user`. These corrections are the ground truth for tuning thresholds: compare the two columns after a few days.

## Per-post telltales (v0.5.0): every home-feed post is rated as it arrives
`postTelltale` (score.js) gives each post ONE label; the chip in the post pill shows it (hover for the reasons) and the feed bars are built from the same labels (`feedState`: label share / saturation constant), so chips and bars cannot disagree.
Only `ctx === 'home'` posts are rated (profile/thread posts show no chip); the user's own posts are skipped; `settings.rate === false` hides chips. The label is fixed at arrival (`rec.tell = {k,s,r,a,ar,rep,t}`), except that for 5 s after arrival it is
re-checked, because the Follow badge can render late. Priority: Shaped > Emotional > Throttled > Baseline > Normal, else Neutral (needs score >= 0.4):
- **Throttled**: older than `STALE_H` = 24 h AND from an account you do not follow (older posts filling in for fresh ones). Score 0.5 at 24 h rising to 1.0 at 4 days. Followed accounts' old posts are Normal (they just post rarely).
- **Baseline**: you saw this exact post in an earlier feed view (> 10 min ago; the guard avoids Threads recycling nodes while you scroll), or a non-followed author already had >= 2 of your last 40 arrivals.
- **Emotional**: charged language (`emo`), heavy arguing underneath (reply:like, needs engagement counts which are still empty), or non-template engagement bait.
- **Shaped**: wording nearly identical to another author (only later copies are flagged, the first one keeps its label) or an account with the `flag` level.
- **Normal**: followed and not stale (assumes: on the home feed, NO Follow control means followed; unverified on real Threads). **Neutral** = fresh post from a stranger with nothing unusual (46% of the real feed).
Headline logic: the strongest anomaly bar >= 0.4 names the feed; Normal only when nothing else shows. `SAT.throttled = 0.4` (needs ~5 stale strangers in the last 30) was chosen from the real data: it fired in 30% of morning windows and ~0% of the rest of the day; 0.25 fired all day.
Real feed (1,377 home-like posts, 3 days): Neutral 46%, Normal 45%, Throttled 6% (morning 12% vs rest 4%; strangers: 12% throttled), Emotional 1%, Baseline/Shaped ~0%.
Fixture-tested: all six labels, late Follow badge flip, toggle, no chips on profile/thread. NOT tested on real Threads.

## Lessons from the second export (accounts + likers + backup JSON, Oct 5 07:51; built by an OLDER build, v~0.3)
- **0 of 1,454 accounts had a join date**, so every age signal (watched cohorts, "old but silent", cohort spikes) never ran. Causes found and fixed in 0.4.1: the About sheet was only looked for as the FIRST `[role=dialog]`
  (Threads can mount several), and the capture called `save()` every tick, which starved the debounce while the sheet was open. Now `aboutRoot()` checks every dialog, then falls back to any ancestor of a bare "Joined" label; saves only on change.
  Verified only on fixtures (empty dialog first; no dialog role at all).
- `bio` was polluted: 34 bios were "N Followers • N Threads." (og:description artifact) and 64 ended in "See the latest...". `cleanBio` in score.js strips both; bios are re-cleaned at boot.
- **Bare dates are timestamps.** All 43 "date-only posts" ("09/18/26") equalled the post's own date: Threads shows MM/DD/YY instead of "14h" for posts older than ~a week. These are media-only posts. cleanBody now drops them (an earlier test and comment claiming otherwise were wrong). Do not build a "posts a bare date daily" signal.
- The feed history in the backup was mostly artifact: Normal = 0.00 at all 39 points (followed bug), Baseline mean 0.54 (profile visits counted as feed). Fixed in 0.4.0; old history is not meaningful.
- Ratings: 59 positive (only 16 with follower data; mostly large public figures) vs 8 negative (4 with data: 72, 96, 464, 1,188 followers; three have empty bios). Too few and too biased (famous = real) to calibrate weights; do not fit a model to them. Collect more small-account labels (both directions).
- Looked-up accounts are mostly established: median 722 followers / 494 threads; 5% under 20 followers; 12 flagged. Digit-handle accounts: median 174 followers vs 833 (25% reach 300+ vs 66%) => weak signal, keep weight small.
- Likers: 57 captured on one post (09:44 UTC Oct 5), only 16 looked up (median ~450 followers); one outlier (32 followers, 0 threads). No evidence of like-farming yet; the other 41 are unchecked and the old build recorded no like times.
- One account rated -3 (name withheld, this repo is public): 17 of 27 posts under 45 chars, one emoji-only post, avg 37 chars. Short reaction filler is common in real replies too, so it is NOT scored; look at it in the card/CSV only.

## Activity vs age (Mike's rule: "a year old, no threads, three replies? def a bot")
On a profile page the extension reads the Threads / Replies / Reposts tab (tab from the URL) and counts the posts authored by that handle (`readProfileTabs`). A count is *complete* when the tab says
"No ... yet" or a short list (<= 8) stopped changing for 4 s; otherwise it is a lower bound shown as "N+". `judgeAccount` uses only complete counts: old (>= 6 months) with <= 5 threads+replies total is a strong fake signal
(0.35 at >= 12 months), and the age-as-real credit is dropped for such accounts; posting >= 10 threads with 0 replies is a weak fake signal; >= 10 replies with >= 3 threads is weak real evidence.
Pure lurkers look identical, so the card says so and a rating of +2 overrides. Unverified: whether Threads really navigates to `/@handle/replies`, the exact "No threads yet" wording, and whether `a.threads` (og:description "N Threads")
includes replies. Calibrate the thresholds against exported `threads_seen`/`replies_seen` for accounts Mike rated real vs fake.

## Lessons from the first real export (Oct 5: threadslens-posts.csv, 2,116 rows, 3 days)
- likes/replies/reposts were EMPTY in every row: `metric()` selectors do not match real Threads. Use the panel's **Export DOM sample** (structure only, no text/usernames) on the home feed to fix `metric()`/`extract()`; engagement-based features (reply:like conflict, late-like snapshots) are dead until then.
- 14% of `text` values were Threads chrome (timestamps like "14h", "Replying to @x", "Post not available"); 49 rows were the Activity (notifications) page. Fixed: `cleanBody`/`isUnavailable`, and scan() skips `/activity`.
- 18% of rows were profile-visit bursts (>=4 rows of one handle first-seen within 10 s; posts spanning months). They polluted feed-age statistics. Fixed: every post now has `ctx` (home/thread/profile/activity/search/other); feed readings, history and repeats use only `ctx === 'home'` posts and exclude `settings.me` (auto-set from the owner of a Post activity dialog that shows Insights). Legacy rows have no ctx and are excluded from the feed window.
- `followed` was either false (Follow control present) or null: feedState's followedShare was always 0, so the Normal bar could never fire. Fixed: on home, no Follow control => followed = true; elsewhere null stays unknown.
- "Emotional language" tag: 54 of 61 hits were caps/exclamations only (enthusiasm). Now needs a charged word plus caps/!!, or two charged words (61 -> 7 on that data). Word lists cannot see pointed political rhetorical questions; that needs a model labeler (Ollama on Keystone, or a Claude labeling pass over the CSV).
- Morning vs rest (America/Denver, bursts removed): median post age 9.6 h vs 2.2 h, 25% vs 8% older than 24 h, concentrated in non-followed accounts (13.4 h vs 4.4 h; followed accounts stay fresh, 1.3 h vs 0.7 h). Per day: Fri 25% vs 9%, Sat 2% vs 3% (n=47), Mon 47% (no comparison yet). Suggestive, 2 of 3 mornings; needs more mornings on the home feed.

## Post activity dialog (likes list)
Observed from Mike's screenshot: title "Post activity", header card of the post (handle, "3h"), rows Likes / Reposts / Insights, then one row per account:
avatar with a heart badge, handle, relative time ("35m", "1h"), display name, and a **Follow** button. `activityRows` finds rows by the Follow/Following button (outermost
only), climbs to the row, and reads handle (anchor href or first token), time token (assumed to be WHEN they liked: `L.when[handle]`) and post age (`L.postAt`).
Reposts may be mixed into the same list and are not distinguished yet. **Scan likers** (panel button, user-initiated) scrolls only the dialog (55-75% of a screen every 1.4-3 s,
stops at the end, 600 accounts, or Stop, and waits while the tab is hidden). **Look up these accounts** fetches one profile per 20-45 s (cap 90/hour, 15 min backoff on 429/5xx) for the scanned list only.
Panel shows per-owner liker stats, like-timing (median delay, share within the first hour) and top suspects; `threadslens-likers.csv` has `liked_min_after_post`.

## Testing without Threads (what worked)
`node test/smoke.js` for scoring. For DOM code: serve a static fixture with `python3 -m http.server` (dir names like `@handle/post/ID/index.html` so `location.pathname` matches), open it in the Claude browser pane,
then in the page run `window.chrome = {runtime:{id:'t',getManifest:()=>({version:'fixture'})}, storage:{local:{get:(k,cb)=>cb({}),set(){},remove(){}}}}` and `(0,eval)` the text of score.js and content.js.
The pane is usually **hidden**: `document.visibilityState` is 'hidden', smooth scrolling never animates and scroll events never fire. Override `visibilityState`, replace `Element.prototype.scrollBy` with an instant
version, and make fixtures poll scrollTop instead of listening for scroll events. Tool calls time out at 45 s, so start long jobs and poll in separate calls. The real Threads markup is still unverified.

## Known gaps / untested (verify against the real page first)
- **Threads DOM selectors are guesses**: post container `[data-pressable-container="true"]`, links `a[href*="/post/"]`, `time[datetime]`,
  icons via `svg[aria-label="Like"|"Reply"|"Repost"]`, follow control via `svg[aria-label="Follow"]`. If the panel stays on "Calibrating" or no pills appear, fix `SEL`/`extract` first.
- About-this-profile dialog format is confirmed from a paste: `Name / Some Name (@handle) / Joined / October 2026 · 100M+` (the "100M+" meaning is unknown; stored raw as `joinedNote`, not scored).
- The Post activity dialog parsing is verified only against a fixture built from the screenshot (52 rows, lazy loading, scan to the end). Unverified on real Threads: that Follow is a role=button/button, that rows are not virtualized away, that the time is the like time, and the second deep-lookup fetch pacing (only the first fetch was observed before the test was interrupted).
- Join date is not in the profile HTML; it is captured only when Mike opens "About this profile". Followers/threads come from og:description meta on lookups or from page text on a profile page.
- Throttled reading is low confidence. The lexicons are English and tuned to Mike's feed; false positives on real people are expected.

## Data model (`store`, saved under `chrome.storage.local` key `tl`)
`posts{id}` (handle, text, ts, likes/replies/reposts, followed, read, kind, ctx, seenAt, snaps[[t,likes]], tell{k,s,r,a,ar,rep,t,u?,ut?}), `accounts{handle}` (joined, joinedNote, followers, threads, bio, rating,
liker, likedPosts[], postN, baitN, tabs{threads|replies|reposts:{n,complete,at}}, fetchedAt, followedSeen, seen), `reads[]` (ids, last 500), `likers{owner/pid}` (handles{handle: t}, when{handle: ms}, postAt, total, postTs),
`history[{t, normal, baseline, throttled, emotional, shaped}]` (48 h), `settings{glance, rate, me}`. Caps: 4,000 posts, 6,000 accounts, 80 liker sets. Backup JSON = the whole store; import merges (existing values win, backup fills gaps).

## GitHub workflow (repo: github.com/sniglet/ThreadsLens, PUBLIC)
- The `gh` CLI on Mike's Mac is already logged in (account `sniglet`); git pushes over https. Never ask for, paste or store tokens or passwords.
- Commit identity is repo-local: name `sniglet`, email `134920+sniglet@users.noreply.github.com` (keeps his real address out of public history). End commits with the Co-Authored-By trailer.
- Work on a branch, push it, open a pull request for Mike to review and merge. Do not push to `main` directly unless he says so. Ask before anything destructive (force-push, delete, history rewrite, visibility change).
- Because the repo is public: never commit real third-party Threads handles, post text, exports (CSV/JSON/zip), DOM samples from his session, or screenshots. Use placeholders (`user123456`, `@example`). Before each push, scan the tree against the handles in his exports.
- History was rewritten once on 2026-10-15 (one clean commit) to remove a real handle that had been published. The old state is kept in a local backup mirror on his Mac; GitHub may still serve the old commits by exact SHA until it garbage-collects them.
- `*.zip`, `.DS_Store`, and export files are git-ignored. Attach zips to a GitHub Release if they are ever needed.

## Working agreements and lessons
- Mike is a hardware/iOS developer; he wants direct answers, honest uncertainty, and the next step, not a survey of options.
- Edits to `content.js` were silently lost once (a whole feature disappeared from the file). After editing, `grep` for the feature's key identifiers,
  run `node --check`, and run `node test/smoke.js`. Tell Mike to reload at `chrome://extensions` AND refresh the Threads tab (an orphaned old script shows
  "Extension context invalidated" until the tab is refreshed; the code handles this with a "refresh this page" message).
- Evidence of coordination to look for in exports: join-month spikes, near-duplicate phrasing across authors, late/fast likes, handles ending in many digits,
  high output with tiny audience, high bait share. Use his `your_rating` CSV column as labels to retune weights.
- Do not attribute activity to state actors from this data; at most say "coordinated, motivation unclear".
- Mike's iCloud lesson (data loss from a beta on his main Apple ID) applies if sync is ever built: use record-based merge, not a shared file.
