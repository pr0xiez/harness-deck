# Harness Deck — next features

A work spec, written to be split across several agents working in parallel.

Each item below is self-contained: it names the files it owns, the design
decisions already made, and what "done" looks like. An agent should be able to
pick up one item, read only the files it names, and land it without asking
anyone what the shape should be.

---

## The thesis

The app already does the hard part — several agent CLIs alive at once, surviving
window reloads, detected across PATH and WSL. What it does not yet do is any of
the things that *only matter because* there are several:

| Question the user has | Today's answer |
| --- | --- |
| Which of these six panes is waiting for me? | None. `activity` fires on any output, so it is on constantly. |
| Two agents on one task — how do they not overwrite each other? | They don't. Every pane in a workspace shares one `cwd`. |
| I broadcast one prompt; what did each agent actually do? | Read six terminals and decide for yourself. |
| Can I get my four-pane review setup back on another repo? | Duplicate the workspace and re-point every pane by hand. |

Wave 1 and 2 below answer those four. Wave 3 is polish and debt.

---

## Working agreement

**Verification, every item, before you call it done:**

```bash
npm run typecheck    # tsc over both projects — must be clean
npm test             # vitest, ~100ms
npm run smoke        # builds, boots the real app, asserts, exits 0/1
```

`npm run smoke` is the one that matters. Typecheck and a green build cannot see
a broken pty; the smoke test can, because it starts a real process through a
real one. If your item adds a capability the smoke test could assert cheaply,
add the assertion to `src/main/smoke.ts`.

**Isolation.** Give each agent its own git worktree and its own branch
(`feat/hd-1-attention`, …). Several of these items touch overlapping files; the
worktree is what stops that becoming a merge fight.

**Conventions to match** — the codebase has a voice, keep it:

- Comments explain *why*, never *what*. Look at the ones in `pty.ts` around
  session disposal, or `TerminalPane.tsx` around the exit race, for the register.
- The renderer never touches Node. Everything crosses through
  `src/preload/index.ts`.
- Anything shared across the process boundary is typed in `src/shared/types.ts`.
- New state that must survive a restart goes into `PersistedState` and gets a
  default in `DEFAULT_SETTINGS` (`src/renderer/src/store.ts`) so an older state
  file still hydrates — see how `voice` is spread in `hydrate()`.
- No new runtime dependencies without saying why in the PR.

**Conflict hotspots.** Four files attract edits from nearly every item:

- `src/shared/types.ts`
- `src/preload/index.ts`
- the `ipcMain.handle` block in `src/main/index.ts`
- `src/renderer/src/store.ts`

**HD-0 exists to defuse them — land it first, alone.** After HD-0, every other
item in wave 1 touches mostly its own files.

---

## HD-0 — Land the shared surface first

**Owner:** one agent, alone, before anyone else starts. Small.

Add every type, preload method and IPC registration that waves 1–2 need, wired
to stub implementations that compile and behave sanely. Nothing user-visible
ships; the point is that five agents can then work without three of them
rewriting the same twenty lines.

**Files:** `src/shared/types.ts`, `src/preload/index.ts`, `src/main/index.ts`.

**Add to `src/shared/types.ts`:**

```ts
// PaneStatus gains a fourth state — see HD-1.
export type PaneStatus = 'idle' | 'running' | 'waiting' | 'exited'

export interface PtyQuietEvent {
  id: string
  /** True when the pane went quiet, false on the first byte after that. */
  quiet: boolean
}

/** A git repository behind a workspace or pane folder. See HD-2. */
export interface RepoInfo {
  root: string
  branch: string
  dirty: number
  /** Set when this folder is a linked worktree rather than the main one. */
  worktreeOf?: string
}

export interface WorktreeRequest {
  repo: string
  /** Branch to create; the caller guarantees it is unique. */
  branch: string
  path: string
}

export interface WorktreeResult {
  ok: boolean
  path?: string
  error?: string
}

/** A launcher the user saved, merged with the detected ones. See HD-4. */
export interface SavedProfile {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  icon: string
  accent: string
  viaShell?: boolean
}
```

`Settings` gains `attention: AttentionSettings` (HD-1) and
`broadcastHistory: string[]` (HD-7). `Workspace` gains nothing yet.

**Add to the preload bridge**, alongside the existing groups:

```ts
pty: {
  …,
  onQuiet: (handler: (event: PtyQuietEvent) => void) => subscribe('pty:quiet', handler),
  transcript: (id: string): Promise<string> => ipcRenderer.invoke('pty:transcript', id),
},
git: {
  info: (dir: string): Promise<RepoInfo | null> => ipcRenderer.invoke('git:info', dir),
  addWorktree: (req: WorktreeRequest): Promise<WorktreeResult> => ipcRenderer.invoke('git:addWorktree', req),
  removeWorktree: (path: string): Promise<WorktreeResult> => ipcRenderer.invoke('git:removeWorktree', path),
  diffStat: (dir: string): Promise<string> => ipcRenderer.invoke('git:diffStat', dir),
},
profiles: {
  list: () => …,                       // move the existing `listProfiles` under here
  saveCustom: (profile: SavedProfile): Promise<SavedProfile[]> => …,
  removeCustom: (id: string): Promise<SavedProfile[]> => …,
},
attention: {
  setBadge: (count: number): void => ipcRenderer.send('app:setBadge', count),
},
```

Keep `listProfiles` as a deprecated alias so nothing breaks mid-wave.

**Stubs:** `git:*` returns `null` / `{ ok: false, error: 'not implemented' }`,
`pty:transcript` returns `''`, `profiles:saveCustom` returns the detected list
unchanged. `app:setBadge` can be real immediately — one line of
`app.setBadgeCount` on macOS/Linux, `win.setOverlayIcon`/`flashFrame` on Windows.

**Done when:** typecheck is clean, the smoke test still passes, and no
user-visible behaviour changed.

---

# Wave 1 — parallel, after HD-0

## HD-1 — Attention routing: "which pane needs me?"

**The problem.** `src/renderer/src/App.tsx` sets `activity: true` on any pty
output for an unfocused pane. An agent that is working produces output
constantly, so the dot is on for every busy pane and means nothing. The signal
the user actually wants is the inverse: **output stopped while the process is
still running** — the agent has hit a prompt, an approval gate, or finished.

**Files:** `src/main/pty.ts`, `src/main/pty.test.ts`,
`src/renderer/src/App.tsx`, `src/renderer/src/store.ts`,
`src/renderer/src/components/TerminalPane.tsx`,
`src/renderer/src/components/Sidebar.tsx`,
`src/renderer/src/components/SettingsDialog.tsx`.

**Design.**

Main process — extend `Session` in `pty.ts` with `lastDataAt: number` and
`quiet: boolean`, plus a `quietTimer`. In `queue()`, if the session was quiet,
clear the flag and emit `pty:quiet {quiet: false}`; then (re)arm a timer for
`QUIET_MS`. When it fires on a session that is still `running` *and* still
current (`isCurrent`), set `quiet` and emit `pty:quiet {quiet: true}`. Clear the
timer in `dispose()` next to `flushTimer`, and on exit — an exited pane is not
waiting for you, it is dead, and `pane.status` already says so.

`QUIET_MS = 2500` as the default. Put it behind a setting rather than hard-coding:

```ts
export interface AttentionSettings {
  /** Milliseconds of silence from a running process before it counts as waiting. */
  quietMs: number
  notify: boolean
  /** Bounce the dock / flash the taskbar as well as notifying. */
  badge: boolean
}
```

Renderer — a pane whose session reports quiet gets `status: 'waiting'`. Note
`PaneStatus` is a persisted field: `serialize()` in `store.ts` already forces
`'idle'` on save, so nothing extra is needed there, but check the `.pane` CSS
selectors in `styles.css` that key off status.

Then the payoff, in three places:

1. **Pane header** — amber dot, distinct from running-green and exited-grey.
   Replace the current activity dot for that pane; keep the plain activity dot
   only for non-agent panes.
2. **Sidebar** — `WorkspaceRow` already renders running/exited/idle counts. Add a
   waiting count that wins over the others, so a background workspace with an
   agent at a prompt is visible without switching to it.
3. **`Ctrl+Shift+J`** — focus the next waiting pane, searching the active
   workspace first and then the rest in order, switching workspace if needed.
   Register it in the `ctrl && event.shiftKey` block in `App.tsx`, add it to
   `HelpDialog`, and add a palette command.

Notify once per transition to waiting, never on a repeat, and only when the
window is unfocused — reuse the `document.hasFocus()` guard the bell already
uses in `TerminalPane.tsx`. Badge count = total waiting panes across all
workspaces, pushed through `api.attention.setBadge`.

**Acceptance criteria.**

- A pane running `sleep 5; echo done` shows running, flips to waiting ~2.5s
  after `done` lands, and flips back to running the moment more output arrives.
- A pane whose process exits shows exited, never waiting.
- Restarting a pane (`Ctrl+Shift+R`) clears any waiting state — the epoch bump
  must not leave a stale timer pointing at the old session.
- Six busy panes produce no notifications; the first one to go quiet produces
  exactly one.
- `Ctrl+Shift+J` with nothing waiting is a no-op, not an error.

**Tests.** `pty.test.ts` drives a stub pty with injectable `spawn` — extend it
with fake timers: feed `onData`, advance past `quietMs`, assert one
`pty:quiet {quiet: true}`; feed more data, assert the `false` event; fire
`onExit` mid-quiet and assert no further events for that id. The disposal race
that the existing tests pin down is exactly the shape to copy.

**Out of scope.** Parsing pane output for agent-specific prompt strings. Timing
alone is provider-agnostic and does not rot when a CLI changes its UI.

---

## HD-4 — Edit pane, and saved launchers

**The problem.** Two gaps that share a dialog.

`PaneSpec.env` is fully plumbed — typed in `shared/types.ts`, merged in
`buildEnv()` in `pty.ts`, persisted through `serialize()` in the renderer store —
and **no UI anywhere sets it**. It is a finished feature missing its front end.

Separately, `CustomCommandDialog` in `ProfileMenu.tsx` is one-shot: it opens a
pane and forgets the command. There is no way to keep `claude --resume`, or a
pane with a model pinned through the environment, as a launcher you can click
again tomorrow.

**Files:** new `src/renderer/src/components/PaneDialog.tsx`,
`src/renderer/src/components/ProfileMenu.tsx`,
`src/renderer/src/components/TerminalPane.tsx` (one header button),
`src/renderer/src/components/CommandPalette.tsx`, new
`src/main/profiles-store.ts`, `src/main/profiles.ts`.

**Design.**

One dialog serves both jobs: name, command line, working directory, and an
env-var table (add/remove rows, values masked behind a reveal toggle since
people will put API keys in there). Build it out of the existing `Modal`,
`Field` and `Dropdown` primitives in `components/ui.tsx` — do not introduce a
new form idiom.

Reached from: a pencil button in the pane header next to restart, the palette
("Edit pane…"), and the "Custom command…" entry in the profile menu.

Editing a pane writes through `updatePane` and, if the command or cwd changed,
bumps `epoch` to respawn — that path already exists in `restartPane`.

Saved launchers persist to `custom-profiles.json` beside `workspaces.json`,
using the same atomic-write helper as `src/main/store.ts`. `detectProfiles()`
appends them to its returned list with `kind: 'custom'` so they appear in the
profile menu, the palette and the empty-workspace quick picks with no changes to
those call sites. Availability for a saved profile is whatever
`findExecutable()` says about its first word.

**Acceptance criteria.**

- A pane given `ANTHROPIC_MODEL=…` in the dialog restarts with that variable set
  and it survives an app restart.
- Saved launchers appear in the profile menu under their own group and open a
  pane in one click.
- Deleting a saved launcher does not disturb panes already open from it.
- An env value containing `=` or spaces round-trips intact.

**Out of scope.** Secret storage. If someone puts a key in there it lands in
`custom-profiles.json` in plain text — say so in the dialog's hint text. Voice
keys use `safeStorage` because they are the app's own; pane env is the user's.

---

## HD-7 — Broadcast: history, targets, snippets

**The problem.** `BroadcastBar.tsx` sends to every running agent pane and clears
the box. Retyping a prompt you sent two minutes ago means retyping it. The
"agents only" checkbox is the only targeting control, so a workspace with three
agents where you want two has no answer.

**Files:** `src/renderer/src/components/BroadcastBar.tsx`,
`src/renderer/src/store.ts` (settings only).

**Design.**

- **History** — ↑/↓ from an empty or unmodified box walks recent prompts, most
  recent first. Persist the last 50 in `Settings.broadcastHistory`. Escape from
  a recalled prompt restores the draft, the way a shell does.
- **Per-pane targets** — replace the "agents only" checkbox with the chip row
  that is already rendered: make each chip a toggle. Default on for agent panes,
  off for shells; remember per workspace for the session. Keep an "all / agents"
  quick toggle so the common case stays one click.
- **Snippets** — a small saved list ("run the test suite and fix what fails"),
  stored in settings, inserted from a dropdown next to the send button.

Keep the 60ms delay before the carriage return. It is not decoration — TUIs drop
input pasted in the same tick as the newline.

**Acceptance criteria.**

- ↑ twice, edit, send: history gains the edited prompt and the original is
  unchanged.
- Dictation still lands in the box and still respects "press enter"
  (`registerVoiceSink` in the same file — do not break the ref plumbing it needs).
- Deselecting every target disables the send button rather than sending nowhere.

---

## HD-8 — Transcript export

**The problem.** `PtyManager` holds the last 512 KB of every pane
(`REPLAY_LIMIT`) and there is no way to get at it. Comparing two agents means
scrolling two terminals.

**Files:** `src/main/pty.ts` (one accessor), `src/main/index.ts` (one handler),
`src/renderer/src/components/TerminalPane.tsx`,
`src/renderer/src/components/CommandPalette.tsx`.

**Design.** `transcript(id)` returns `session.chunks.join('')`. Two commands:
"Copy pane transcript" (through `api.clipboard.write`) and "Save pane
transcript…" (a save dialog, default name
`<workspace>-<pane>-<yyyymmdd-hhmm>.txt`). Offer both raw and ANSI-stripped —
raw for replay, stripped for pasting into an issue. A ~20-line regex strip is
fine; do not add a dependency for it.

**Acceptance criteria.** Saving a pane that has scrolled past 512 KB writes the
tail without erroring. Saving an idle pane that never ran writes an empty file
rather than failing.

---

## HD-10 — Point the updater at GitHub releases

**The problem.** `src/main/updater.ts` reads a local `update.json` written by
`npm run release`. That works for the machine that builds. Anyone who installed
from the `latest-main` prerelease that CI publishes gets **no updates ever** —
the app has no idea that release channel exists. The README already flags this
as the missing half.

**Files:** `src/main/updater.ts`, `src/main/index.ts`,
`src/renderer/src/components/SettingsDialog.tsx`.

**Design.** Keep the local manifest path working — it is the fast local loop and
several people rely on it. Add a second source: fetch the release's
`latest*.yml`, compare with the existing `compareVersions`, download the
installer to a temp dir, verify sha512 (the check already exists for the local
path — reuse it, do not write a second one), then hand it to the same installer
launch. Settings picks the channel: local manifest, GitHub releases, or off.

Note the consequence recorded in the README: because publishing was taken away
from electron-builder so the two platform jobs could write into one release,
`latest*.yml` is **no longer emitted**. Restoring `--publish always` on the tag
path in `.github/workflows/build.yml` is part of this item, not a follow-up.

**Acceptance criteria.** A local manifest still triggers the toast exactly as it
does today. With the channel set to GitHub and no network, the updater reports
an error state and does not wedge the 15-minute poll. A corrupt download fails
the hash check and is never launched.

---

# Wave 2 — after wave 1 lands

## HD-2 — Worktree panes

**The problem.** The README's own pitch is "handing the same task to two models
and comparing". Today both models edit the same working tree, so the second one
to write wins and the comparison is meaningless. There is no git code anywhere
in `src/`.

**Files:** new `src/main/git.ts`, new `src/main/git.test.ts`,
`src/main/index.ts`, `src/renderer/src/components/ProfileMenu.tsx`,
`src/renderer/src/components/Toolbar.tsx`, `src/renderer/src/store.ts`.

**Design.**

`git.ts` shells out with `execFile` — the pattern is already in `profiles.ts`,
including the timeout and `windowsHide` handling. No git library.

- `info(dir)` → `git rev-parse --show-toplevel`, `--abbrev-ref HEAD`, and
  `status --porcelain | wc -l`, or `null` when the folder is not a repo.
- `addWorktree({repo, branch, path})` → `git worktree add -b <branch> <path>`.
- `removeWorktree(path)` → `git worktree remove --force <path>`.

In the profile menu, when the workspace folder is a repo, each agent gets a
second affordance: **open in a new worktree**. It creates `hd/<pane-name>` at
`<repo>/../.harness-deck/<repo-name>/<branch>` — outside the repo, so no agent
trips over it and no `.gitignore` entry is needed — and sets the pane's `cwd`
there. The pane records `worktree: string` so close can offer to remove it.

Show branch and dirty count in the toolbar beside the folder chip. Poll on
window focus and after a pane goes quiet (HD-1 gives you that event for free) —
not on a timer.

**Acceptance criteria.**

- Two agents launched into worktrees of one repo write to different directories
  and neither sees the other's edits.
- Closing a worktree pane asks before removing the worktree, and never removes
  the main working tree.
- A non-repo workspace shows no worktree options and no branch chip — no errors,
  no empty UI.
- Removing a worktree with uncommitted changes warns first.

**Out of scope.** Branch management UI, commits, merges. The pane has a shell in
it; that is where git lives.

---

## HD-3 — Compare what the agents did

**Depends on:** HD-2.

**Files:** new `src/renderer/src/components/CompareView.tsx`, `Toolbar.tsx`,
`CommandPalette.tsx`.

**Design.** A "Compare" action on any workspace with two or more worktree panes.
Full-area overlay, one column per pane: `git diff --stat` against the branch
point, expandable to the full diff, with each column headed by the pane's badge
and accent so it reads as the same object as the pane. Read-only. Escape closes.

This is the feature nothing else in the category has: broadcast one prompt, then
see three agents' answers as three diffs.

**Acceptance criteria.** Panes with no changes render "no changes" rather than an
empty column. A 5,000-line diff does not lock the renderer — cap what is rendered
and say so at the fold.

---

## HD-5 — Workspace templates

**The problem.** `duplicateWorkspace` copies a workspace including its folder.
There is no way to say "this four-pane review setup, but against a different
repo", which is the actual reuse people want.

**Files:** `src/renderer/src/store.ts`, `src/renderer/src/components/Sidebar.tsx`,
`CommandPalette.tsx`, `src/shared/types.ts`.

**Design.** A template is a workspace with its `cwd` removed and each pane's cwd
stored relative to it. "Save as template…" from the workspace menu; "New from
template…" picks a folder and instantiates. Store them in `PersistedState`
alongside workspaces — same file, same atomic write, no new persistence code.
`duplicateWorkspace` is 90% of the instantiation logic already; factor rather
than copy.

**Acceptance criteria.** A template made from a worktree workspace (HD-2)
instantiates fresh worktrees rather than pointing at the originals. A template
whose folder no longer exists fails loudly at instantiation, not silently into
`homedir()`.

---

## HD-6 — Scrollback that survives a real quit

**The problem.** The README says "survives restarts", and for a *window reload*
it does. Quit the app and every transcript is gone — `chunks` lives in
`PtyManager`, in memory, and the panes come back `idle` with blank terminals.

**Files:** `src/main/pty.ts`, new `src/main/scrollback.ts`, `src/main/index.ts`.

**Design.** On quit, and every ~30s for panes that have produced output, write
the tail (128 KB, less than the live 512 KB — this is for orientation, not
forensics) to `scrollback/<paneId>.log` in user data. On `ensure()` for a
session that does not exist yet, seed `chunks` from that file and mark the
replay so the renderer can print a dim `— previous session —` rule before it.
Delete a pane's file in `dispose()`. Prune orphans on boot: any file whose pane
id is not in the loaded state.

**Coordinate with HD-1** — both items edit `Session` and the flush path in
`pty.ts`. Land HD-1 first, rebase this on it.

**Acceptance criteria.** Quit with three live panes, reopen: each shows its last
output above a fresh prompt, and the processes are gone (not falsely reported as
running). Disk use stays bounded — a pane that has run for a week does not have a
1 GB log.

---

# Wave 3 — smaller, unblocked, take them when convenient

**HD-9 — Find across panes.** `PaneSearch` drives one `SearchAddon`. A
workspace-wide search that reports which panes match and jumps to each — the
registry in `terminals.ts` (`allTerminals()`) already gives you every live
instance.

**HD-11 — Auto-restart on crash.** An opt-in per pane: restart on a non-zero
exit, with backoff and a cap of three attempts, then stop and say so. The exit
bar in `TerminalPane.tsx` is where it belongs.

**HD-12 — SSH and container panes.** The WSL profiles in `profiles.ts` already
prove the shape: launch elsewhere, hand over a translated cwd through the
environment. `ssh <host>` and `docker exec -it <container>` are the same pattern
with a different translation. Reuse `HD_CWD`.

**HD-13 — Read-only pane lock.** One toggle that makes a pane refuse input, so a
long-running build or a production shell cannot be typed into by accident.
`attachCustomKeyEventHandler` in `TerminalPane.tsx` is the hook.

---

## Suggested assignment

| Wave | Item | Rough size | Touches |
| --- | --- | --- | --- |
| 0 | HD-0 shared surface | S | types, preload, IPC — **alone, first** |
| 1 | HD-1 attention routing | L | main + renderer |
| 1 | HD-4 pane dialog + saved launchers | M | renderer + small main |
| 1 | HD-7 broadcast history | S | renderer only |
| 1 | HD-8 transcript export | S | main + small renderer |
| 1 | HD-10 updater → releases | M | main + CI |
| 2 | HD-2 worktree panes | L | new main module + renderer |
| 2 | HD-5 templates | M | store-heavy |
| 2 | HD-6 persistent scrollback | M | pty.ts — **rebase on HD-1** |
| 3 | HD-3 compare view | M | renderer, needs HD-2 |
| 3 | HD-9, 11, 12, 13 | S each | isolated |

Five agents can run wave 1 concurrently once HD-0 is in. The only ordering
constraints in the whole spec are HD-0 before everything, HD-1 before HD-6, and
HD-2 before HD-3.

**If only two things get built: HD-1 and HD-2.** Together they are the
difference between a terminal multiplexer that happens to run agents and a
cockpit for running several of them at once.
