#!/usr/bin/env node
/**
 * Puts the installers in release/ onto a GitHub release.
 *
 *   node scripts/publish-release.mjs
 *
 * Run from .github/workflows/build.yml, which supplies everything it reads:
 *
 *   GITHUB_TOKEN       needs `contents: write` — the repository default is read
 *   GITHUB_REPOSITORY  owner/name
 *   GITHUB_REF         refs/tags/v1.2.3, or a branch ref
 *   GITHUB_SHA         the commit the release should point at
 *
 * A `v*` tag cuts a **draft** release named for the version, to be reviewed and
 * published by hand. Anything else refreshes `latest-main`, a prerelease that
 * always carries the newest build of the branch.
 *
 * Deliberately not `gh release upload`: the macOS half of the build runs on a
 * self-hosted Mac that isn't guaranteed to have the GitHub CLI on it, whereas
 * node is already there — the workflow just used it to build the app.
 *
 * Both platform jobs run this at the same time against the same release, so
 * every write tolerates the other getting there first: a create that loses the
 * race falls back to re-reading, and uploads replace a same-named asset instead
 * of failing on it. The two never contend for the *same* asset, because the
 * installers carry `win`/`mac` in their names — see electron-builder.yml.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')

const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
const ref = process.env.GITHUB_REF ?? ''
const sha = process.env.GITHUB_SHA

const die = (message) => {
  console.error(`\n  publish failed: ${message}\n`)
  process.exit(1)
}

if (!token) die('GITHUB_TOKEN is not set')
if (!repo) die('GITHUB_REPOSITORY is not set')
if (!sha) die('GITHUB_SHA is not set')

const tagged = ref.startsWith('refs/tags/v')
const tag = tagged ? ref.slice('refs/tags/'.length) : 'latest-main'

const rollingNotes = () =>
  [
    'The newest build of `main`, replaced on every push. Not a release —',
    'the version below is whatever `package.json` said at the time, so two',
    'of these can share a version and differ.',
    '',
    `Built from ${sha}.`
  ].join('\n')

async function api(method, url, { body, headers, raw } = {}) {
  const response = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'harness-deck-release',
      ...headers
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { ok: response.ok, status: response.status, json, text }
}

/** electron-builder's output, minus the blockmaps the updater doesn't read. */
const wanted = (name) =>
  name.endsWith('.exe') ||
  name.endsWith('.dmg') ||
  name.endsWith('.zip') ||
  (name.startsWith('latest') && name.endsWith('.yml'))

const files = existsSync(releaseDir) ? readdirSync(releaseDir).filter(wanted).sort() : []
if (!files.length) die(`no installers in ${releaseDir}`)

async function findRelease() {
  const found = await api('GET', `/repos/${repo}/releases/tags/${tag}`)
  if (found.ok) return found.json
  if (found.status !== 404) die(`looking up ${tag}: ${found.status} ${found.text}`)
  return undefined
}

async function ensureRelease() {
  const existing = await findRelease()
  if (existing) return existing

  const created = await api('POST', `/repos/${repo}/releases`, {
    body: tagged
      ? {
          tag_name: tag,
          name: tag,
          draft: true,
          target_commitish: sha,
          body: `Installers built from ${sha}.`
        }
      : {
          tag_name: tag,
          name: 'Latest main',
          prerelease: true,
          target_commitish: sha,
          body: rollingNotes()
        }
  })
  if (created.ok) return created.json

  // Most likely the other platform's job created it in the meantime.
  const raced = await findRelease()
  if (raced) return raced
  return die(`creating ${tag}: ${created.status} ${created.text}`)
}

const release = await ensureRelease()
console.log(`\n  ${tag} → ${release.html_url}`)

if (!tagged) {
  // A release holds on to whichever commit it was first cut from, so the tag
  // has to be moved by hand — otherwise `latest-main` would go on claiming to
  // be a build of whatever was on the branch weeks ago.
  const moved = await api('PATCH', `/repos/${repo}/git/refs/tags/${tag}`, {
    body: { sha, force: true }
  })
  if (!moved.ok) console.warn(`  warning: could not move ${tag} to ${sha} (${moved.status})`)

  const renotes = await api('PATCH', `/repos/${repo}/releases/${release.id}`, {
    body: { body: rollingNotes() }
  })
  if (!renotes.ok) console.warn(`  warning: could not refresh the notes (${renotes.status})`)
}

// GitHub rewrites spaces in an asset name to periods, so a same-named asset has
// to be matched in that form or replacing it would never find it.
const assetName = (name) => name.replace(/ /g, '.')

for (const file of files) {
  const name = assetName(file)
  const previous = (release.assets ?? []).find((asset) => asset.name === name)
  if (previous) {
    const deleted = await api('DELETE', `/repos/${repo}/releases/assets/${previous.id}`)
    if (!deleted.ok && deleted.status !== 404) {
      die(`replacing ${name}: ${deleted.status} ${deleted.text}`)
    }
  }

  const body = readFileSync(join(releaseDir, file))
  const uploaded = await api(
    'POST',
    `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    { headers: { 'content-type': 'application/octet-stream' }, raw: body }
  )
  if (!uploaded.ok) die(`uploading ${name}: ${uploaded.status} ${uploaded.text}`)

  console.log(`  uploaded ${name} (${(body.length / 1024 / 1024).toFixed(0)} MB)`)
}

console.log()
