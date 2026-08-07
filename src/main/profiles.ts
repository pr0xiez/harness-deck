import { accessSync, constants, existsSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { ForgeCli, Profile } from '@shared/types'
import { flavourOf, type ShellFlavour } from '@shared/shell'
import { runProcess } from './process'
import { loadCustomProfiles } from './profiles-store'
import { defaultShell, shellEnv } from './shell-env'

interface AgentDef {
  id: string
  name: string
  bin: string
  badge: string
  accent: string
  install: string
}

/** The coding harnesses we know how to launch. */
const AGENTS: AgentDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    badge: 'CC',
    accent: '#d97757',
    install: 'npm i -g @anthropic-ai/claude-code'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    badge: 'CX',
    accent: '#10a37f',
    install: 'npm i -g @openai/codex'
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    bin: 'copilot',
    badge: 'CP',
    accent: '#7c8cf8',
    install: 'npm i -g @github/copilot'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    badge: 'GM',
    accent: '#4f8ef7',
    install: 'npm i -g @google/gemini-cli'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    badge: 'OC',
    accent: '#f59e0b',
    install: 'npm i -g opencode-ai'
  },
  {
    id: 'aider',
    name: 'Aider',
    bin: 'aider',
    badge: 'AD',
    accent: '#c084fc',
    install: 'python -m pip install aider-install'
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    bin: 'cursor-agent',
    badge: 'CU',
    accent: '#38bdf8',
    install: 'curl https://cursor.com/install -fsS | bash'
  }
]

/** Locates an executable using the login-shell PATH (and PATHEXT on Windows). */
export function findExecutable(command: string, env = shellEnv()): string | null {
  if (!command) return null
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  const candidates: string[] = []
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    candidates.push(command)
  } else {
    for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, command))
    }
  }

  for (const candidate of candidates) {
    for (const ext of ['', ...exts]) {
      const full = candidate + ext
      try {
        accessSync(full, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return full
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/**
 * Bytes rather than text, because the caller has to sniff the encoding (see
 * `decodeWsl`). Output that arrived before an error is still an answer — a WSL
 * that listed its distros and then dawdled past the timeout did list them.
 */
async function exec(cmd: string, args: string[], timeout: number): Promise<Buffer | null> {
  const ran = await runProcess(cmd, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'buffer' })
  return ran.error && !ran.stdout.length ? null : ran.stdout
}

/** wsl.exe still speaks UTF-16LE for some subcommands. */
function decodeWsl(buf: Buffer): string {
  const nulls = buf.subarray(0, Math.min(buf.length, 64)).filter((b) => b === 0).length
  const text = nulls > 4 ? buf.toString('utf16le') : buf.toString('utf8')
  return text.replace(/\r/g, '').replace(/\u0000/g, '')
}

/** Preferred first, so a machine with both is offered the one it is likelier to want. */
const FORGES: ForgeCli[] = ['gh', 'glab']

let forgeCache: ForgeCli | null | undefined

/**
 * Which PR-capable CLI is on PATH. Cached for the run, like `probeWsl`'s answer
 * — the ship dialog asks every time it opens, and a CLI installed halfway
 * through a session is not worth re-walking PATH for.
 *
 * A PATH lookup rather than `gh --version` on purpose: this answer gates a
 * button, and asking a binary to introduce itself hands a wedged one the power
 * to hang the dialog waiting for it. `findExecutable` only stats files.
 */
export function detectForge(): ForgeCli | null {
  if (forgeCache === undefined) forgeCache = FORGES.find((cli) => findExecutable(cli)) ?? null
  return forgeCache
}

interface WslInfo {
  available: boolean
  exe: string
  distros: string[]
  agents: Set<string>
}

let wslCache: WslInfo | null = null

async function probeWsl(): Promise<WslInfo> {
  if (wslCache) return wslCache
  const info: WslInfo = { available: false, exe: 'wsl.exe', distros: [], agents: new Set() }
  if (process.platform !== 'win32') {
    wslCache = info
    return info
  }
  const wsl =
    findExecutable('wsl.exe') ??
    [
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe'),
      join(process.env.SystemRoot || 'C:\\Windows', 'Sysnative', 'wsl.exe')
    ].find((candidate) => existsSync(candidate))
  if (!wsl) {
    wslCache = info
    return info
  }
  info.exe = wsl

  const list = await exec(wsl, ['-l', '-q'], 8000)
  if (list) {
    info.distros = decodeWsl(list)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    info.available = info.distros.length > 0
  }

  if (info.available) {
    const bins = AGENTS.map((a) => a.bin).join(' ')
    const script = `for c in ${bins}; do if command -v "$c" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$c" ]; then echo "$c"; fi; done`
    const found =
      (await exec(wsl, ['-e', 'bash', '-lic', script], 12000)) ??
      (await exec(wsl, ['-e', 'sh', '-lc', script], 12000))
    if (found) {
      for (const line of decodeWsl(found).split('\n')) {
        const bin = line.trim()
        const agent = AGENTS.find((a) => a.bin === bin)
        if (agent) info.agents.add(agent.id)
      }
    }
  }

  wslCache = info
  return info
}

/**
 * Builds the launcher list for the current machine. Unavailable harnesses are
 * still returned (flagged, with an install hint) so they stay discoverable.
 */
export async function detectProfiles(): Promise<Profile[]> {
  const env = shellEnv()
  const win = process.platform === 'win32'
  const profiles: Profile[] = []

  for (const agent of AGENTS) {
    const found = findExecutable(agent.bin, env)
    profiles.push({
      id: `agent:${agent.id}`,
      name: agent.name,
      command: found ?? agent.bin,
      args: [],
      kind: 'agent',
      icon: agent.badge,
      accent: agent.accent,
      available: Boolean(found),
      detail: found ?? `Not on PATH — install with: ${agent.install}`
    })
  }

  const wslInfo = await probeWsl()
  if (wslInfo.available) {
    for (const agent of AGENTS) {
      const available = wslInfo.agents.has(agent.id)
      profiles.push({
        id: `wsl:${agent.id}`,
        name: `${agent.name} (WSL)`,
        command: wslInfo.exe,
        // HD_CWD is injected as a translated unix path at spawn time.
        args: ['-e', 'bash', '-lic', `cd "$HD_CWD" 2>/dev/null; exec ${agent.bin}`],
        kind: 'agent',
        icon: agent.badge,
        accent: agent.accent,
        available,
        detail: available
          ? `Runs inside ${wslInfo.distros[0]}`
          : `Not found in ${wslInfo.distros[0]} — install with: ${agent.install}`
      })
    }
  }

  // Shells
  const shell = defaultShell()
  profiles.push({
    id: 'shell:default',
    name: win ? basename(shell, '.exe') : basename(shell),
    command: shell,
    args: win ? [] : ['-l'],
    kind: 'shell',
    icon: 'SH',
    accent: '#7d8896',
    available: existsSync(shell) || Boolean(findExecutable(shell, env)),
    detail: shell
  })

  if (win) {
    const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
    if (existsSync(cmd) && cmd.toLowerCase() !== shell.toLowerCase()) {
      profiles.push({
        id: 'shell:cmd',
        name: 'Command Prompt',
        command: cmd,
        args: [],
        kind: 'shell',
        icon: 'CM',
        accent: '#7d8896',
        available: true,
        detail: cmd
      })
    }
    for (const distro of wslInfo.distros) {
      profiles.push({
        id: `wsl:shell:${distro}`,
        name: `${distro} shell`,
        command: wslInfo.exe,
        args: ['-d', distro, '-e', 'bash', '-lic', 'cd "$HD_CWD" 2>/dev/null; exec $SHELL -l'],
        kind: 'shell',
        icon: 'WS',
        accent: '#38bdf8',
        available: true,
        detail: `WSL distribution ${distro}`
      })
    }
  } else {
    for (const alt of ['zsh', 'bash', 'fish']) {
      const found = findExecutable(alt, env)
      if (found && found !== shell) {
        profiles.push({
          id: `shell:${alt}`,
          name: alt,
          command: found,
          args: ['-l'],
          kind: 'shell',
          icon: alt.slice(0, 2).toUpperCase(),
          accent: '#7d8896',
          available: true,
          detail: found
        })
      }
    }
  }

  // Saved launchers ride in the same list as the detected ones, so the profile
  // menu, the palette and the quick picks pick them up without knowing they
  // came from disk. A command line's first word decides availability, the same
  // question `findExecutable` answers for everything else here.
  for (const saved of loadCustomProfiles()) {
    const first = saved.command.trim().split(/\s+/)[0] ?? ''
    const found = findExecutable(first, env)
    const cmdline = [saved.command, ...saved.args].join(' ').trim()
    profiles.push({
      id: saved.id,
      name: saved.name,
      command: saved.command,
      args: [...saved.args],
      kind: 'custom',
      icon: saved.icon,
      accent: saved.accent,
      available: Boolean(found),
      detail: found ? cmdline : `${first} is not on PATH — ${cmdline}`,
      ...(saved.viaShell ? { viaShell: true } : {}),
      ...(saved.cwd ? { cwd: saved.cwd } : {}),
      ...(saved.env ? { env: saved.env } : {})
    })
  }

  profiles.push({
    id: 'custom',
    name: 'Custom command…',
    command: '',
    args: [],
    kind: 'custom',
    icon: '»',
    accent: '#94a3b8',
    available: true,
    detail: 'Run any command line in a login shell'
  })

  return profiles
}

/**
 * Which command-line grammar `defaultShell()` speaks. Named rather than
 * inferred at each call site because two of the three differ in more than their
 * argv: cmd.exe has no `exec`, and PowerShell before 7 has no `&&` (see
 * `pty.ts`, where a pane's setup command is composed onto its command line).
 * The rule itself lives in `@shared/shell` so the renderer's ship-chain
 * composition speaks the same grammar this process spawns.
 */
export type { ShellFlavour } from '@shared/shell'

export function shellFlavour(shell = defaultShell()): ShellFlavour {
  return flavourOf(process.platform, shell)
}

/**
 * Expands a `viaShell` command line into an argv for the current platform.
 *
 * `exits` says the shell must not outlive the line: the pty's onExit is how a
 * pane reports its exit code, and cmd's `/k` and PowerShell's `-NoExit` leave
 * an interactive prompt sitting where that report should be — the pane reads
 * as running forever and auto-restart never fires. A plain `viaShell` pane
 * keeps the interactive default it has always had; a pane with a setup command
 * needs `exits`. POSIX `-c` exits with the line's status either way.
 */
export function shellCommandLine(
  cmdline: string,
  { exits = false, shell = defaultShell() }: { exits?: boolean; shell?: string } = {}
): { command: string; args: string[] } {
  switch (shellFlavour(shell)) {
    case 'cmd':
      return { command: shell, args: [exits ? '/c' : '/k', cmdline] }
    case 'powershell':
      // `exit $LASTEXITCODE`, because -Command's own exit status collapses to
      // 0-or-1 — the pane wants the real code, for the crash-restart backoff.
      return exits
        ? { command: shell, args: ['-NoLogo', '-Command', `${cmdline}; exit $LASTEXITCODE`] }
        : { command: shell, args: ['-NoLogo', '-NoExit', '-Command', cmdline] }
    default:
      return { command: shell, args: ['-l', '-i', '-c', cmdline] }
  }
}

export function homeDir(): string {
  return homedir()
}
