# Harness Deck

Read `README.md` before changing the application. This is an Electron desktop
app with a React renderer, a typed preload bridge, and main-process PTYs. It is
an independent repository, not part of a workspace or monorepo.

Use Node 24.15+ within Node 24. Gates are `npm run typecheck`, `npm test`,
`npm run build`, and the native Electron smoke test (`npm run smoke`). Match
native dependencies to the platform running Electron. In this WSL checkout,
Electron is Windows: use `node_modules/electron/dist/electron.exe . --smoke`;
do not replace the installed dependency tree just to get a Linux desktop.
OAuth integration tests need permission to bind a temporary loopback listener.
Smoke tests use an isolated user-data folder and write screenshots in `.tmp/`.
Unpackaged local runs use `build/icon-dev.ico` on Windows and `icon-dev.png`
elsewhere, with a separate Windows taskbar AppUserModelID. Packaged icons stay
under `build/icon.*`. `npm run icons -- --dev-only` regenerates the DEV assets;
full icon generation also updates the release ICNS when run on macOS.
When launching Windows tools from WSL, restore the Windows Machine/User PATH
and clear inherited `HD_CWD`/`WSLENV` in that child process. A Linux unit-test
run needs its Linux Node PATH and clean `HD_CWD`, `WSLENV`, and `_` variables;
otherwise existing process/shell tests can fail because of the launching shell.

- Keep all IPC names in `src/shared/ipc.ts` and APIs in `src/preload/index.ts`.
  Update the typed renderer test bridge in `src/renderer/src/test/harness.ts`.
- Keep terminal panes mounted during page navigation. Background services run
  in main, not renderer effects; unsubscribe renderer event handlers on unmount.
- Preserve user changes already present in the working tree. Never print or
  commit credentials, user-data files, or environment secrets.
- Work-board persistence is separate from workspace snapshots. All mutations
  use the main-process writer and optimistic revisions. Completion is explicit.
- Personal-agent code is documented in `docs/personal-agent.md`. Persist agent
  state separately in `personal-agent.json`; invalid/newer data blocks editing.
  Never overwrite a valid recovery backup with a corrupt primary.
- OpenRouter keys and Google tokens stay in the main process and OS-encrypted
  files. Refuse plaintext keychain fallbacks. Never include tokens in prompts,
  snapshots, diagnostic errors or workspace state.
- All personal-agent Google writes are account-bound, user-reviewed proposals.
  Save `running` before remote effects; interrupted/ambiguous writes become
  `uncertain` and require user verification. Never automatically retry them.
  At most 20 open proposals. An expired Google refresh token disconnects
  locally and notifies once; never resend a write after a 401.
- Scheduled check-ins are opt-in, bounded, deduplicated by local day/slot, and
  respect time zones, snooze and focus sessions. Background model runs receive
  only read/planning tools and never overwrite a plan already set today. The scheduler stops when Deck quits.
- Keep personal-agent tools allowlisted. Email/calendar/board text is untrusted
  context. No arbitrary URLs, shell, credential or terminal-transcript tools.
- Personal-agent subscription runs use signed-in Codex/Claude CLIs through
  `personal-cli.ts` and `personal-subscription.ts`. Never read/copy their auth
  tokens or fall back to API billing. Clear API/provider routing after WSL shell
  startup; isolate CLI customizations and execution tools. Structured tool
  requests go only through Deck's bounded allowlisted executor. Preserve legacy
  OpenRouter settings when migrating personal-agent data.
- Update relevant documentation when changing commands, modules or invariants.
