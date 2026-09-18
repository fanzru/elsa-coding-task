# Video outline (target 7–8 minutes)

| Time | Section | Show |
|---|---|---|
| 0:00–0:30 | **Intro** | Who you are, what you work on. |
| 0:30–1:15 | **Assignment overview** | The three acceptance criteria in your own words; what you chose to implement (server + demo client), what is mocked. |
| 1:15–3:15 | **Solution overview** | `docs/DESIGN.md` architecture diagram. The one idea: one session = one actor (single writer ⇒ consistent scores). Coalesced leaderboard (why O(N²) matters). Snapshot-then-stream + idempotent answers. Cluster mode: owner + gateways via Redis. |
| 3:15–5:00 | **AI collaboration story** | Claude Code as pair-programmer. Three concrete examples from `AI_COLLABORATION.md`: (1) join-storm O(N²) found only by the load test (−77 % messages); (2) stale-cache bug caught by an AI-written test (#4.1); (3) StrictMode socket bug found only by clicking the UI (#7). Limitations: over-generation, wrong test expectations, library drift. Your verification ladder: tsc → unit/property → actor → integration → load test → manual UI. |
| 5:00–7:00 | **Demo** | `pnpm dev`. Two browser tabs (two players) + `pnpm test:load -- --clients 500` in a terminal so the leaderboard fills with bots. Answer a question, show the result and the board moving. Reload a tab mid-quiz → score kept. `pnpm test` (52 tests) and the load-test summary table. Optional: `/metrics`. |
| 7:00–7:45 | **Conclusion** | Learnings (measure, don't trust), what you'd add next (event-sourced state in Redis Streams for crash recovery, Durable Objects deployment, delta leaderboards). |

Tips: pre-start the servers and the bots before recording the demo section; keep the terminal
font large; have `DESIGN.md` §8.2 (the numbers table) open in a tab.
