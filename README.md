# Harness Deck

**All your coding agents. One window.**

A desktop workspace for running agent CLIs side by side: Claude Code, Codex, Copilot, OpenCode. Real terminals that keep working when you look away.

![Harness Deck](docs/screenshot.png)

## what it does

- **workspaces**: named sets of terminals; `Ctrl+1…9` to switch, background panes keep running
- **broadcast**: one prompt to every agent at once, then compare
- **attention**: knows which agent is working and which is waiting on you, plus your GitHub PRs
- **resume**: every pane reattaches to its own conversation after a restart
- **work board**: a kanban your agents can drive through the bundled `hd-work` CLI
- **personal agent**: daily plan, focus timer, Gmail + Calendar, runs on the Claude or ChatGPT plan you already pay for
- **also**: dictation, MCP manager, OpenRouter routing, WSL-aware agent detection, in-place updates

## run

```sh
npm install
npm run dev
```

Node 24 and at least one agent CLI on your `PATH`. Windows, macOS or Linux.

`npm test` · `npm run typecheck` · `npm run smoke` · `npm run package`

## stack

Electron · React 19 · xterm.js · node-pty · Zustand · TypeScript · Vitest · electron-builder

## read next

- [docs/manual.md](docs/manual.md): every feature, shortcut and setting
- [docs/architecture.html](docs/architecture.html): process map and PTY pipeline
- [docs/personal-agent.md](docs/personal-agent.md): the agent, its storage and its limits

MIT
