/**
 * The GitHub half of the release channel: everything about it that is a pure
 * function of text. It lives away from `updater.ts` because that file imports
 * `electron`, and the unit tests run in plain node — see vitest.config.ts.
 */

/** Enough of electron-builder's update metadata to find and verify an installer. */
export interface LatestYml {
  version: string
  /** Asset name of the installer, relative to the release it was read from. */
  path?: string
  /** Base64 sha512 of that asset, matching what the local manifest carries. */
  sha512?: string
  size?: number
  releaseDate?: string
  releaseNotes?: string
  files: ReleaseFile[]
}

export interface ReleaseFile {
  url: string
  sha512?: string
  size?: number
}

export interface ReleaseRepo {
  owner: string
  repo: string
}

/** Enough of semver for `x.y.z` with an optional prerelease tag. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = value.trim().replace(/^v/, '').split('-')
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre: rest.join('-')
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  // A release outranks any prerelease of the same numbers.
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

const scalar = (raw: string): string => {
  const value = raw.trim()
  const quote = value[0]
  if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length > 1) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * A `latest*.yml` is written by a machine and only ever holds scalars and one
 * list of files, so it is parsed here rather than pulling in a YAML library for
 * six keys. Anything unrecognised — a folded `releaseNotes` block, a key added
 * by a later electron-builder — is skipped instead of throwing, because a feed
 * we half-understand is still enough to offer an update from.
 */
export function parseLatestYml(text: string): LatestYml {
  const result: LatestYml = { version: '', files: [] }
  let file: ReleaseFile | null = null

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    if (indent === 0) {
      file = null
      const match = /^([A-Za-z0-9_]+):(.*)$/.exec(line)
      if (!match) continue
      const [, key, rest] = match
      const value = scalar(rest)
      if (key === 'version') result.version = value
      else if (key === 'path') result.path = value
      else if (key === 'sha512') result.sha512 = value
      else if (key === 'size') result.size = Number(value) || undefined
      else if (key === 'releaseDate') result.releaseDate = value
      else if (key === 'releaseNotes' && value) result.releaseNotes = value
      continue
    }

    const entry = /^\s*-\s*([A-Za-z0-9_]+):(.*)$/.exec(line)
    if (entry) {
      file = { url: '' }
      result.files.push(file)
      assign(file, entry[1], scalar(entry[2]))
      continue
    }

    const field = /^\s+([A-Za-z0-9_]+):(.*)$/.exec(line)
    if (field && file) assign(file, field[1], scalar(field[2]))
  }

  if (!result.version) throw new Error('it names no version')
  if (!result.files.length && result.path) {
    result.files.push({ url: result.path, sha512: result.sha512, size: result.size })
  }
  if (!result.files.length) throw new Error('it lists no files')
  return result
}

function assign(file: ReleaseFile, key: string, value: string): void {
  if (key === 'url') file.url = value
  else if (key === 'sha512') file.sha512 = value
  else if (key === 'size') file.size = Number(value) || undefined
}

/** What electron-builder calls its update metadata on each platform. */
export function updateInfoFile(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'latest.yml'
  if (platform === 'darwin') return 'latest-mac.yml'
  return 'latest-linux.yml'
}

const INSTALLER_EXT: Partial<Record<NodeJS.Platform, string>> = {
  win32: '.exe',
  darwin: '.dmg'
}

/**
 * A mac feed lists the zip electron-updater patches against as well as the dmg
 * a person would install, so the platform's installer has to be picked by
 * extension rather than by taking the first entry. `path` is the fallback for
 * a feed that only ever had one artifact.
 */
export function pickInstaller(yml: LatestYml, platform: NodeJS.Platform): ReleaseFile | null {
  const ext = INSTALLER_EXT[platform]
  const match = ext ? yml.files.find((file) => file.url.toLowerCase().endsWith(ext)) : undefined
  const chosen = match ?? yml.files.find((file) => file.url === yml.path) ?? yml.files[0] ?? null
  if (!chosen?.url) return null
  return { ...chosen, sha512: chosen.sha512 ?? yml.sha512, size: chosen.size ?? yml.size }
}

/**
 * Which repository the app polls. Read from package.json's `repository` — the
 * same field electron-builder falls back to when no publish target is named,
 * so a fork changes it in one place and both halves follow.
 */
export function repoFromPackage(pkg: unknown): ReleaseRepo | null {
  const field = (pkg as { repository?: unknown } | null)?.repository
  const raw =
    typeof field === 'string'
      ? field
      : typeof (field as { url?: unknown } | undefined)?.url === 'string'
        ? ((field as { url: string }).url as string)
        : ''
  if (!raw) return null
  const cleaned = raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^github:/, '')
    .replace(/^(https?:\/\/|git@)github\.com[/:]/, '')
  const [owner, repo] = cleaned.split('/')
  return owner && repo ? { owner, repo } : null
}

/**
 * Release assets are reachable by tag without a token, so the feed is a plain
 * download URL rather than an API call — nothing here can hold a credential.
 */
export function feedUrl(repo: ReleaseRepo, tag: string, platform: NodeJS.Platform): string {
  return `https://github.com/${repo.owner}/${repo.repo}/releases/download/${tag}/${updateInfoFile(platform)}`
}
