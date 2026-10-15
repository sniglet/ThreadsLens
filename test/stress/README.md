# Memory / performance stress test (no Threads needed)

Scrolls a fake virtualized feed (40 posts on the page, thousands created and removed) on top of a mature store (4,000 posts, 1,500 accounts) and reports retained elements, stored counts and long tasks.

1. From the ThreadsLens folder: `python3 -m http.server 8099`
2. Open `http://localhost:8099/test/stress/index.html` in Chrome (the page is its own fixture, the harness loads `/score.js` and `/content.js` from the server root).
3. In the page console: load the harness and start, then read the result:
   ```js
   (0, eval)(await (await fetch('/test/stress/harness.js')).text());
   startStress('my run', 100, 650);      // 100 batches of 20 posts, 650 ms apart; runs in the background
   // when window.__res.done is true:
   window.__res.samples.at(-1)           // heap, retained elements (els), stored posts, long tasks
   await window.leakCheck()              // how many created post elements are STILL ALIVE after memory pressure
   ```
**Pass criteria:** `leakCheck().stillAlive` is about the number of posts on the page (40), not the number created. `window.__tlStats()` shows every cache at its cap.

Notes learned the hard way:
- `performance.memory.usedJSHeapSize` is dominated by uncollected garbage and cannot show a leak. Use `leakCheck()` (WeakRefs + allocation pressure). Run the OLD behavior as a control, or you cannot tell whether GC ran.
- A per-element `Element.animate()` with `iterations: Infinity` kept every removed post alive. Do not animate per post.
- The lag meter in the harness is polluted by background-tab timer throttling; trust `longTasks` instead.
- `performance.measureUserAgentSpecificMemory()` throws SecurityError in the Claude browser pane even when cross-origin isolated.
