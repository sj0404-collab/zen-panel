# Tests (jsdom, no network)

Regression suites for the panel and the hub UIs. Everything runs locally:
`npm test` (CI runs the same via `tests.yml`).

| Suite | Covers |
|---|---|
| `panel-tabs-e2e.js` | session/model cards, tabbed second layer, no-reload switching, save/stop PUTs, dead-tab drop, 403 backoff (mark/stop/pause/alert), per-OS slots, ETag 304, refresh auto-pause, hub gate tokens (+probe/recovery/reuse, zt-strip, probe-url, open diagnostic, safe links, probe logging, preview zt, 429 hint) |
| `hub-connect-e2e.js` | hub APK connect page: dispatch token, session poll, /m open URL |
| `mobile-touch-test.js` | phone taps/scroll fixes + default hub-work folder |

The panel suite stubs `fetch` (GitHub API), the hub suites stub it too
(hub server API) — no tokens, no network. Env overrides for local runs:
`PANEL_HTML`, `JSDOM_PATH`.
