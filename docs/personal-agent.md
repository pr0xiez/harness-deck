# Personal agent

Open **Personal agent → Agent settings**. Save an OpenRouter key (shared with
the existing agent-provider settings), load the tool-capable model catalog or
enter a model ID, and save your goals and preferences. Saved credentials never
return to the renderer or enter workspace snapshots. Agent replies and scheduled briefings
spend OpenRouter credits.

Use **Plan my day** to consider commitments, work-board cards and connected
Google data. Plans have at most three priorities. A personal task checkbox adds
it to the plan; the check button reports completion. Work-board completion
updates the real card with its current revision. A focus timer survives a
restart and asks what happened afterward; it never assumes completion.

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

## Proactivity

Enable check-ins only after choosing a model and key. Configure three ordered
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
in-app conversation. Background briefings can read Google data and change the
daily plan; they cannot complete tasks, save memories or prepare remote writes.

The scheduler runs in Electron's main process, survives renderer reloads, and
works with a minimized window. It stops when Deck quits. On macOS, the app
continues while its window is closed, consistent with the existing app behavior.
Notification clicks return to the personal-agent page. There is no system
service, startup registration or hosted scheduler.

## Storage and implementation

`personal-agent.json` in the user-data directory holds tasks, explicit memories,
daily plans, focus state, conversation and proposal history independently of
`workspaces.json` and `work-board.json`. Atomic replacement and `.bak` recovery
preserve the last valid data. Invalid or newer-version data blocks editing.
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
`personal-ai.ts` implements [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling);
`personal-agent.ts` owns planning, proposals and scheduling. The renderer page
uses only the typed preload bridge. Email, calendar and imported card content
are treated as untrusted context. This agent has no shell, arbitrary HTTP,
terminal transcript or credential-reading tool.

Validation: `npm run typecheck`, `npm test`, `npm run build`, and the native
Electron smoke test. The smoke test uses an isolated profile and no model or
Google calls; mocked integration tests cover OAuth callbacks, PKCE, refresh,
approved writes, recovery and time zones.
