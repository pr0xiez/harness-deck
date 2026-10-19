# Personal agent

## First run

A new agent opens a three-step setup instead of the page: choose a ChatGPT or
Claude subscription (Deck checks the CLI sign-in and shows the login command
when needed; OpenRouter is under **Advanced**), set your rhythm (time zone,
check-in times, weekdays only, **Daily check-ins** and **Nudges**), then
optionally describe your goals. **Finish & plan my day** starts the first
conversation. **Skip setup** is available on every step. Re-run it from
**Agent settings → Run setup again** or the page's **Set up your agent**
banner. Existing agents migrate as already set up, with nudges enabled (they
still require check-ins to be on).

Once set up, a title-bar chip shows the running focus countdown, otherwise
today's next unfinished priority or **Plan your day**, plus a count of Google
proposals awaiting review. Clicking it opens the personal-agent page.

## Subscriptions and providers

Open **Personal agent → Agent settings → Use for replies** and choose
**ChatGPT subscription (Codex)** or **Claude subscription (Claude Code)**.
Install the corresponding CLI and sign in in a Deck terminal pane:
`codex login` for ChatGPT or `claude auth login` for Claude. Choose subscription
sign-in rather than an API key. **Check sign-in** verifies the saved CLI login
without sending a model request; it does not check the subscription's remaining
quota. **Auto detect sign-in** checks the native CLI first, then WSL on Windows,
and prefers an environment with a subscription login. Select **WSL** or
**This system** to use a particular environment. Each has its own CLI login.

Leave **Subscription model** empty to use the CLI's default model, or enter a
model supported by your plan. Replies and scheduled briefings use that plan's
usage allowance. Deck refuses API-key logins in subscription mode, removes
inherited API keys and custom provider routing, and never falls back to API
billing. CLI authentication and token refresh remain with the CLI; Deck does
not read, copy or store its subscription tokens. Use a recent CLI: Codex needs
`--ignore-user-config`, `--ephemeral` and structured outputs; Claude Code needs
`--safe-mode`, `--restricted` and structured outputs.

Switch providers whenever your subscription changes. Conversation, tasks,
memories, plans and Google proposals remain in Deck; relevant context is sent
to the newly selected provider on its next run. New agents default to ChatGPT.
Existing OpenRouter agents keep their provider and model after upgrading.
**OpenRouter credits** remains available: save the key, load the tool-capable
catalog or enter a model ID. This mode spends OpenRouter credits separately
from any subscription. Saved credentials never return to the renderer or enter
workspace snapshots. Save your goals and preferences in either mode.

Use **Plan my day** to consider commitments, work-board cards and connected
Google data. Replies can carry up to three one-click suggestions (add a task,
start a focus block, use a plan). Nothing is saved until you click one;
accepting runs the same validated command as doing it by hand, atomically, and
a suggestion that no longer applies stays open with an error. Dismiss hides it. Plans have at most three priorities. A personal task checkbox adds
it to the plan; the check button reports completion. Work-board completion
updates the real card with its current revision. A focus timer survives a
restart and asks what happened afterward; it never assumes completion.
Delete a task with its remove button; the agent itself has no delete tool.
Completed tasks are pruned 30 days after completion (legacy tasks without a
completion time use their creation time), never while referenced by a saved
plan or the current focus block.

## Google setup

1. In [Google Cloud](https://console.cloud.google.com/), select a project and
   enable the Gmail API and Google Calendar API.
2. Configure the consent screen. If it is in testing, add your Google account
   as a test user. Google may expire refresh tokens for external apps in testing;
   reconnect when required. A distributed public app needs the applicable
   Google consent/verification setup for its requested scopes.
3. Create a **Desktop app** OAuth client in the
   [Clients page](https://console.cloud.google.com/auth/clients). Save its client
   ID and client secret in Deck. A web-application OAuth client will not work
   with the random-port desktop callback.
4. Click **Connect Gmail & Calendar**, choose the account, and grant both
   permissions in your system browser. Return to Deck after sign-in.

The connector follows [Google's installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app)
with S256 PKCE, a random state value, and a listener bound only to `127.0.0.1`
on an ephemeral port. Sign-in times out after three minutes. The listener closes
after sign-in, cancellation or application shutdown. Refresh requests are
deduplicated; tokens never enter prompts or cross IPC. An OS keychain is
required; Linux's `basic_text` backend is refused.

The requested scopes are `gmail.modify` and `calendar.events`. Reads cover
Gmail search and plain-text message bodies, plus primary-calendar events. Inbox
snapshots show at most 20 recent inbox messages; calendar snapshots cover seven
days, up to 100 events. Agent searches disclose truncation and can query other
ranges of at most 31 days. Snapshots refresh every 15 minutes while connected,
on chat and on explicit refresh. Failed refreshes retain the previous snapshot
with its timestamp and connection error.

Gmail changes include drafts, sending/replies, archive and mark-read; permanent
message deletion is unavailable. Calendar changes include creating, updating
and deleting individual ordinary events on the primary calendar. Recurring
series, special events, calendar-list management and attendee editing remain
in Google Calendar. Approved updates/deletions notify existing guests, shown
in the proposal. Reviewed calendar revisions use `If-Match` so changes made
elsewhere are not silently overwritten.

Every remote write requires approval on an exact proposal bound to the account
that prepared it. The main process saves `running` before the request and
`done` after success. Network failures or restarts leave an `uncertain` proposal,
which is never automatically retried. Open Google and check it, then select
**I verified it was applied** or **I verified it wasn’t applied**. Ask for a new
proposal if needed. Disconnect clears cached data, forgets local tokens and
attempts bounded token revocation; saved conversations/proposals remain local.
At most 20 proposals may be open (pending, running or uncertain); approve,
dismiss or verify one before the agent can prepare another.

If Google rejects the refresh token (`invalid_grant`, common weekly for consent
screens in testing), Deck forgets the local token, marks Google disconnected,
keeps the account for existing proposals, shows a reconnect message and sends
one desktop notification. A 401 forces one token refresh: reads retry once,
writes are never resent.

## Proactivity

Enable check-ins after signing into your subscription CLI, or choosing an
OpenRouter model and key. Configure three ordered
times and a time zone, optionally weekdays only. Morning briefings help choose
a plan, midday check-ins ask about real progress, and evening reviews help
close the day. Each scheduled slot is recorded before inference, so a failed
request is not retried every tick or on restart. Use chat to retry manually.
There are at most three scheduled briefings per local day. Each inference is
bounded to six model requests and eight tool calls per request.

Check-ins catch up within 90 minutes of the latest slot; older slots do not
burst after a restart. A focus block defers scheduled check-ins. Snooze pauses
check-ins and focus notifications for one hour. Focus reminders wait until the
configured active day (morning until 90 minutes after the evening slot) and
fire once per block. Disable desktop notifications without disabling the
in-app conversation. Background briefings can read Google data and set the
daily plan only when none exists for today; they never overwrite a plan (they
offer a plan suggestion instead), and cannot complete tasks, save memories or
prepare remote writes. A failed
scheduled check-in still consumes its slot, adds a short conversation message
and sends one notification (when enabled and not snoozed).

**Nudges** are short local messages with no model call, sent only while
check-ins and nudges are on, not snoozed, on configured days and inside the
active day: a meeting starting within 10 minutes (Google connected; timed
events only), Deck agents waiting for your input for 15+ minutes, and, from two
hours after the check-in slot until the evening slot, personal tasks due today
or overdue (with a **Start 25-min focus** suggestion). At most one nudge per
30-second tick, 10 minutes apart and 8 per local day, each deduplicated per
event, waiting episode or day. Only meeting nudges interrupt a focus block or a
conversation from the last 10 minutes.

Deck signals come from the renderer: waiting agent panes (label, workspace,
waiting-since) and GitHub pull requests needing attention, reported debounced
with a 60-second heartbeat. They are status only, never terminal output or
transcripts, kept in main-process memory (never persisted), validated and
bounded, ignored for waiting agents when older than three minutes, and treated
as untrusted context. Chat context also lists in-progress board cards untouched
for three days. Morning briefings lead with what is blocked on you.

Desktop notifications carry buttons on Windows and macOS: check-ins and nudges
offer their first open suggestion and **Snooze 1h**; a finished focus block on
a personal task offers **Mark done** (your explicit click) and **Snooze 1h**.
Buttons run the same commands as the page at the current revision.

The scheduler runs in Electron's main process, survives renderer reloads, and
works with a minimized window. It stops when Deck quits. On macOS, the app
continues while its window is closed, consistent with the existing app behavior.
Notification clicks return to the personal-agent page. There is no system
service, startup registration or hosted scheduler.

## Storage and implementation

`personal-agent.json` in the user-data directory holds tasks, explicit memories,
daily plans, focus state, conversation and proposal history independently of
`workspaces.json` and `work-board.json`. Atomic replacement and `.bak` recovery
preserve the last valid data. The store tracks in memory whether the primary
file is known valid (loaded or last written by Deck) and only then copies it to
`.bak`; do not hand-edit `personal-agent.json` while Deck runs. Invalid or newer-version data blocks editing.
The in-memory revision advances only after a successful write; stale IPC edits
are rejected. The UI preserves task drafts when an agent edits the same task.

History retains 300 conversation messages, 60 daily plans, 200 check-in stamps
and up to 200 Google proposals (resolved history is pruned first). Limits are
1000 personal tasks and 100 explicit memories; reaching a limit reports an
error. The last 24 conversation messages and bounded task/card/action context
are provided to the model. Google credentials use OS-encrypted
`personal-google-key.json`; OpenRouter reuses `agent-openrouter-key.json` or the
exported `OPENROUTER_API_KEY`. Local task/chat files are private local JSON,
not encrypted. Do not put credentials into goals or conversation text.

`src/shared/personal-agent.ts` owns IPC data and the time-zone-aware schedule.
`personal-store.ts` owns persistence; `personal-secrets.ts` owns encrypted Google
credentials; `personal-google.ts` owns OAuth and the allowlisted Google APIs;
`agent-loop.ts` owns the bounded tool loop both providers share — history
bounds, the tool allowlist and object-args checks, the per-step call cap,
error folding, output truncation and the final tool-less step — so the
agent's safety envelope is defined once;
`personal-ai.ts` implements [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
as a transport for that loop;
`personal-subscription.ts` implements a structured-response transport
through [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude Code print mode](https://code.claude.com/docs/en/cli-reference).
`personal-cli.ts` handles native/WSL discovery, stdin prompts, environment
isolation, output/time limits and process termination. Subscription runs use
temporary working folders, fresh ephemeral CLI sessions, disabled customizations,
and disabled built-in execution, browser and MCP tools. Codex additionally uses
a read-only sandbox and never grants approvals. The CLI returns structured Deck
tool requests; only the main-process allowlisted executor performs them. Temporary
schemas and WSL process-control files are removed afterward; private prompts
travel on stdin instead of command arguments. CLI diagnostic output never
crosses IPC. Runs are limited to six CLI invocations and eight tool requests per
invocation; each inference invocation times out after two minutes. No automatic
provider retry is performed. CLI output parsing tolerates shell startup noise
around the JSON (WSL uses `bash -lic`). A signed-in CLI resolution is cached
for five minutes; a failed or unparseable run clears it, and **Check sign-in**
always bypasses it.
`personal-agent.ts` owns planning, proposals, suggestions, Deck signals,
nudges and scheduling. The renderer page uses only the typed preload bridge.
`src/renderer/src/personal.ts` shares one snapshot subscription between the
page and the title-bar chip; `personalSignals.ts` computes and reports Deck
signals; `PersonalSetup.tsx` and `PersonalStatusChip.tsx` hold the first-run
setup and chip. Email, calendar, imported card content and
Deck signals are treated as untrusted context. This agent has no shell, arbitrary HTTP,
terminal transcript or credential-reading tool.

Validation: `npm run typecheck`, `npm test`, `npm run build`, and the native
Electron smoke test. The smoke test uses an isolated profile and no model or
Google calls; mocked integration tests cover OAuth callbacks, PKCE, refresh,
approved writes, recovery and time zones.
