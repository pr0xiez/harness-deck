#!/usr/bin/env node
/**
 * Cuts a release the running app will notice.
 *
 *   node scripts/release.mjs [patch|minor|major|<version>] [options]
 *
 *     --notes "…"   text shown in the update toast (default: last commit subject)
 *     --no-build    reuse whatever installer is already in release/
 *     --dry-run     print what would happen, touch nothing
 *
 * It bumps package.json, builds the Windows installer, then writes a manifest
 * into the app's userData directory. An installed copy watches that file and
 * offers the update as soon as it appears — see src/main/updater.ts.
 *
 * The build has to run with the *Windows* toolchain: node_modules here holds
 * Windows binaries (see the environment notes in ../CLAUDE.md). On WSL this
 * script finds the Windows npm itself; override with WIN_NPM if it moves.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const onWindows = process.platform === 'win32'

const argv = process.argv.slice(2)
const flags = new Set()
const options = new Map()
let bump
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--notes') {
    options.set('notes', argv[i + 1])
    i += 1
  } else if (arg.startsWith('--')) {
    flags.add(arg.slice(2))
  } else if (bump === undefined) {
    bump = arg
  }
}
const dryRun = flags.has('dry-run')
const skipBuild = flags.has('no-build')

const die = (message) => {
  console.error(`\n  release failed: ${message}\n`)
  process.exit(1)
}

/** Turns a WSL path into the `D:\…` form a Windows process needs. */
function toWindowsPath(path) {
  if (onWindows) return path
  try {
    return execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim()
  } catch {
    return die(`could not convert ${path} to a Windows path (is this WSL?)`)
  }
}

/** The app's userData directory — where both sides agree to meet. */
function userDataDir() {
  if (process.env.HD_USER_DATA) return process.env.HD_USER_DATA
  if (onWindows) {
    if (!process.env.APPDATA) return die('APPDATA is not set')
    return join(process.env.APPDATA, 'Harness Deck')
  }
  let appData
  try {
    appData = execFileSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %APPDATA%'], {
      encoding: 'utf8'
    }).trim()
  } catch {
    return die('could not read %APPDATA% — set HD_USER_DATA to the app data directory')
  }
  const unix = execFileSync('wslpath', ['-u', appData], { encoding: 'utf8' }).trim()
  return join(unix, 'Harness Deck')
}

function nextVersion(current, request = 'patch') {
  if (/^\d+\.\d+\.\d+/.test(request)) return request
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number)
  if (request === 'major') return `${major + 1}.0.0`
  if (request === 'minor') return `${major}.${minor + 1}.0`
  if (request === 'patch') return `${major}.${minor}.${patch + 1}`
  return die(`unknown bump "${request}" — use patch, minor, major or an explicit version`)
}

function commitSubject() {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** npm that matches the Windows node_modules in this tree. */
function buildNpm() {
  if (process.env.WIN_NPM) return process.env.WIN_NPM
  if (onWindows) return 'npm.cmd'
  const candidates = [
    '/mnt/c/Program Files/nodejs/npm.cmd',
    '/mnt/c/Program Files (x86)/nodejs/npm.cmd'
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    return die(
      'could not find the Windows npm — set WIN_NPM, or pass --no-build to package by hand'
    )
  }
  return found
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const previous = pkg.version
const version = nextVersion(previous, bump)
const notes = options.get('notes') || commitSubject()

console.log(`\n  Harness Deck ${previous} → ${version}`)
if (notes) console.log(`  notes: ${notes}`)
if (dryRun) console.log('  (dry run)')

const releaseDir = join(root, 'release')
const installerName = `Harness Deck-${version}-x64.exe`
const installerPath = join(releaseDir, installerName)

if (!dryRun) {
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

function restoreVersion() {
  if (dryRun) return
  pkg.version = previous
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

if (!skipBuild && !dryRun) {
  const npm = buildNpm()
  console.log(`\n  building with ${npm}…\n`)
  const result = spawnSync(npm, ['run', 'package'], {
    cwd: root,
    stdio: 'inherit',
    shell: onWindows
  })
  if (result.status !== 0) {
    restoreVersion()
    die(`the build exited with ${result.status ?? result.error?.message}`)
  }
}

if (!dryRun && !existsSync(installerPath)) {
  restoreVersion()
  const found = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => name.endsWith('.exe'))
    : []
  die(
    `expected ${installerName} in release/ but found ${found.length ? found.join(', ') : 'nothing'}`
  )
}

const manifest = {
  version,
  installer: toWindowsPath(installerPath),
  sha512: dryRun ? '' : createHash('sha512').update(readFileSync(installerPath)).digest('base64'),
  size: dryRun ? 0 : statSync(installerPath).size,
  notes,
  releasedAt: new Date().toISOString()
}

const manifestFile = join(userDataDir(), 'update.json')

if (dryRun) {
  console.log(`\n  would write ${manifestFile}:\n`)
  console.log(JSON.stringify(manifest, null, 2))
  console.log()
  process.exit(0)
}

mkdirSync(dirname(manifestFile), { recursive: true })
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

const mb = (manifest.size / 1024 / 1024).toFixed(0)
console.log(`\n  released ${version} (${mb} MB)`)
console.log(`  installer: ${manifest.installer}`)
console.log(`  manifest:  ${manifestFile}`)
console.log('\n  A running Harness Deck should offer the update within a second.\n')
