/**
 * Panes that run somewhere other than this machine.
 *
 * The WSL launchers in `profiles.ts` already prove the shape: the process runs
 * elsewhere, so the spawn's own `cwd` means nothing over there and the folder
 * has to be handed across through the environment instead. `ssh <host>` and
 * `docker exec -it <container>` are the same move with a different courier for
 * `HD_CWD` — `SendEnv` for one, `-e` for the other — and the same shrug when it
 * doesn't arrive: `cd` into it, and carry on where you landed if it isn't there.
 *
 * There is no detection behind any of this. A running-container probe costs a
 * process spawn at boot and hangs for as long as a wedged daemon feels like,
 * and an ssh_config reader has to understand Include, Match and wildcards
 * before it can offer a name that is actually connectable. Both would be a slow
 * or wrong list where an honest text field is neither, so the user types the
 * host and keeps it as a saved launcher — which HD-4 already persists, groups
 * in the harness menu, and offers in the palette.
 */

export type RemoteKind = 'ssh' | 'docker'

export interface RemoteTarget {
  kind: RemoteKind
  /** `[user@]host` for ssh, a container name or id for docker. */
  host: string
  /** Where to land over there. Empty falls back to the pane's folder via HD_CWD. */
  dir?: string
  /** Login shell to run the command in. `docker exec` only — ssh brings its own. */
  shell?: string
}

/** What a container gets when the user names no shell, matching the WSL argv. */
export const DEFAULT_REMOTE_SHELL = 'bash'

/** What a remote pane runs when the user names no command: a login shell. */
const LOGIN_SHELL = '"${SHELL:-/bin/sh}" -l'

/** Single-quotes a value for a POSIX shell — the far one, or any other we compose a command line for. */
export function quote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

function unquote(value: string): string | null {
  if (value.length < 2 || !value.startsWith("'") || !value.endsWith("'")) return null
  return value.slice(1, -1).split(`'\\''`).join("'")
}

/** `/usr/bin/ssh` and `ssh.exe` are both `ssh` for the purposes of this file. */
export function commandName(command: string): string {
  return /(?:^|[\\/])([^\\/]+?)(?:\.exe)?$/i.exec(command.trim())?.[1]?.toLowerCase() ?? ''
}

const SCRIPT = /^cd (.+?) 2>\/dev\/null; exec ([\s\S]+)$/

function script(target: RemoteTarget, cmdline: string): string {
  const dir = target.dir?.trim() ?? ''
  // Unquoted on purpose when it is the variable: it has to expand on the far
  // side, and it expands to nothing when the courier didn't get it through.
  const where = dir ? quote(dir) : '"$HD_CWD"'
  return `cd ${where} 2>/dev/null; exec ${cmdline.trim() || LOGIN_SHELL}`
}

/** The argv a remote pane spawns with. `command` is bare, resolved off PATH. */
export function buildRemote(
  target: RemoteTarget,
  cmdline: string
): { command: string; args: string[] } {
  const host = target.host.trim()
  // The courier only rides along when the script actually reads HD_CWD — a
  // pinned directory needs nothing from this side.
  const handover = !target.dir?.trim()

  if (target.kind === 'ssh') {
    return {
      command: 'ssh',
      // -t because the far end is an interactive program and wants a tty.
      // SendEnv still needs `AcceptEnv HD_CWD` on the server; when the server
      // says no, the cd fails into /dev/null and the login directory wins.
      args: [
        '-t',
        ...(handover ? ['-o', 'SendEnv=HD_CWD'] : []),
        host,
        script(target, cmdline)
      ]
    }
  }

  const shell = target.shell?.trim() || DEFAULT_REMOTE_SHELL
  return {
    command: 'docker',
    // `-e HD_CWD` with no value takes it from our environment, which is where
    // buildEnv() put it. A bind mount that keeps the host's paths makes the cd
    // land; anything else falls through to the image's WORKDIR.
    args: [
      'exec',
      '-it',
      ...(handover ? ['-e', 'HD_CWD'] : []),
      host,
      shell,
      '-lic',
      script(target, cmdline)
    ]
  }
}

/**
 * The inverse, so the pane dialog can reopen a remote pane as the fields that
 * built it rather than as an unreadable argv. Anything it does not recognise is
 * not ours to rewrite, and comes back null.
 */
export function parseRemote(
  command: string,
  args: string[]
): { target: RemoteTarget; cmdline: string } | null {
  const name = commandName(command)
  const rest = [...args]
  let kind: RemoteKind
  let shell = ''

  if (name === 'ssh') {
    kind = 'ssh'
    if (rest.shift() !== '-t') return null
    if (rest[0] === '-o' && rest[1] === 'SendEnv=HD_CWD') rest.splice(0, 2)
  } else if (name === 'docker') {
    kind = 'docker'
    if (rest.shift() !== 'exec' || rest.shift() !== '-it') return null
    if (rest[0] === '-e' && rest[1] === 'HD_CWD') rest.splice(0, 2)
  } else {
    return null
  }

  const host = rest.shift()
  if (!host) return null
  if (kind === 'docker') {
    shell = rest.shift() ?? ''
    if (!shell || rest.shift() !== '-lic') return null
  }
  if (rest.length !== 1) return null

  const parts = SCRIPT.exec(rest[0])
  if (!parts) return null
  const dir = parts[1] === '"$HD_CWD"' ? '' : unquote(parts[1])
  if (dir === null) return null

  return {
    target: { kind, host, ...(dir ? { dir } : {}), ...(shell ? { shell } : {}) },
    cmdline: parts[2] === LOGIN_SHELL ? '' : parts[2]
  }
}
