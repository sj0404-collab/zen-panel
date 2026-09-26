# Tests (jsdom, no network)

Regression suites for the panel and the hub UIs. Everything runs locally:
`npm test` (CI runs the same via `tests.yml`).

The full testing plan - what is automated, the manual checklist, the known
breakages and the release criteria - lives in **[../TESTING.md](../TESTING.md)**.

| Suite | Covers |
|---|---|
| `panel-tabs-e2e.js` | session/model cards, tabbed second layer, no-reload switching, save/stop PUTs, dead-tab drop, 403 backoff (mark/stop/pause/alert), per-OS slots, ETag 304, refresh auto-pause, hub gate tokens (+probe/recovery/reuse, zt-strip, probe-url, open diagnostic, safe links, probe logging, preview zt, 429 hint) |
| `hub-connect-e2e.js` | hub APK connect page: dispatch token, session poll, /m open URL |
| `hub-gate-test.js` | the `HUB_TOKEN` gate in `server.js` (no deps): `?zt=`, `x-hub-token`, cookie, loopback, 401 on a websocket upgrade |
| `mobile-touch-test.js` | phone taps/scroll fixes + default hub-work folder, plus grep invariants over the workflows and `tools/` |
| `handoff-test.js` | the handoff state machine (`src/handoff.js`) on a fake clock |
| `opencode-resume-test.js` | the "where did I stop" report: ids, folders, dirty files, todos |
| `offline-cache-test.js` | `offline.js` fetch wrapper in a vm sandbox + `sw.js` shell cache |
| `panel-offline-test.js` | the APK panel offline layer between the OFFLINE-LAYER markers |
| `vault-test.js` | the external-memory PWA: IndexedDB + service worker |
| `work-backup-test.sh` | round-trip of `backup-work.sh` + `restore-work.sh` against a local bare repo |

The panel suite stubs `fetch` (GitHub API), the hub suites stub it too
(hub server API) — no tokens, no network. Env overrides for local runs:
`PANEL_HTML`, `JSDOM_PATH`.

Known gap: `tools/open_tunnel.sh` and `tools/tunnel_health.sh` have no tests at
all, so the tunnel is only exercised on a live runner (see TESTING.md §2.3).
