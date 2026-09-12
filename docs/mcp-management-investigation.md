# MCPs management page investigation

## Implementation status — 2026-09-07

The first management release is implemented. The investigation below is retained
as design context; its proposal-only statements describe the earlier investigation.

- Sidebar, Settings and command-palette navigation open an MCPs page with source
  details, harness/environment/project selection, partial errors and refresh.
- Native Codex user/project definitions and Claude user/local/project definitions
  support add, edit and remove. Codex standard tables also support enable/disable.
  Existing field values remain hidden; omitted edit fields retain their values.
  Environment/header edits merge named keys. Rename and transport changes require
  adding a new definition. Authentication and Claude toggles remain in the harness.
- TOML AST spans and JSON property edits preserve unrelated values and formatting.
  Native saves use discovered source IDs, revision checks, private backup files,
  a sibling temporary file and atomic replacement. Symlinked sources are read-only.
- Default WSL inventory uses a fixed bash/Python reader with arguments passed
  separately; WSL mutations and ancestor discovery are not supported. A missing
  runtime produces an explicit error. OpenCode, plugin/account/managed definitions,
  custom `CLAUDE_CONFIG_DIR`, launcher overrides and live session status remain
  outside this release. Native `CODEX_HOME` is respected.
- Terminal mounts survive navigation. Hidden-workspace keyboard actions and
  dictation delivery are suppressed; choosing a workspace returns to the deck.

Validation includes temporary-file preservation/redaction/conflict tests, renderer
edit/failure/navigation tests and an opt-in installed-CLI compatibility suite:
`HARNESS_DECK_MCP_CLI_TEST=1 npx vitest run src/main/mcp.integration.test.ts`.
Codex 0.153.4 read the generated user definition and disabled state; Claude Code
2.1.261 recognized generated user, local and project definitions using disposable
homes. These tests do not connect MCP servers. Runtime WSL discovery still needs
verification on supported Windows/WSL installations.

The Electron smoke suite now exercises MCP IPC, a disposable config write and
navigation with retained terminal DOM nodes, and saves `.tmp/mcp-page.png`.
Smoke mode forces MCP discovery to its disposable user home.

Final verification: production build passed; all 20 MCP unit/renderer/navigation
checks and four installed-CLI checks passed. The Windows Electron smoke run exited
successfully with 23/23 checks and no renderer errors; its report is
`.tmp/mcp-smoke-final.json`. Main typechecking passes, and renderer typechecking
passes when the existing `src/renderer/src/store.test.ts` is excluded. That legacy
file still refers to the removed attention `notify` setting and expects a desktop
notification. The full suite also encountered inherited WSL/PATH/shell-bookkeeping
assumptions; those process, PTY and shell tests passed when rerun with a clean
child-process environment. No production notification behavior was changed here.

---

Investigated 2026-09-05; repository findings and linked MCP documentation rechecked 2026-09-06. Proposal only; no application behavior or user MCP configuration changed.

Recommend a dedicated **MCPs** destination in the sidebar, with a command-palette entry and a link from Settings. Its first release should manage servers configured for supported harnesses, with explicit harness, environment and project context. A marketplace can follow separately.

## Repository findings

- `src/main/profiles.ts` detects harness executables, including native and WSL profiles. `Profile.available` means the executable was found; it says nothing about MCP servers.
- There are no MCP discovery, configuration, status or mutation APIs in `src/shared/ipc.ts`, `src/preload/index.ts` or `src/main/index.ts`. MCP mentions in session parsing are launch-argument handling only.
- `src/renderer/src/components/SettingsDialog.tsx` is a single settings modal. Server lists and editors warrant their own view.
- `src/renderer/src/App.tsx` keeps visited workspace pane areas mounted. Opening MCPs must preserve those mounts and running terminals; hide the deck while showing the page, and suppress terminal-targeted keyboard actions while it is active.
- `src/main/opencode.ts` provides a useful bounded CLI-query pattern with native/WSL runners. Its cache currently uses profile ID alone; MCP queries must also distinguish project directory, environment and configuration identity. Its WSL argument joining is for fixed commands and must not be copied for user-supplied server values.
- Saved launchers can override command, arguments, folder and environment. A profile name alone cannot establish the effective configuration of every pane.

## Proposed page

At the top: **MCPs**, a short explanation, **Refresh** and **Add server**. Filters select harness, environment and workspace/project folder. Allow use without any open workspace for user-scope management.

Each row shows server name, harness, environment, scope, transport and configuration state. Selecting a row opens details with its source file, command/URL, environment-variable names, supported actions and any override or policy explanation. Mask credentials, including credentials embedded in URLs and arguments.

Expose **Edit**, **Remove**, and **Enable/Disable** only where the adapter supports the selected source and version. Add/edit uses separate command and argument inputs for stdio, or a URL for HTTP, plus environment/header fields and an explicit destination scope. Saving must make clear whether it affects this project or all projects for that harness. Shared project configuration should prefer credential references.

Keep configuration state separate from runtime status. A parsed entry is “Configured”; an enabled entry is not evidence of a live connection. Show “Not checked” until a supported explicit check returns a timestamped result. Opening the page should not start MCP commands, install packages or initiate authentication. Authentication should use the harness's supported flow in a visible pane where possible.

Include loading, no servers, unavailable harness, unsupported version, unreadable config and partial discovery states. One broken source must not hide other results. Show inherited and overridden definitions with their origin instead of silently merging identically named servers.

## Verified compatibility constraints

| Harness | Documented configuration | Implication |
| --- | --- | --- |
| Codex | User `~/.codex/config.toml`, trusted project `.codex/config.toml`; `[mcp_servers.<name>]` and `enabled`. Plugins can supply servers with separate controls. | Preserve TOML and source ownership; plugin entries require different handling. |
| Claude Code | User and project-local entries in `~/.claude.json`; shared project entries in `.mcp.json`. Project approval, precedence and managed configuration affect availability. | Keep user, local and project scopes distinct; configuration alone cannot establish permission to use a server. |
| OpenCode, current unversioned docs | `mcp.<name>`, local/remote entries, `enabled`. | Requires a matching adapter. |
| OpenCode V2 docs | `mcp.servers.<name>`, `disabled`; no V2 `enabled` field. | Detect installed version/schema before writing; do not guess from the executable name. |

Sources: [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp), [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/), [OpenCode V2 MCP documentation](https://opencode.ai/v2/docs/mcp-servers).

These sources establish a need for harness-specific adapters; they do not establish which versions are installed on an end user's machine. Other detected harnesses need their own compatibility investigation before advertising management support.

## Implementation shape

1. Add shared MCP target, entry, capability and structured-result types. Identity includes harness, environment, scope, source and server name. Distinguish unknown effective availability from disabled state.
2. Add main-process discovery and per-harness adapters. Resolve configuration using the selected runtime's home, working directory and relevant environment overrides. Return redacted data through typed IPC. Restrict mutations to validated discovered targets rather than accepting arbitrary renderer file paths.
3. Implement configuration edits with format-preserving TOML/JSONC handling, unknown-field preservation, backups, atomic replacement and conflict detection against the read revision. Re-read after writes. Prefer supported CLI mutation commands where they provide the required scope and preservation guarantees. Keep MCP definitions and tokens out of `workspaces.json`.
4. Add `McpPage.tsx` and its editor, sidebar/palette navigation and transient view state. Keep workspace selection intact while browsing the page. Show the affected target and whether an existing pane needs a restart or harness-specific reload; never automatically restart running work.

Recommended delivery order: inventory and source details first; add/edit/remove/toggle for verified Codex and Claude versions next; then OpenCode with explicit version support. WSL discovery must remain isolated from native configuration. Until WSL mutation is verified, label it read-only. Remote SSH/container and arbitrary shell launchers should be explicitly unsupported initially.

## Concrete first implementation

The current application has no server registry to expose: `src/shared/agent-session.ts` only recognizes MCP-related command-line tokens. This is a main-process integration feature as well as a new renderer page.

| Work item | Proposed files | Reviewable result |
| --- | --- | --- |
| Target and inventory contract | `src/shared/types.ts`, `src/shared/ipc.ts`, `src/preload/index.ts` | Typed target selection and inventory responses with per-source errors; no raw credential values. |
| Discovery | New `src/main/mcp.ts` and harness adapter modules, `src/main/index.ts` | Bounded discovery for explicitly supported configurations, with source identity and revision; opening the inventory does not connect servers. |
| Navigation and inventory | New `src/renderer/src/components/McpPage.tsx`, `src/renderer/src/store.ts`, `App.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `SettingsDialog.tsx`, `styles.css` | A usable MCPs destination with harness/environment/project selection, refresh, rows and source details. |
| Configuration management | Adapter mutations and a new server editor | Add, edit, remove and toggle where supported, with preserved formatting and conflict handling. Deliver after inventory is validated. |

Use transient `ui.page: 'deck' | 'mcps'` state, defaulting to `deck`. Selecting a workspace returns to the deck. Preserve the existing `activeWorkspaceId` and mounted `PaneArea` instances; pass `visible={false}` while MCPs is open. Review both global shortcuts and terminal focus effects so hidden terminals do not receive input while the user edits a server. Returning to the deck restores the selected workspace and pane.

For the inventory milestone, show Refresh and source details; introduce Add server together with working mutation support. Empty inventory, unsupported configuration and failed discovery must have distinct messages. A details panel should identify the exact scope and source before any editor is offered.

Treat live connection reporting as a separate capability. A standalone check establishes that a server was reachable in the checked context at a particular time; it does not establish that an existing harness session is connected. Reserve “Connected” for session-specific evidence from a supported harness interface. Until that interface is verified, the page can accurately manage configured servers and explain that running sessions may need a reload.

The integration work is likely to dominate the UI work: configuration precedence, credential-preserving edits and native/WSL targeting each require adapter validation. The next engineering step is a disposable Codex/Claude adapter spike that verifies discovery output, scope selection, round-trip edits and reload behavior before committing to a delivery estimate.

## Acceptance checks and remaining questions

- Exercise conflicting scopes, malformed files, missing sources, unknown fields, format preservation and external edits between read and save.
- Verify native and WSL entries with the same name stay separate, credential values do not leak through list/error payloads, and user arguments survive process invocation without shell evaluation.
- Verify refresh and partial failures, mutation failures without optimistic success, and navigation without losing terminal mounts or directing shortcuts into hidden panes.
- A disposable harness integration check must establish that a saved change is actually loaded in the selected scope. Then run repository typecheck, tests and Electron smoke checks for the implementation.

Before implementation, probe supported CLI versions and machine-readable discovery/mutation interfaces; establish policy/plugin precedence and configuration overrides for each adapter; select format-preserving parsers; and verify reload semantics. These details remain untested. This investigation used repository inspection and official documentation; no installed harnesses or personal configuration were probed and no runtime tests were run.
