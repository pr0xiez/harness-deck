# Work board investigation

Implementation added 2026-09-07: the four-column page, shared main-process
service, atomic board storage, revision conflicts, IPC updates, opt-in local
HTTP access and bundled `hd-work` client are now implemented. The proposal
below is retained as design context. The CLI uses Deck's Electron runtime;
native wrappers and a Windows-interoperability WSL wrapper are generated per
app profile. See the [manual](manual.md) for usage and supported-path limitations.

Validation: production build and main typecheck pass; nine focused board/UI
checks pass. Windows development and unpacked-package smoke runs each pass
24/24 checks with no renderer errors. The packaged run also exercises the WSL
wrapper with `HD_WORK_WSL_SMOKE=1`. Process, PTY and session tests pass 121/121
with a clean child-process environment. The full suite initially reported
671 passes, four failures and four skips: three failures were inherited
PATH/WSL environment assumptions, and one is an existing notification test.
Full renderer typechecking is blocked only by that existing test's removed
`AttentionSettings.notify` property in `src/renderer/src/store.test.ts:1230`.
Native macOS/Linux packaged runtime behavior has not been exercised here;
the POSIX wrapper is covered with the local Node runtime.

Investigated 2026-09-07 against the current working tree. This is a repository design investigation, not
a survey of hosted task trackers or harness protocol compatibility.

## Recommendation

Add a **Board** destination to Harness Deck with four fixed columns, in this
order: **Ideas**, **In progress**, **Won't do**, **Done**. Start with one local
board for the app, optional workspace links, and a small command-line client
that harnesses can use to read, create, edit and move cards. Both interfaces
must use the same main-process service and persisted data.

The first useful release includes both human and harness editing. A board
that only works through the UI does not satisfy this use case.

## First-version behavior

- Add a card with a required title and optional plain-text description. Default
  to Ideas; adding from a column preselects that column.
- Click a card to edit title, description and optional workspace link. Show
  created/updated times and its stable ID in the detail panel.
- Drag between columns, or use a **Move to** menu that works with the keyboard.
  All transitions are allowed, including reopening Done and Won't do cards.
- Append new and moved cards to the destination column. Keep other cards in
  their existing order. Defer manual reordering within a column.
- Display column counts, an empty-state Add card action, and a workspace filter
  with All work and Unassigned choices. Default to All work.
- Keep cards when a linked workspace is deleted. Show the missing link and
  allow clearing it or choosing a different workspace.
- Preserve an unsaved edit if another client changes that card. Explain the
  conflict and let the user reload current values before submitting again.

Use Won't do to discard work in this first version; permanent deletion,
archives, labels, priorities, due dates, checklists, comments, attachments,
custom columns, multiple boards and cloud sync can follow actual usage.

A card is a work item, independent of a terminal. Moving to In progress does
not launch a harness. Quiet output, successful process exit and a merged PR
do not automatically move it to Done. The user or harness makes that decision
explicitly. Agent assignment and a future Start work action are separate features.

## What the repository already provides

| Existing code | Implication for the board |
| --- | --- |
| `src/renderer/src/App.tsx`, `components/Sidebar.tsx`, `components/McpPage.tsx` | A separate destination can preserve mounted terminals while hiding the deck. Reuse this layout pattern. |
| `src/renderer/src/store.ts`: `UiState`, `serialize`, `startPersistence` | Navigation currently distinguishes only deck/mcps. Workspaces are saved as a full renderer snapshot after a 400 ms debounce. |
| `src/main/store.ts`: `writeJsonAtomic`, `loadState` | Existing temp-file replacement and backup handling are useful, but board data needs its own validation and ownership. |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts` | Established typed channel/bridge/handler structure for renderer operations. |
| `src/main/pty.ts`: `buildEnv` | Launch-time integration point for harness client discovery; native and WSL execution require separate handling. |
| `src/main/index.ts`: remote handlers and second-instance handler | Remote APIs are currently disabled stubs; second launches only focus the window. Neither is an existing work-management API. |
| `src/main/mcp.ts` and MCP management page | These manage external server configuration; they do not expose Deck as an MCP server. |

The current working tree contains substantial ongoing MCP, GitHub and UI
changes. Implement against those changes and preserve them.

## Data and mutation design

Use a separate `<userData>/work-board.json`, owned exclusively by a new
`WorkBoardService` in main. Do not add editable cards to the renderer's
`PersistedState` snapshot: a delayed UI save could overwrite a harness change.
This intentionally differs from the older next-features document's general
advice to put new persisted state in `PersistedState`; this feature has
multiple writers outside the renderer.

Suggested initial schema:

```ts
type WorkStatus = 'ideas' | 'in_progress' | 'wont_do' | 'done'

interface WorkItem {
  id: string                  // UUID, stable across moves and restarts
  title: string               // trimmed, 1–200 characters
  description: string         // plain text, at most 32 KiB UTF-8
  status: WorkStatus
  workspaceId: string | null
  revision: number            // increment on every successful change
  createdAt: string           // service-generated ISO timestamp
  updatedAt: string
}

interface WorkBoardFile {
  version: 1
  revision: number            // snapshot/event ordering
  items: WorkItem[]           // array order determines order within a column
}
```

Serialize all mutations in main. Validate untrusted inputs at the service
boundary, including IDs, status, field limits and permitted patch fields.
Build the next snapshot, persist successfully, then commit it in memory and
publish a changed event. On write failure retain the old state and return an
error. The UI must not represent a failed save as completed.

Edits and moves require `expectedRevision` for the affected card. Two clients
editing the same revision produce one success and one conflict containing the
current card. Unrelated-card updates should both succeed. Main assigns IDs,
revisions and timestamps; clients cannot patch them. Move atomically updates
the status and moves the item to the end of the array.

For the initial small board, publish complete snapshots after successful
mutations. Subscribe before fetching the initial snapshot and ignore older
board revisions, so a slow initial fetch cannot erase a newer event. Reload
the snapshot on renderer reload; main continues serving harness requests.

Use the existing atomic-write helper under this single-writer service and
validate both primary and backup files on load. Missing files mean an empty
board. If both existing copies are invalid, show a recovery error and refuse
writes until recovery, rather than silently replacing user data. Unknown
future schema versions must also refuse writes.

## Harness access

Recommend a thin `hd-work` CLI for the first release, with JSON output and
nonzero exit codes for errors. Example proposed commands (not available yet):

```sh
hd-work list --status ideas
hd-work create --title "Investigate flaky builds" --description "Reproduce in CI"
hd-work get <id>
hd-work edit <id> --revision 1 --description "Reproduced on Windows"
hd-work move <id> --revision 2 --status in_progress
hd-work move <id> --revision 3 --status done
```

Return the full resulting card, including its new revision, on each success.
Support reading description text from a file to avoid shell quoting problems.
List can filter by workspace; creation without a workspace argument uses the
pane's injected workspace context when present, otherwise Unassigned. Explicit
workspace arguments take precedence. Do not infer workspace identity from cwd:
multiple workspaces and worktrees can refer to related folders.

Proposed transport: an opt-in local HTTP adapter in main, calling the same
service as Electron IPC. Bind only to loopback on an allocated port, require
a random bearer token on every route, reject browser-origin requests, and
bound request sizes. Expose only board operations. No terminal commands or
filesystem operations belong on this adapter. Disabled means no listener.

Keep endpoint discovery and token in a private runtime file for this app
profile, separate from persisted workspace settings. The client rereads it
per invocation so an app restart does not strand running panes with an old
port or token. Remove discovery on clean shutdown; detect stale discovery and
report Deck unavailable. Serialize mutations even when requests disconnect;
do not automatically retry creates after an ambiguous response. The caller
can list/get to reconcile. Add persistent request deduplication if automatic
retry becomes a requirement.

Packaging the client and verifying native/WSL connectivity is the main spike
before implementation. It must work from installed Deck without assuming a
development checkout or a globally installed Node. Prefer a bundled native
client entry point; use an app-generated Windows-client wrapper for WSL if
direct loopback connectivity is unavailable. Verify that approach with the
packaged application before promising WSL support. Do not solve WSL by binding
to every network interface. SSH/container access is deferred.

Keep runtime credentials out of persisted `Pane.env`; inject runtime discovery
and workspace identity at launch instead. Scope a credential to this local
board, and remove it from unrelated remote launches. Enabling access lets a
harness edit the board without a confirmation for each move.

Provide a copyable short instruction in Board settings describing the client,
four statuses, revision handling and explicit completion rule. A CLI on its
own does not tell a harness when to use it. Existing panes can use an explicit
client path/discovery setup; new panes receive launch integration.

An MCP adapter can later expose the same operations if tool discovery proves
more useful than shell commands. It should share the service, not introduce
another store. Exact harness registration and protocol compatibility require
a separate implementation check; this investigation does not assume them.

## Implementation sequence

1. **Prove harness transport.** Exercise a packaged client against a disposable
   main-process endpoint on native Windows/macOS/Linux and Windows-hosted WSL.
   Verify JSON results, app-not-running errors, discovery refresh and packaging.
   Resolve the supported client launch mechanism before building around it.
2. **Service and persistence.** Add `src/shared/work-board.ts` and
   `src/main/work-board.ts`, validation, serialized mutations, revision conflicts,
   atomic persistence and recovery. Add board IPC and preload methods.
3. **Board UI.** Add `components/WorkBoardPage.tsx`, a separate renderer board
   store, sidebar/palette navigation, card editor, Move to and drag between
   columns. Generalize deck-only guards to `ui.page === 'deck'`, including
   keyboard actions, focus/activity, palette commands and voice delivery.
4. **Harness client.** Add the local adapter/client, runtime discovery,
   launch context and user-facing setup instructions. Read/write operations
   remain available while the board page is closed.
5. **Integration verification and documentation.** Document the supported
   environments, local storage location, access toggle and command contract.

No new runtime dependency is inherently needed for the board UI or JSON
service. Decide whether packaging the client warrants one after the spike.

## Acceptance checks

- Human creates an Idea; a harness lists it, edits it, moves it to In progress
  and then Done; the open board reflects every successful change.
- Human can drag or use the keyboard to move a card to Won't do and reopen it.
- Cards and order survive restart; a missing board file initializes cleanly.
- Two writers cannot silently overwrite each other; independent edits succeed.
- Disk failures and corrupt files produce visible errors without losing cards.
- Renderer reload and mutation/fetch races converge on the latest saved board.
- Board navigation retains PTYs and terminal DOM nodes, and hidden terminals
  receive neither board keyboard input nor dictation.
- Wrong tokens and invalid payloads cannot mutate anything; disabled harness
  access has no listener; client errors have actionable JSON messages.
- Packaged native and WSL paths pass real create/read/edit/move round trips;
  unsupported environments are explicitly identified in the release notes.
- Run service/persistence and UI tests, typecheck, the full suite, and Electron
  smoke with disposable board data and a client round trip before release.

The only intentional product assumptions are one board per app profile,
optional workspace links, and explicit status changes. They keep the first
release small while leaving room for assignment and execution later.
