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

**Status at a glance** — Per-pane running/exited dots, an activity dot when a
background pane produces output, and the process title the agent reports (so a
pane says what Claude is doing, not just "claude").

**Survives restarts** — Workspaces, panes, folders and layout are saved to
`workspaces.json` in the app's user-data folder. Reloading the window
re-attaches to the running processes and repaints the last ~512 KB of output.

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

## Releases

`.github/workflows/build.yml` builds the installers on **self-hosted runners** —
one Windows, one macOS, since each platform's installer can only be built on
that platform. Register both machines as runners on the repository; GitHub
labels them with their OS automatically, which is how each job finds its box.

Pushes to `main` and manual runs leave the installers as workflow artifacts.
Pushing a `v*` tag instead publishes them to a draft GitHub release, along with
the `latest*.yml` metadata an auto-updater reads. The tag has to match the
version in `package.json` — the workflow fails early if it doesn't, because the
release is named from `package.json` and not from the tag.

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
  preload/       contextBridge API (the renderer never touches Node)
  renderer/      React UI
    store.ts       zustand state + debounced persistence
    terminals.ts   registry of live xterm instances
    components/    title bar, sidebar, toolbar, panes, palette, dialogs
  shared/        types shared across the process boundary
```

Processes live in the main process and are addressed by pane id, so a window
reload — or React remounting a pane — never kills a running agent.

## Debugging aids

```bash
# what the app can actually find, as JSON
npx electron . --dump-profiles

# render the window to a PNG (optionally after pressing a chord)
npx electron . --capture=shot.png --capture-delay=8000 \
  --capture-keys=ctrl+shift+p --capture-quit
```

If an agent you have installed doesn't appear, run `--dump-profiles`: the
`detail` field shows the path it resolved or the reason it failed.

Set `HD_DEFAULT_CWD` to choose the folder new workspaces start in (defaults to
your home directory; changeable in Settings too).

## Licence

MIT
