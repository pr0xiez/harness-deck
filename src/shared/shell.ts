import { quote } from './remote'

/**
 * Which command-line grammar a pane's shell speaks. Shared because both sides
 * of the app need the same answer: the main process composes setup chains onto
 * command lines (`pty.ts`), and the renderer composes the ship chain whose
 * preview is a contract — the string shown must be the string the shell runs,
 * in that shell's own words.
 */
export type ShellFlavour = 'posix' | 'cmd' | 'powershell'

/** The pure half of `shellFlavour()` in main — same rule, no process global. */
export function flavourOf(platform: string, shell: string): ShellFlavour {
  if (platform !== 'win32') return 'posix'
  return shell.toLowerCase().endsWith('cmd.exe') ? 'cmd' : 'powershell'
}

/**
 * One word to the program, in the shell's own quoting. POSIX is the shared
 * `quote()`. PowerShell gets single quotes (doubled inside) because its double
 * quotes interpolate — a commit message mentioning `$5` must stay `$5`. cmd
 * gets double quotes with doubling, the one spelling both Windows runtimes
 * read as a literal quote (see `quoteArg` in `pty.ts`, which made the same
 * call for paths).
 */
export function quoteFor(value: string, flavour: ShellFlavour): string {
  switch (flavour) {
    case 'powershell':
      return `'${value.split("'").join("''")}'`
    case 'cmd':
      return `"${value.split('"').join('""')}"`
    default:
      return quote(value)
  }
}

/**
 * Runs the commands in order, each step only if the one before it succeeded —
 * `&&` where the shell has it. PowerShell before 7 has none (the same gap
 * `withSetup` in `pty.ts` works around), so it gets the `$LASTEXITCODE` form,
 * nested so a skipped middle step cannot leave a stale zero that lets a later
 * one run.
 */
export function chainFor(commands: string[], flavour: ShellFlavour): string {
  if (!commands.length) return ''
  switch (flavour) {
    case 'powershell': {
      const [head, ...rest] = commands
      return rest.length ? `${head}; if ($LASTEXITCODE -eq 0) { ${chainFor(rest, flavour)} }` : head
    }
    case 'cmd':
      return commands.join(' && ')
    default:
      return commands.join(' &&\n')
  }
}
