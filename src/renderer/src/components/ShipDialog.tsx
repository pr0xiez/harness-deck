import { useEffect, useMemo, useRef, useState } from 'react'
import { chainFor, flavourOf, quoteFor, type ShellFlavour } from '@shared/shell'
import type { DiffResult, ForgeCli } from '@shared/types'
import { useDeck, type PaneView } from '../store'
import { Field, Modal, Toggle } from './ui'

const api = window.harness

/**
 * Landing a worktree without typing the four commands, and without hiding them.
 *
 * The rival's version of this is one button and a spinner; when it fails you
 * get a toast and no idea which half ran. Here the chain is composed in front
 * of you, and then run in an ordinary pane in that worktree — so a rejected
 * push is scrollback you can read, retry by hand, or scroll back to tomorrow.
 * The preview is the contract: the string shown is the string spawned.
 */

/** What the toggles ask for, with everything the chain needs to name itself. */
export interface ShipPlan {
  message: string
  branch: string
  commit: boolean
  push: boolean
  pr: boolean
  forge: ForgeCli | null
  /**
   * The grammar of the shell the pane will actually spawn (`shell:default` via
   * `shellCommandLine`). The preview is a contract, so it must be written in
   * that shell's words — a POSIX-quoted chain handed to PowerShell would show
   * one thing and run another, or nothing.
   */
  flavour: ShellFlavour
}

/**
 * Git's refname rules leave `$`, `;`, `&` and `(` legal in a branch name, so a
 * branch is not reliably a bare word — but almost always is, and quoting the
 * ordinary case would make the preview read like machinery. Quote the rest.
 */
const BARE = /^[A-Za-z0-9._/-]+$/
const arg = (value: string, flavour: ShellFlavour): string =>
  BARE.test(value) ? value : quoteFor(value, flavour)

/** Where the branch goes when git could not name one — `push -u` still resolves it. */
const NO_BRANCH = 'HEAD'

/**
 * The chain, one command per entry, in the only order they make sense in.
 *
 * `git commit -m` takes the message as one argv entry, so the whole of it —
 * apostrophes, spaces, newlines — has to survive the shell as a single word,
 * written in that shell's own quoting (`quoteFor`).
 */
export function shipCommands(plan: ShipPlan): string[] {
  const out: string[] = []
  if (plan.commit) {
    out.push('git add -A', `git commit -m ${quoteFor(plan.message.trim(), plan.flavour)}`)
  }
  if (plan.push) {
    out.push(`git push -u origin ${arg(plan.branch.trim() || NO_BRANCH, plan.flavour)}`)
  }
  // No forge, no step: the chain is shorter, not broken.
  if (plan.pr && plan.forge) {
    out.push(plan.forge === 'glab' ? 'glab mr create --fill' : 'gh pr create --fill')
  }
  return out
}

/**
 * Joined stop-on-failure (`&&`, or PowerShell's `$LASTEXITCODE` form — see
 * `chainFor`), and shown that way, because the join is part of what the user
 * is agreeing to: a push the remote rejected must not be followed by a PR
 * against a branch that never arrived. It also makes the pane safe to restart
 * — the second run's `git commit` finds nothing to commit and stops the chain
 * there, instead of pushing and opening a second PR.
 */
export function shipChain(plan: ShipPlan): string {
  return chainFor(shipCommands(plan), plan.flavour)
}

/** The voice `detectProfiles` uses for a harness that isn't installed. */
const NO_FORGE = 'Not on PATH — install with: brew install gh (or glab, for GitLab)'

interface Props {
  workspaceId: string
  pane: PaneView
  /** The column's diff, when the compare view has already paid for it. */
  diff?: DiffResult
  onClose: () => void
}

export function ShipDialog({ workspaceId, pane, diff, onClose }: Props): React.JSX.Element {
  const profiles = useDeck((s) => s.profiles)
  const addPane = useDeck((s) => s.addPane)
  // Only ever the fallback: `repos` is keyed by folder and the toolbar only
  // refreshes the workspace's own, so a worktree is usually absent from it.
  const repoBranch = useDeck((s) => s.repos[pane.cwd]?.branch ?? '')
  // The grammar of the shell the pane will spawn. `info` is loaded before the
  // first workspace renders, so the posix fallback is for tests, not for users.
  const flavour = useDeck((s) =>
    s.info ? flavourOf(s.info.platform, s.info.defaultShell) : 'posix'
  )

  const [asked, setAsked] = useState<DiffResult | null>(null)
  const [forge, setForge] = useState<ForgeCli | null>(null)
  const [probed, setProbed] = useState(false)
  const [message, setMessage] = useState('')
  const [commit, setCommit] = useState(true)
  const [push, setPush] = useState(true)
  const [pr, setPr] = useState(true)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Closing the dialog is a promise that nothing runs — including a run() that
  // was already awaiting git when the Escape landed.
  const open = useRef(true)
  useEffect(() => {
    return () => {
      open.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    void api.git.forge().then((found) => {
      if (!live) return
      setForge(found)
      setProbed(true)
    })
    return () => {
      live = false
    }
  }, [])

  // The compare view opened us holding its column's answer; the pane button did
  // not. One patch line, because all this needs from git is the branch and
  // whether anything changed at all.
  useEffect(() => {
    if (diff) return
    let live = true
    void api.git.diffRange({ dir: pane.cwd, limit: 1 }).then((result) => {
      if (live) setAsked(result)
    })
    return () => {
      live = false
    }
  }, [diff, pane.cwd])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const state = diff ?? asked
  const branch = state?.branch || repoBranch || ''
  const folder = (pane.worktree ?? pane.cwd).split(/[\\/]/).filter(Boolean).pop() ?? 'worktree'
  // Not "we haven't asked yet": an error is a reason to say nothing about the
  // tree, and an empty stat only means empty once git has actually answered.
  const nothingChanged = Boolean(state && !state.error && !state.stat)

  const commitOn = commit && !nothingChanged
  const prOn = pr && forge !== null
  const chain = useMemo(
    () => shipChain({ message, branch, commit: commitOn, push, pr: prOn, forge, flavour }),
    [message, branch, commitOn, push, prOn, forge, flavour]
  )

  const needsMessage = commitOn && !message.trim()
  const canRun = Boolean(chain) && !needsMessage && !busy

  const copy = (): void => {
    api.clipboard.write(chain)
    setCopied(true)
  }

  const run = async (): Promise<void> => {
    if (!canRun) return
    setBusy(true)
    setError(null)
    // `pane.worktree` is persisted, so it can outlive the repo that produced it
    // — the same reason `requestClosePane` re-asks git before offering to
    // delete one. A path whose repo moved on must never turn Ship into a commit
    // in somebody's main checkout.
    const dir = pane.worktree ?? ''
    const info = dir ? await api.git.info(dir) : null
    // The dialog closed while git was answering. The footer's promise wins
    // over the click that was in flight: nothing runs.
    if (!open.current) return
    setBusy(false)
    if (!info?.worktreeOf) {
      setError(`${dir || 'This pane'} is not a linked worktree any more. Nothing was run.`)
      return
    }

    const shell = profiles.find((p) => p.id === 'shell:default')
    if (!shell) {
      setError('No shell launcher to run it in.')
      return
    }

    addPane(workspaceId, shell, {
      cwd: dir,
      command: chain,
      args: [],
      viaShell: true,
      name: `ship · ${branch || folder}`,
      // This pane is the run of one approved chain, not a fixture of the
      // deck: were it persisted, relaunch would autostart it and re-run the
      // commit/push against whatever the tree holds by then — under a stale
      // message, or (worktree since deleted) in the homedir fallback cwd.
      transient: true
      // Deliberately no `worktree`: the tree belongs to the pane that made it,
      // and closing a ship pane must never offer to delete the folder another
      // pane is still working in.
    })
    onClose()
  }

  return (
    <Modal
      title={`Ship ${branch || folder}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="foot-note">
            {error ?? 'It runs in a pane, in this worktree. Closing this runs nothing.'}
          </span>
          <button className="btn subtle" onClick={copy} disabled={!chain}>
            {copied ? 'Copied' : 'Copy commands'}
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={!canRun}>
            Run in a pane
          </button>
        </>
      }
    >
      <Field
        label="Commit message"
        hint={
          needsMessage
            ? 'A commit needs a message.'
            : "Apostrophes and quotes are fine — it is one argument to git, however it's written."
        }
      >
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`What ${folder} did`}
          disabled={!commitOn}
          autoFocus
        />
      </Field>

      <Toggle
        checked={commitOn}
        onChange={setCommit}
        disabled={nothingChanged}
        label="Commit everything in the tree"
        hint={
          nothingChanged
            ? `Nothing has changed since this branched off ${state?.baseRef || 'its base'} — there is no commit to make.`
            : 'git add -A, then a single commit — untracked files included.'
        }
      />
      <Toggle
        checked={push}
        onChange={setPush}
        label="Push the branch"
        hint={`Sets the upstream to origin/${branch || NO_BRANCH}.`}
      />
      <Toggle
        checked={prOn}
        onChange={setPr}
        disabled={!forge}
        label="Open a pull request"
        hint={
          forge
            ? `${forge} owns the auth and fills the title and body from the branch — this app never sees a token.`
            : probed
              ? NO_FORGE
              : 'Looking for gh…'
        }
      />

      <Field label="What will run">
        <pre className="ship-preview">
          {chain || 'Nothing selected — the pane would have nothing to do.'}
        </pre>
      </Field>
    </Modal>
  )
}
