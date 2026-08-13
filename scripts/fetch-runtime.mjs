/**
 * Download and extract the standalone Node.js runtime bundled with the app.
 *
 * The `dsh web` server runs on this bundled Node so the desktop app needs no
 * system Node, npx, or PATH setup. Native npm dependencies (node-pty, koffi,
 * sharp, …) are installed by the SAME Node version, so their prebuilt ABIs
 * always match this runtime — install dependencies with Node v26.3.0 and
 * everything lines up.
 *
 * Usage:
 *   node scripts/fetch-runtime.mjs [platform-arch]
 *
 * `platform-arch` defaults to the current platform (darwin-arm64, win32-x64,
 * …). CI passes it explicitly to pin the artifact's target platform.
 */

import { createWriteStream, readdirSync } from 'node:fs'
import { mkdir, rm, rename, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_VERSION = '26.3.0'
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = path.join(ROOT, 'runtime')
const TARGET_DIR = path.join(RUNTIME_DIR, 'node')

const MAP = {
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, ext: '.tar.gz' },
  'darwin-x64': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, ext: '.tar.gz' },
  'linux-x64': { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, ext: '.tar.gz' },
  'linux-arm64': { file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, ext: '.tar.gz' },
  'win32-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, ext: '.zip' },
  'win32-arm64': { file: `node-v${NODE_VERSION}-win-arm64.zip`, ext: '.zip' },
}

const key = process.argv[2] || `${process.platform}-${process.arch}`
const entry = MAP[key]
if (!entry) {
  console.error(`unsupported platform-arch: ${key}`)
  process.exit(1)
}

const url = `https://nodejs.org/dist/v${NODE_VERSION}/${entry.file}`
const archivePath = path.join(RUNTIME_DIR, entry.file)
const extractDir = path.join(RUNTIME_DIR, 'extract')

console.log(`fetching ${url}`)
await mkdir(RUNTIME_DIR, { recursive: true })

// Skip the download when the archive already exists and looks complete.
try {
  const existing = await stat(archivePath)
  if (existing.size > 10 * 1024 * 1024) {
    console.log(`archive already present (${(existing.size / 1024 / 1024).toFixed(1)} MB), reusing`)
  }
} catch {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  // Node's fetch returns a Web ReadableStream; buffer it directly.
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(archivePath, buf)
  console.log('downloaded')
}

// Both formats extract with tar (bsdtar handles .zip on macOS and Windows).
await rm(extractDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
const tar = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' })
if (tar.status !== 0) {
  console.error('tar extraction failed')
  process.exit(1)
}

// The archive contains a single folder like node-v26.3.0-darwin-arm64/.
const extracted = readdirSync(extractDir).find((name) => name.startsWith('node-v'))
if (!extracted) {
  console.error('could not locate the extracted node folder')
  process.exit(1)
}

await rm(TARGET_DIR, { recursive: true, force: true })
await rename(path.join(extractDir, extracted), TARGET_DIR)
await rm(extractDir, { recursive: true, force: true })
await rm(archivePath, { force: true })

console.log(`runtime ready at ${path.relative(ROOT, TARGET_DIR)}`)
