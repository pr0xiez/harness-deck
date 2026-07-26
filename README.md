# Harness Deck

A desktop workspace for running coding-agent CLIs side by side.

Each **workspace** is a named set of terminals — one per project, experiment or
comparison. Open Claude Code in one pane, Codex in the next, a shell and a log
tail below them, then switch to another workspace while everything keeps
running in the background.

Built with Electron, React and xterm.js; real PTYs via `node-pty`.

![four panes in a grid: Claude Code, a WSL shell, PowerShell and a command pane](docs/screenshot.png)

## What it does

**Workspaces** — Create as many as you like. Each has its own folder, accent
colour, layout and set of panes. `Ctrl+1…9` jumps between them; processes in
the ones you're not looking at keep running.

**Harness detection** — On startup the app scans your *login shell's* `PATH`
(not the stripped-down environment a GUI app normally inherits) for `claude`,
`codex`, `copilot`, `gemini`, `opencode`, `aider` and `cursor-agent`. On
Windows it also looks inside WSL and offers those as separate profiles, so
agents installed in your Linux home are one click away. Anything it can't find
is still listed with the command to install it.

**Layouts** — An even grid (1–4 columns) or tabs, per workspace. Any pane can
be zoomed to full size with `Ctrl+Shift+Z` and restored again; the process is
resized properly, so TUIs reflow instead of corrupting.

**Broadcast** — Type one prompt and send it to every agent pane in the
workspace at once (`Ctrl+Shift+B`). Useful for handing the same task to two
models and comparing.

**Dictation** — `Ctrl+Shift+M` records you and types the transcript into the
focused agent's prompt line, or into the broadcast box when that has focus. It
stops on its own when you stop talking. Transcription runs through OpenRouter,
OpenAI, Groq or a local Whisper server. See [Dictation](#dictation).

**Status at a glance** — Per-pane running/exited dots, an activity dot when a
background pane produces output, and the process title the agent reports (so a
pane says what Claude is doing, not just "claude").

**Survives restarts** — Workspaces, panes, folders and layout are saved to
`workspaces.json` in the app's user-data folder. Reloading the window
re-attaches to the running processes and repaints the last ~512 KB of output.

**In-place updates** — `npm run release` builds a new installer and the running
app offers it in a toast; one click restarts into the new version. See
[Releasing and updating](#releasing-and-updating).

## Requirements

- Node.js 20+ and npm (for development)
- Windows, macOS or Linux
- At least one agent CLI on your `PATH` — or WSL with one installed

## Getting started

```bash
npm install
npm run dev      # live-reloading development build
```

Other scripts:

```bash
npm run build     # bundle main, preload and renderer into out/
npm start         # run the bundled app
npm run typecheck # tsc over both projects
npm run package   # build installers into release/ (electron-builder)
npm run release   # bump the version, package, and notify a running copy
```

### Linux

Electron needs a handful of system libraries that a minimal distro (including
a fresh WSL image) doesn't ship:

```bash
sudo apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libgbm1 libgtk-3-0 libasound2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2
```

### Windows + WSL

Run the app on Windows and it will find agents in both places. WSL panes are
launched as `wsl.exe -e bash -lic '…'` and the pane's folder is handed over as
a translated Unix path (`D:\Code\app` becomes `/mnt/d/Code/app`) using
`WSLENV`, so the agent starts in the right directory.

### macOS

The window keeps its traffic lights and gains a small menu bar — macOS routes
`Cmd+Q`, `Cmd+W` and the text-field clipboard through it, so an app without one
can't quit or paste. Closing the window leaves the agents running and the app
in the dock; reopening re-attaches every pane. Homebrew's `bin` directories are
added to `PATH` on top of the login-shell environment, since a Finder-launched
app never inherits them and that is where most agent CLIs live.

Packaging must happen **on a Mac**: `@lydell/node-pty`'s prebuilt binaries are
per-platform optional dependencies, so an `npm install` run on Windows or Linux
never fetches the Darwin one and the packaged app would have no pty.

```bash
npm run package   # dmg + zip for arm64 and x64 into release/
```

Unsigned builds are fine locally — set `CSC_IDENTITY_AUTO_DISCOVERY=false` — but
Gatekeeper quarantines a DMG that has been downloaded, so a build meant for
anyone else needs an Apple Developer ID and notarisation. The hardened-runtime
entitlements it needs are already in `build/entitlements.mac.plist`. Drop a
1024px `build/icon.icns` in to replace the stock Electron icon.

## Dictation

`Ctrl+Shift+M` (or the **Dictate** button) opens the microphone, and the
transcript is typed into whatever prompt had focus — the focused pane's agent,
or the broadcast box if you were in it. A pill at the bottom of the window shows
the input level while it listens; `Esc` throws the recording away, and the
shortcut again stops it early. With **stop when I stop talking** on (the
default) it ends after about 1.7 seconds of silence, measured against the room's
own noise rather than a fixed level.

The text is typed but *not* sent, so you can edit it before pressing Enter —
turn on **press Enter after dictating** if you would rather it go straight out.
Newlines are collapsed to spaces so a transcript can never submit half a prompt
to a TUI. If the pane closed while you were talking, the transcript goes to the
clipboard instead of nowhere.

A recording that never rose above the room for at least 150 ms is dropped
without being sent anywhere. That saves a pointless request, but the real reason
is that a chat model asked to transcribe silence does not answer "silence" — it
invents a plausible coding prompt, and that text would land in your agent.

### Setting it up

Transcription is done by a service you choose in **Settings › Voice input**:

| Service | Default model | Notes |
| --- | --- | --- |
| OpenRouter *(default)* | `google/gemini-2.5-flash-lite` | Spends OpenRouter credits, ~$0.0001 a prompt |
| OpenAI | `gpt-4o-mini-transcribe` | Also `gpt-4o-transcribe`, `whisper-1` |
| Groq | `whisper-large-v3-turbo` | Usually the fastest turnaround |
| Custom | `whisper-1` | Any OpenAI-compatible `/audio/transcriptions` |

Pick **Custom** and point the endpoint at something like
`http://127.0.0.1:8000/v1` to use a local Whisper server, which needs no key at
all.

OpenRouter is the odd one out: it has no transcription endpoint, so audio goes
to a multimodal chat model as a base64 message part, and those models want WAV
rather than the Opus everything else takes. The recording is decoded and
re-rendered to 16 kHz mono in the renderer before it is sent, and the model is
instructed to return the words and nothing else — the reply is stripped of the
quotes and "Transcription:" labels a chat model likes to add. Any OpenRouter
model that accepts audio input can be named in the model field.

Keys can be pasted into Settings — they are encrypted with the OS keychain
(`safeStorage`) and stored per service in `voice-keys.json` beside the layout
file, never in `workspaces.json`. If you already export `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, `GROQ_API_KEY` or `HD_VOICE_API_KEY` in the environment the app
was started from, it picks that up and nothing needs saving. Audio is posted
straight to the service and is not written to disk; the **vocabulary hint** field
is worth filling in with the project nouns your model keeps mangling.

Windows only asks for the microphone once, at the OS level: if capture is
blocked, the pill offers a shortcut to the privacy page. macOS prompts on first
use.

## Keyboard

Terminals get every plain key combination, so the app keeps to `Ctrl+Shift`
and `Alt`. On macOS use `Cmd` in place of `Ctrl` — plus `Cmd+C` / `Cmd+V` on a
pane, and `Cmd+Alt+I` for developer tools.

| Keys | Action |
| --- | --- |
| `Ctrl+1` … `Ctrl+9` | Switch workspace |
| `Ctrl+Shift+N` | New workspace |
| `Ctrl+Page Up/Down` | Previous / next workspace |
| `Ctrl+Shift+T` | New pane (harness picker) |
| `Ctrl+Shift+W` | Close focused pane |
| `Ctrl+Shift+R` | Restart the process in the focused pane |
| `Ctrl+Shift+Z` | Zoom / restore the focused pane |
| `Alt+1` … `Alt+9` | Focus pane by position |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous pane |
| `Ctrl+Shift+←/→` | Move the focused pane in the layout |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+Shift+F` | Find in pane |
| `Ctrl+Shift+K` | Clear pane |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Font size |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+M` | Dictate into the focused prompt (`Esc` discards) |
| `Ctrl+Shift+B` | Broadcast bar |
| `Ctrl+Shift+,` | Settings |
| `Ctrl+Shift+/` | Shortcut help |
| `F12` | DevTools |

## How it fits together

```
src/
  main/          Electron main process
    index.ts       window, IPC, smoke-test flags
    pty.ts         PTY sessions: spawn, batched output, replay buffer, resize
    profiles.ts    harness detection (PATH scan + WSL probe)
    shell-env.ts   login-shell environment resolution
    store.ts       atomic JSON persistence
    updater.ts     watches the release channel, runs the installer
    voice.ts       transcription requests + API key storage
  preload/       contextBridge API (the renderer never touches Node)
  renderer/      React UI
    store.ts       zustand state + debounced persistence
    terminals.ts   registry of live xterm instances
    voice.ts       microphone capture, level metering, transcript delivery
    components/    title bar, sidebar, toolbar, panes, palette, dialogs
  shared/        types shared across the process boundary
scripts/
  release.mjs    cuts a release and publishes its manifest
```

Processes live in the main process and are addressed by pane id, so a window
reload — or React remounting a pane — never kills a running agent.

## Releasing and updating

Updates come from a release channel on this machine, not a server — the app is
built and run on the same box, so there is nothing to host and no token to
store.

```bash
npm run release            # 0.1.0 → 0.1.1, package, publish the manifest
npm run release minor      # or major, or an explicit 1.2.3
npm run release -- --notes "Adds pane search"
npm run release -- --no-build   # reuse the installer already in release/
npm run release -- --dry-run    # show the manifest, change nothing
```

The script bumps `package.json`, runs `npm run package`, then writes a manifest
to `%APPDATA%\Harness Deck\update.json` naming the new version and the installer
that goes with it. Notes default to the last commit subject. If the build fails
the version bump is rolled back.

A running Harness Deck watches that file (`fs.watch`, plus a 15-minute poll as a
backstop) and raises a toast bottom-right within about a second: **Restart &
install** hands the release to its NSIS installer with `/S --force-run`, which
replaces the app in place and reopens it. Dismissing the toast leaves an
**Update** pill in the title bar; Settings → Updates has a manual check and the
channel path, and the command palette carries both actions.

Panes are killed by the restart, so an install with live processes asks first —
the same prompt as closing the window, and it obeys the same setting.

A release whose installer is missing or still being written is reported as an
error rather than offered, and the installer's sha512 is verified before it is
launched. Nothing prunes `release/`, so each release leaves its own installer
and zip behind (~240 MB a time) — clear out old versions when it gets heavy.

The build has to run with the Windows toolchain (see the environment notes in
the parent `CLAUDE.md`); on WSL the script locates the Windows npm itself, or
set `WIN_NPM`. `HD_UPDATE_MANIFEST` points the app at a different manifest, and
`HD_USER_DATA` does the same for the script.

### Building both platforms in CI

`npm run release` covers the local Windows loop. `.github/workflows/build.yml`
is the other half: it builds installers for **both** platforms. Each platform's
installer can only be built on that platform — `node-pty` ships a prebuilt
binary per platform, and npm only ever fetches the host's, so a cross-built app
has no working pty, and NSIS needs Wine off Windows. There is no way around the
matrix.

Where each half runs differs:

- **macOS** — a **self-hosted** Mac, which is free and the only machine that
  could ever sign and notarise. Register it as a runner on the repository;
  GitHub labels every self-hosted runner with its OS automatically, and the
  matrix matches `[self-hosted, macOS]` to route the job there. If the Mac is
  offline the job queues rather than fails.
- **Windows** — the GitHub-hosted `windows-latest` image. This one is billed:
  the repo is private and Windows minutes count double against the included
  allowance. Point it at a `[self-hosted, Windows]` pair instead if a Windows
  box ever gets registered.

Because the Mac is Apple Silicon, npm never fetches the Intel `node-pty`
prebuild that the x64 dmg needs, so the workflow installs it by hand. That needs
`--force` as well as `--os`/`--cpu`: the platform flags only steer optional
dependency resolution, and a package named explicitly is still checked against
the real host.

Pushes to `main` and manual runs leave the installers as workflow artifacts.
Pushing a `v*` tag publishes them to a **draft** GitHub release instead; the tag
has to match the version in `package.json`, which the workflow checks before
building, because the release is named from `package.json` and not the tag.

Pull requests run the same build on both platforms but keep nothing — artifact
storage counts against the account quota — so a PR proves the installers can be
built and then discards them. There are no tests in this repo —
`npm run typecheck` and a successful package are the whole gate, and neither
says anything about whether the app actually runs.

This is a distribution channel, not a second update channel — the in-app updater
above reads the local `update.json` and knows nothing about GitHub releases.
Wiring the toast to published releases would mean teaching `updater.ts` to fetch
the `latest*.yml` that electron-builder uploads alongside the installers.

The mac runner builds unsigned (`CSC_IDENTITY_AUTO_DISCOVERY: false`) so it
can't pick up a stray keychain identity. Add `CSC_LINK` and `CSC_KEY_PASSWORD`
secrets and drop that line to sign for real.

## Debugging aids

```bash
# what the app can actually find, as JSON
npx electron . --dump-profiles

# render the window to a PNG (optionally after pressing chords, in order)
npx electron . --capture=shot.png --capture-delay=8000 \
  --capture-keys=ctrl+shift+p --capture-quit

# record from the mic and transcribe it, as JSON: device, bytes, peak level
npx electron . --voice-check=3000

# ...against a local endpoint instead of the configured one
npx electron . --voice-check=3000 --voice-endpoint=http://127.0.0.1:8787/v1 \
  --voice-model=whisper-1
```

If an agent you have installed doesn't appear, run `--dump-profiles`: the
`detail` field shows the path it resolved or the reason it failed.

`--voice-check` is the quickest way to tell a microphone problem from a
transcription one: it reports the device it opened, how many bytes it captured,
the levels it heard, whether the silence gate would have let it through, and
what the service answered. A `peakLevel` near the `noiseFloor` means the OS
handed over a silent stream — wrong input device, or muted. Note that the check
sends the audio even when the gate says it would skip, so a hallucinated
transcript there is expected rather than alarming.

To exercise dictation with known speech and no microphone, feed Chromium a file
(16-bit PCM, 16 kHz or 48 kHz) in place of the input device:

```bash
npx electron . --voice-check=5000 --use-fake-device-for-media-stream \
  --use-file-for-fake-audio-capture=C:/tmp/speech.wav
```

Two copies of the app share one user-data folder, so a second instance will
overwrite the first one's layout. Pass `--user-data-dir=<path>` to run a
throwaway profile when testing.

Set `HD_DEFAULT_CWD` to choose the folder new workspaces start in (defaults to
your home directory; changeable in Settings too).

## Licence

MIT
