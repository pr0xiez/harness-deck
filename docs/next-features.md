# Harness Deck — next features, wave 2

A work spec, written to be split across several agents working in parallel.

Each item below is self-contained: it names the files it owns, the design
decisions already made, and what "done" looks like. An agent should be able to
pick up one item, read only the files it names, and land it without asking
anyone what the shape should be.

This is the second edition. The first — HD-0 through HD-13 — has shipped in
its entirety: attention routing, worktree panes and the compare view, saved
launchers, broadcast history/targets/snippets, transcript export, workspace
templates, persistent scrollback, the GitHub update channel, find across
panes, auto-restart, SSH/container panes and the read-only lock are all in
`main` and described in the README. The old text lives in git history; the
numbering continues from where it stopped.

---

## Where these came from

This wave was distilled from a teardown of **T3 Code**
([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) — the closest thing
this app has to a well-funded rival. The full notes, with mockups of
everything specced below, are in
[`docs/t3code-design-notes.html`](t3code-design-notes.html) (also published
[as an artifact](https://claude.ai/code/artifact/af48e948-3172-4c59-b7e3-22662bb4b25e)).

The short version: their atomic unit is a *conversation*, parsed out of each
provider by a per-provider adapter. Ours is a *process in a real terminal*,
deliberately unparsed. Every item below follows one rule:

> **Steal the semantics, keep the terminal.** Where they attach a behaviour to
> a thread, attach it to a pane, a workspace or a worktree. Where they parse
> provider events to know what happened, show the raw tail and let the user's
> eyes parse it. Where they run a hidden RPC, run a visible command in a pane.

One principle of theirs is adopted verbatim (from their AGENTS.md, credit
where due): **"If you added a way in, add the way out and the way to see it.
A one-way door is a bug."** Every state introduced below — mute, snooze,
acknowledge, remote — ships with its reverse.

---

## The thesis

Wave 1 made several agents *runnable* side by side. It did not close the loop
around a fan-out — prepare, direct, triage, judge, land — and it falls silent
the moment you stand up from the desk.

| Question the user has | Today's answer |
| --- | --- |
| Six panes are waiting — which first, and what does each want? | `Ctrl+Shift+J` jumps blind. The dot says *waiting*, never *why*. |
| Three agents, three fresh worktrees — why are they all stalled? | Each is discovering there is no `node_modules`. |
| Compare says pane B won. Now what? | Six git commands typed by hand, then close the losers one dialog at a time. |
| What did the *last* burst change? | Re-read the whole diff and remember what you saw last time. |
| The error is on screen in the shell pane. | Select, copy, `Ctrl+Shift+B`, paste, describe. |
| I walked away for coffee. | The deck notifies the desk it is sitting on. |

Waves A and B answer those. Wave C is smaller borrowings and polish.

---

## Working agreement

**Verification, every item, before you call it done:**

```bash
npm run typecheck    # tsc over both projects — must be clean
npm test             # vitest, ~100ms
npm run smoke        # builds, boots the real app, asserts, exits 0/1
```

`npm run smoke` is the one that matters. Typecheck and a green build cannot
see a broken pty; the smoke test can. If your item adds a capability the
smoke test could assert cheaply, add the assertion to `src/main/smoke.ts` —
HD-21 in particular must.

**Isolation.** Give each agent its own git worktree and its own branch
(`feat/hd-15-queue`, …). Several of these items touch overlapping files; the
worktree is what stops that becoming a merge fight.

**Conventions to match** — the codebase has a voice, keep it:

- Comments explain *why*, never *what*. The register to copy is in `pty.ts`
  around session disposal and `BroadcastBar.tsx` around the send delay.
- The renderer never touches Node. Everything crosses through
  `src/preload/index.ts`.
- Anything shared across the process boundary is typed in `src/shared/types.ts`.
- New persisted state goes into `PersistedState` with a default in
  `DEFAULT_SETTINGS` / the hydrate path (`src/renderer/src/store.ts`) so an
  older state file still hydrates.
- **Keyboard shortcuts are declared in `src/renderer/src/shortcuts.ts`** — the
  `SHORTCUTS` table is the single source of truth that App.tsx dispatches and
  TerminalPane reserves. (The wave-1 text said "the ctrl && shiftKey block in
  App.tsx"; that block has since been replaced by this table.) Add the id, the
  matcher, the App.tsx binding, a `HelpDialog` row and a palette command.
- No new runtime dependencies without saying why in the PR.

**Conflict hotspots.** The same four files as last time attract edits from
nearly every item — `src/shared/types.ts`, `src/preload/index.ts`, the
`ipcMain.handle` block in `src/main/index.ts`, `src/renderer/src/store.ts` —
plus one new one: **the quiet-event subscription**. Three items (HD-15, HD-20,
and the repo refresh that already exists in `Toolbar.tsx`) all want to react
to `pty:onQuiet`. Whoever lands first should lift the subscription into a
single store-level handler that fans out; whoever lands second rebases on it.

**HD-14 exists to defuse the rest — land it first, alone.**

---

## HD-14 — Land the shared surface first

**Owner:** one agent, alone, before anyone else starts. Small.

Add every type, preload method and IPC registration that waves A–C need,
wired to stub implementations that compile and behave sanely. Nothing
user-visible ships.

**Files:** `src/shared/types.ts`, `src/preload/index.ts`, `src/main/index.ts`.

**Add to `src/shared/types.ts`:**

```ts
// Pane gains, persisted (transient attention state — snooze, acknowledge —
// stays in the renderer's PaneView; it should not survive a restart):
//   attentionMuted?: boolean          // see HD-15

// PaneSpec gains:
//   setup?: string                    // run before the command, same pane. HD-16

// Workspace and WorkspaceTemplate gain:
//   setupCommand?: string             // copied onto worktree panes at creation. HD-16
//   actions?: WorkspaceAction[]       // HD-16

/** A named command the toolbar offers as one click. See HD-16. */
export interface WorkspaceAction {
  id: string
  label: string
  command: string
}

// DiffRequest gains:
//   base?: string                     // diff from this ref instead of the branch point. HD-20

/** One quiet-burst snapshot of a worktree. See HD-20. */
export interface CheckpointInfo {
  ref: string
  /** ISO time the burst ended. */
  at: string
  /** `git diff --shortstat` against the previous checkpoint, for the menu. */
  summary: string
}

/** Which PR-capable CLI is on PATH, if any. See HD-18. */
export type ForgeCli = 'gh' | 'glab'

/** What the remote server is doing right now. See HD-21/22. */
export interface RemoteStatus {
  enabled: boolean
  /** Reachable URL including the token fragment, when enabled. */
  url: string | null
  lan: boolean
  allowTyping: boolean
  clients: number
}
```

`Settings` gains `remote: RemoteSettings` (`{ enabled: false, lan: false,
allowTyping: false }` — the token is *not* settings: it is regenerated on
every enable and lives only in main-process memory).

**Add to the preload bridge**, alongside the existing groups:

```ts
pty: {
  …,
  /** Last `lines` non-empty lines, ANSI-stripped in main (stripAnsi lives there). */
  tail: (id: string, lines: number): Promise<string[]> => ipcRenderer.invoke('pty:tail', id, lines),
},
git: {
  …,
  checkpoint: (dir: string): Promise<void> => ipcRenderer.invoke('git:checkpoint', dir),
  checkpoints: (dir: string): Promise<CheckpointInfo[]> => ipcRenderer.invoke('git:checkpoints', dir),
  restoreCheckpoint: (dir: string, ref: string): Promise<WorktreeResult> => …,
  dropCheckpoints: (repoRoot: string, paneId: string): Promise<void> => …,
  deleteBranch: (repoRoot: string, branch: string): Promise<WorktreeResult> => …,
  forge: (): Promise<ForgeCli | null> => ipcRenderer.invoke('git:forge'),
},
remote: {
  status: (): Promise<RemoteStatus> => …,
  setEnabled: (on: boolean): Promise<RemoteStatus> => …,
  setLan: (on: boolean): Promise<RemoteStatus> => …,
  setAllowTyping: (on: boolean): Promise<RemoteStatus> => …,
  onStatus: (handler: (status: RemoteStatus) => void) => subscribe('remote:status', handler),
},
```

**Stubs:** `pty:tail` returns `[]`; `git:checkpoint*` return empties /
`{ ok: false, error: 'not implemented' }`; `git:forge` returns `null`;
`remote:*` returns `{ enabled: false, url: null, lan: false, allowTyping:
false, clients: 0 }` and `setEnabled` is a no-op. Nothing may open a socket.

**Done when:** typecheck is clean, the smoke test still passes, and no
user-visible behaviour changed.

---

# Wave A — parallel, after HD-14

## HD-15 — The waiting queue

**The problem.** Attention routing answers *that* a pane wants you; with six
panes it cannot answer *which first*, *why*, or *can it wait*. The rival's
answer is precomputed flags parsed out of provider events. Ours is better and
cheaper: **the last lines of a waiting pane's buffer are the reason it is
waiting** — for an agent at an approval gate, the tail *is* the question. The
buffer is already in `PtyManager`; `stripAnsi` already lives beside it.

**Files:** new `src/renderer/src/components/WaitingQueue.tsx`,
`src/renderer/src/store.ts`, `src/renderer/src/App.tsx`,
`src/renderer/src/shortcuts.ts`, `src/renderer/src/components/Sidebar.tsx`,
`src/renderer/src/components/TerminalPane.tsx` (mute in the pane menu),
`src/main/pty.ts` + `src/main/index.ts` (the `pty:tail` accessor beside
`pty:transcript`).

**Design.**

The overlay (`Ctrl+Shift+U`, palette: "Waiting queue") lists every waiting
pane across all workspaces, oldest first, each row: workspace swatch, profile
icon, pane name, time waiting, and the last three non-empty lines of its
buffer, stripped. Rows append as panes join; **rows never reorder while the
queue is open** — a list that reshuffles under your finger cannot be operated.
A pane with an empty buffer says "no output yet" rather than rendering blank.

Three verbs, all on the pane, all reversible:

- **Acknowledge** (`A`) — seen it. Leaves the badge count and notification
  set; the row stays, dimmed. Cleared automatically the next time the pane
  goes quiet (a fresh stop is fresh news).
- **Snooze** (`S`) — not now. Cycles *until next quiet* → *for an hour* →
  off. A snoozed pane is skipped by badge, notifications and `Ctrl+Shift+J`.
  **A snoozed pane that rings the terminal bell wakes immediately**, flagged
  `woke` — Claude Code rings the bell at permission prompts, so this is the
  rival's "raised hand outranks your snooze" rebuilt from a signal the
  terminal has carried for decades. `pane.bell` is already tracked.
- **Mute** (`M`, also in the pane header menu) — this pane never counts. For
  the build pane that goes quiet constantly. Persisted (`attentionMuted`).
  A muted pane keeps the amber dot in its own header — the local truth — but
  never reaches any aggregate: sidebar, badge, notification, queue, jump.

`Enter` jumps — reuse DeckSearch's zoom rule (a jump out of a zoomed pane
lands zoomed on the target, never hides it). `Ctrl+Shift+J` keeps working
without the overlay, now walking oldest-first and skipping snoozed and muted
panes. Store records `waitingSince` on the status transition; sidebar and
badge count only actionable panes (not muted, snoozed or acknowledged).

**Acceptance criteria.**

- Three waiting panes: queue shows them oldest first with stripped tails; a
  fourth going quiet appends without reordering the first three.
- Acknowledge drops the pane from the dock badge immediately; the pane
  re-quieting restores it.
- A snoozed pane never fires a notification; a bell during snooze returns it
  to the queue at once, flagged.
- Mute and unmute are the same control in the same two places. Muting never
  clears the pane's own header dot.
- `Ctrl+Shift+J` with everything snoozed is a no-op, not an error.
- `pty:tail` on a pane that has scrolled past the replay limit returns the
  tail without shipping the whole buffer across IPC.

**Tests.** Store transitions in `store.test.ts` (ack cleared by re-quiet;
bell clears snooze; muted pane excluded from counts). The tail accessor in
`pty.test.ts` beside the transcript tests.

**Out of scope.** Classifying tails ("this is an approval") — timing and
bytes only, nothing that rots when a CLI changes its UI. Per-pane `quietMs`.

---

## HD-16 — Worktree setup, and deck actions

**The problem.** Two gaps that share a dialog, like HD-4 before them.

Hand a task to three agents in three fresh worktrees and all three burn their
first minutes discovering there is no `node_modules` — worse, they each
"helpfully" run the install themselves, differently. And the commands a
workspace runs all day — tests, typecheck, dev server — are retyped into
shell panes because nothing remembers them.

**Files:** new `src/renderer/src/components/WorkspaceDialog.tsx`,
`src/renderer/src/components/Sidebar.tsx` (menu entry),
`src/renderer/src/components/Toolbar.tsx` (action chips),
`src/renderer/src/components/ProfileMenu.tsx` (worktree launch path),
`src/renderer/src/components/PaneDialog.tsx` (show/edit a pane's `setup`),
`src/renderer/src/store.ts`, `src/renderer/src/templates.ts`,
`src/main/pty.ts` (spawn composition), `src/renderer/src/shortcuts.ts`.

**Design.**

One dialog serves both jobs, built from the `Modal`/`Field` primitives in
`ui.tsx`: a **setup command** field ("After creating a worktree, run") and an
**actions table** (label + command line, add/remove). Reached from the
workspace menu in the sidebar and the palette.

*Setup* — when a worktree pane is created and the workspace has a setup
command, the pane's `PaneSpec.setup` is set from it. `pty.ts` composes the
spawn: with `setup` present, run via shell as `<setup> && exec <command
line>` (the quoting rules `shared/remote.ts` already proves). The install
scrolls by in the pane, then the agent takes over — same pane, no hidden
phase. `&&` is the design: **a failed setup leaves an exited pane with the
failure on screen**, never a silent fall-through to an agent in a broken
tree. Restart re-runs setup; installs are idempotent, that is fine. WSL and
remote panes get it through the same wrapping they already use.

*Actions* — the toolbar renders each action as a chip after the repo chip
(more than four collapse into a dropdown). Clicking one opens a fresh shell
pane in the workspace folder running the command, named after the action — a
normal pane: restartable, closable, transcript-able. `Alt+Shift+1…9` fires by
position. **Note the overlap:** `focus-pane-by-digit` currently matches
`Alt+digit` without excluding Shift; give it a `!e.shiftKey` guard as part of
this item (today `Alt+Shift+1` focuses pane 1 — a combination nobody is
documented to be using, but say so in the PR).

Templates carry both fields; instantiating a template against a new repo
brings its setup and its actions along.

**Acceptance criteria.**

- A worktree pane with setup `npm ci` shows the install, then the agent, in
  one pane; `Ctrl+Shift+R` re-runs both.
- Setup exiting non-zero leaves the pane exited with output visible; the
  agent never started.
- An action chip's pane is a normal pane in every respect.
- `Alt+Shift+2` runs the second action; `Alt+2` still focuses pane 2.
- A workspace with neither field set spawns byte-identical commands to today.
- A template made from this workspace reproduces both on another repo.

**Out of scope.** Per-action target picking (run in a chosen worktree) —
actions run in the workspace folder; a worktree has a pane, and that pane has
the agent in it. Secrets in setup commands.

---

## HD-17 — Selection → prompt

**The problem.** The error is on screen in the shell pane. Getting it in
front of the agents is select, copy, `Ctrl+Shift+B`, paste, fence it by
hand, describe. Five steps for the single most common hand-off in the app.

**Files:** `src/renderer/src/App.tsx`, `src/renderer/src/shortcuts.ts`,
`src/renderer/src/components/BroadcastBar.tsx`, `src/renderer/src/store.ts`.

**Design.** One shortcut, `Ctrl+Shift+E` ("send selection"): take the focused
pane's selection (`getTerminal(id).term.getSelection()` — xterm hands back
plain text, no stripping needed), open the broadcast bar, and append the
selection as a fenced block plus a trailing newline, caret after it, box
focused. The user types the instruction and sends. Targets keep their
existing default (agents on, shells off — the pane the error came from is
usually a shell, so it is already excluded). Plumb it as a `pendingInsert` on
the ui slice that `BroadcastBar` consumes on mount through its existing
`insert()`; do not touch the `registerVoiceSink` ref wiring — dictation
arrives through the same funnel and must keep working.

A selection containing ``` fences is fenced with `~~~` instead — the block
must survive its own contents.

**Acceptance criteria.**

- Multi-line selection arrives fenced and intact, no ANSI, no prompt noise
  beyond what was selected.
- No selection → no-op, not an empty fence.
- Works from a zoomed pane; the bar opens over it.
- Dictating after an insert appends after the block, exactly as `insert()`
  behaves today.
- History (`↑`) and snippets are unaffected.

**Out of scope.** A floating "send" pill over the selection (the mockup shows
one; the shortcut is the feature — chrome can follow). Sending from
unfocused panes.

---

## HD-18 — Ship a worktree

**The problem.** The compare view ends at a verdict and the app walks away:
landing the winner is `add`, `commit`, `push`, `pr create` typed by hand,
times N worktrees. The rival's one-button PR is their marketing headline —
"no terminal dance required". Ours should keep the dance *visible* and skip
the typing: **compose the exact commands, show them, and run them in a real
pane in that worktree.** Failures arrive as scrollback, not toast mysteries.

**Files:** new `src/renderer/src/components/ShipDialog.tsx`,
`src/renderer/src/components/CompareView.tsx` (a Ship button per worktree
column), `src/renderer/src/components/TerminalPane.tsx` (pane-menu entry for
worktree panes), `src/main/index.ts` (`git:forge` via the `findExecutable`
machinery in `src/main/profiles.ts`), `src/renderer/src/store.ts`.

**Design.**

The dialog: commit message (single field), three toggles — *commit all*,
*push*, *open PR* — and a read-only command preview that regenerates as the
toggles change:

```
git add -A
git commit -m '<message, quoted by the rules remote.ts proves>'
git push -u origin <branch>
gh pr create --fill
```

Two buttons: **Run in a pane** and **Copy commands**. Run opens a transient
pane in the worktree, `viaShell`, named `ship · <branch>` — a normal pane.
The preview *is* the contract: what runs is exactly what was shown.

`git:forge` answers `gh` / `glab` / null once per app run. No forge → the PR
toggle is disabled with the install command as hint text, the same voice
`detectProfiles` uses for a missing agent. `gh` owns auth and applies the
repo's PR template itself — the app never touches a token.

The column with nothing changed since the branch point (already known from
`diffRange`) opens the dialog with *commit* disabled and a sentence saying
why — never a commit that would come back empty.

Optional, last, and only when a `claude` profile is detected: a **Propose**
button beside the message field that runs `git diff | claude -p '…'` in main
(`execFile`, hard timeout, result editable, never auto-accepted). The
subscription the user already has, doing the small writing — no side API key.
If it proves flaky, ship without it; the feature is the pane, not the prose.

**Acceptance criteria.**

- The pane runs exactly the previewed chain; closing the dialog runs nothing.
- A message containing `'` or spaces round-trips into one commit.
- No `gh`/`glab`: chain composes without the PR step; toggle explains itself.
- A rejected push leaves the pane's output on screen; nothing retries.
- Ship is offered on worktree panes only — the workspace's own tree is the
  user's, and this app does not commit it.

**Out of scope.** Forge APIs, tokens, PR templates, auto-merge, draft PRs —
`gh pr create`'s flags are the escape hatch and the pane is right there.

---

# Wave B — after wave A lands

## HD-19 — Resolve a comparison

**Depends on:** HD-18 (a resolved comparison wants to say "shipped").

**The problem.** The fan-out's last mile: three worktrees, one winner. Today
the losers are closed one confirmation at a time, their branches linger, and
`.harness-deck/` silts up with the corpses of every experiment.

**Files:** `src/renderer/src/components/CompareView.tsx`,
`src/renderer/src/store.ts`, `src/main/git.ts` (`deleteBranch`),
`src/main/index.ts`.

**Design.** A **Resolve…** button in the compare header once two or more
worktree columns exist. The panel lists the worktree panes: pick a winner
(or "no winner"), losers checked by default, each row showing its dirty count
from `git info` so surprises surface *before* the confirm. One confirmation
names every pane that will be closed and every dirty tree among them. Then,
per loser: close the pane, remove the worktree (the existing flow's
warn-on-dirty rules, batched into that one confirm), delete the branch with
`git branch -d` from the repo root. `-d`, never `-D`: an unmerged branch
survives, its refusal shown inline on the row — deleting unmerged work takes
a trip to a shell, on purpose.

**Acceptance criteria.**

- The winner is untouched in every respect.
- Escape before the confirm changes nothing anywhere.
- A loser with uncommitted changes is named in the confirm; unchecking it
  leaves pane, worktree and branch alone.
- `branch -d` refusing (unmerged) is reported on the row; the worktree is
  still gone; nothing retries with `-D`.
- The main working tree can never be a loser.

**Out of scope.** Merging the winner anywhere — shipping is HD-18, and
merging is the forge's review flow or the user's shell.

---

## HD-20 — Quiet checkpoints

**The problem.** "What did the agent just do?" has one answer today: re-read
the whole diff. The rival brackets every parsed *turn* with a hidden git ref
and got per-turn diffs and revert from it — their best engineering. We
refuse the parsing, but we already trust a turn boundary of our own: **the
quiet event.** The toolbar already re-reads git on it, on the recorded
observation that an agent falling silent has usually just stopped writing
files. Snapshot the tree at that same moment and the compare view can answer
"the last burst" instead of "everything".

**Files:** `src/main/git.ts`, `src/main/git.test.ts`, `src/main/index.ts`,
`src/renderer/src/store.ts` (the shared quiet subscription — see the
hotspot note; rebase on HD-15), `src/renderer/src/components/CompareView.tsx`.

**Design.**

Capture, renderer-driven like the repo refresh: on quiet for a worktree pane,
call `git:checkpoint(dir)` (debounced a second). Main does the cheap outs
first — porcelain clean, or tree identical to the last checkpoint → no ref.
Otherwise build the snapshot **without touching the user's index or tree**:
a temporary `GIT_INDEX_FILE`, `git add -A`, `write-tree`, `commit-tree -p
HEAD`, `update-ref refs/hd/<paneId>/<n>`. Keep the newest 20; prune the rest.
Invisible to `git status` and `git log` by construction.

Read: each compare column's baseline becomes a dropdown — *since branch
point* (today's behaviour, still the default) or any burst, listed with time
and `--shortstat` summary. `DiffRequest.base` carries the choice into
`diffRange`.

Restore: *Restore worktree to burst N…* in the same dropdown, behind the
warn-on-dirty confirm the worktree close already uses. `git restore
--source=<ref> --worktree -- .` returns every tracked file to the burst; a
file the agent created *after* that burst and never checkpointed survives,
and the confirm says how many such files there are — honesty over a
`git clean` nobody asked for.

Cleanup: removing a worktree drops its `refs/hd/<paneId>/*`; boot prunes refs
whose pane no longer exists, the same way scrollback prunes its orphans.

**Acceptance criteria.**

- A burst that changed nothing creates no ref; two identical trees, one ref.
- The 21st checkpoint prunes the 1st.
- `git status` / `git log` in the worktree never show any of it.
- Compare with a burst baseline shows only that burst's changes; the
  truncation fold still applies.
- Restore never touches the index; the untracked caveat is stated in the
  confirm, with the count.
- Worktree removal leaves no `refs/hd/<paneId>` behind.

**Tests.** `git.test.ts` against a scratch repo: checkpoint → mutate →
checkpoint → list shows two with sane summaries; restore round-trips a file;
prune-at-20 drops the oldest.

**Out of scope.** Conversation rewind — `claude --resume` and its kin belong
to the CLIs; the deck promises the tree, nothing else. Checkpointing
non-worktree panes: the workspace's main tree is the user's.

---

## HD-21 — Deck Remote: glance

**The problem.** Every signal the app can raise — notification, badge, amber
dot — lands on the machine you just walked away from. The rival's
phone-first story is the feature its maker daily-drives; it fell out of their
architecture. It falls out of ours too: **processes already live in the main
process, addressed by pane id, with replay buffers** — the renderer is
already just a client. Add a second, deliberately smaller one.

**Files:** new `src/main/remote-server.ts`, new
`src/main/remote-server.test.ts`, `src/main/index.ts`,
`src/renderer/src/components/SettingsDialog.tsx`, a new tiny page —
`src/remote/index.html` + `src/remote/main.ts` (an extra electron-vite
renderer input, bundled into `out/` and served from disk), `src/main/smoke.ts`.

**Design.**

A plain `node:http` server in main — no new runtime dependency; SSE for
streams, static files for the page. **Off by default, and off means no
socket exists.** The README's promise — nothing reaches the network until
changed by hand — extends to listening: nothing *listens* either.

Settings → Remote: an enable toggle, the URL with a fresh random token in
the fragment (`http://127.0.0.1:<port>/#<token>` — regenerated every enable,
held only in main memory), and a *reachable on the local network* toggle
that rebinds from loopback to all interfaces next to one honest sentence:
this is plain HTTP; anyone on the network with the link can watch; prefer
your tailnet. Loopback-only is already useful — `tailscale serve` and
`ssh -L` both terminate there, encrypted by someone whose job that is. A QR
of the URL is worth one small dependency; if that argument fails review, a
copyable URL ships first.

The page is the waiting queue in your pocket: workspaces with status dots,
waiting panes with `pty:tail` previews, and a live **read-only** terminal
view per pane — xterm.js (already in the tree) fed the replay tail (capped
~64 KB) then live bytes over SSE. Pane names and workspace grouping come from
the persisted state `store.ts` already owns; live status and quiet come from
`PtyManager`. R1 has **no write route at all** — read-only is not a flag to
check, it is an endpoint that does not exist.

**Acceptance criteria.**

- Disabled (the default): no port is open, provably; toggling off closes the
  socket and severs clients.
- Wrong or missing token: 401 on every route, including the page.
- Two enables, two different tokens.
- A pane going quiet reaches an open phone page within a second, no polling.
- A pane with 512 KB of scrollback does not ship 512 KB to the phone.
- A window reload does not restart the server (it lives in main, like the
  panes themselves).
- Smoke: enable, fetch `/` with and without the token, assert 200/401, disable,
  assert refused.

**Out of scope.** Typing (HD-22). TLS, tunnels, accounts, push notifications,
native apps — reachability and encryption are the tailnet's job, and the
page being open *is* the notification.

---

# Wave C — smaller, unblocked, take them when convenient

## HD-22 — Deck Remote: hands

**Depends on:** HD-21. Typing from the phone, behind an *allow typing*
toggle that defaults off (403 when off — checked per request, not per
connection). Input takes the exact `pty.write` path local keys take,
including the 60 ms pause before a carriage return that `BroadcastBar`
documents — TUIs drop input pasted in the same tick as its newline. Add the
broadcast box and the queue verbs (ack / snooze), forwarded to the renderer
so the store stays the one owner of attention state. Acceptance: with typing
off nothing writes; `1↵` from a phone answers an approval exactly as it does
at the desk; two connected phones see each other's effects.

## HD-23 — Compare: unified and split

A compare column is too narrow for side-by-side, so: clicking a column
header zooms it to the full overlay width (Escape steps back to all
columns), and the zoomed view gains a Unified / Split segmented control next
to Summary / Full diff. Split renders old/new panes from the same patch text
— no dependency; the `Lines` renderer grows a twin, and the 700-line cap
already protects the frame budget.

## HD-24 — Find across every workspace

`DeckSearch` answers "which of these six panes"; add a scope toggle for
"which of these six *workspaces*". Mounted workspaces search live terminals
through the existing registry; unmounted ones fall back to a main-side scan
of `pty:transcript` text for counts, and jumping mounts the workspace then
walks to the match. The summary line says which workspaces could not be
counted, rather than pretending zero.

## HD-25 — Launcher variants

Saved launchers already carry env and args — what is missing is the
affordance. "Duplicate as variant…" on any profile opens the existing
`PaneDialog` prefilled, with hint text naming the useful knobs:
`CLAUDE_CONFIG_DIR` for a second account, model-pinning variables, `--resume`.
Renderer only; ten lines of plumbing, a real unlock (work/personal accounts
as two one-click launchers).

## HD-26 — `hd .`

Opening the app *from* a repo should land in that repo's workspace. The
single-instance lock already forwards a second launch's argv: handle
`--open <dir>` by focusing (or creating) the workspace whose folder matches.
Ship the shell side as a documented function in the README (`hd()` calling
the installed binary with `--open "$PWD"`), per platform — there is no npm
bin to publish and no PATH to fight.

## HD-27 — Editable keybindings

`SHORTCUTS` in `shortcuts.ts` is already the single source of truth; let a
`keybindings.json` in user data remap chords by `ShortcutId`. Parsing and
merging are pure functions beside the table (testable in plain node);
`HelpDialog` shows the *effective* bindings and flags conflicts — two ids on
one chord render both red rather than one silently winning. No when-clauses,
no chords-of-chords: a flat remap is 80 % of the value at 20 % of the rot.

---

## Suggested assignment

| Wave | Item | Rough size | Touches |
| --- | --- | --- | --- |
| 0 | HD-14 shared surface | S | types, preload, IPC — **alone, first** |
| A | HD-15 waiting queue | L | renderer + tail IPC |
| A | HD-16 setup + actions | M | store, toolbar, pty spawn |
| A | HD-17 selection → prompt | S | renderer only |
| A | HD-18 ship a worktree | M | compare, new dialog, forge probe |
| B | HD-19 resolve | S–M | compare + git.ts — **after HD-18** |
| B | HD-20 quiet checkpoints | M | git.ts + compare — **rebase on HD-15** |
| B | HD-21 remote: glance | L | new main module + tiny page |
| C | HD-22 remote: hands | M | **after HD-21** |
| C | HD-23…HD-27 | S each | isolated |

Four agents can run wave A concurrently once HD-14 is in. The ordering
constraints in the whole spec: HD-14 before everything, HD-18 before HD-19,
HD-21 before HD-22, and HD-15 before HD-20 (both grow the quiet
subscription; the queue also settles the attention semantics the checkpoint
UI sits beside).

**If only two things get built: HD-15 and HD-18.** Triage and landing.
Together they finish the loop the compare view opened — see what the agents
did, decide, and be done without leaving the deck.
