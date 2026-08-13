/**
 * Assemble the self-contained dsh bundle shipped inside the desktop app.
 *
 * electron-builder's node_modules collector can silently drop packages from
 * npm's tree (its duplicate-dependency dedupe is shape-dependent and the
 * shape differs per platform). To keep the shipped dsh install exactly what
 * npm resolved, we install @deepseek-ai/dsh into an isolated `dsh-bundle/`
 * directory and copy that whole tree verbatim via extraResources — no
 * collector involved. npm resolves the full production tree here, including
 * platform-specific optional deps (sharp, ripgrep, node-pty prebuilds, …).
 *
 * npm ≥ 11.9 blocks install scripts unless `allowScripts` approves the exact
 * `name@version`; the bundle's own package.json carries those approvals and
 * the scripted packages are pinned to the approved versions on the command
 * line.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(ROOT, 'dsh-bundle')
const DSH_VERSION = '0.1.0-rc.6'

const manifest = {
  name: 'dsh-bundle',
  private: true,
  description: 'Self-contained @deepseek-ai/dsh install bundled into the desktop app',
  allowScripts: {
    '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6': true,
    'koffi@3.1.4': true,
    'node-pty@1.1.0': true,
    'protobufjs@7.6.5': true,
  },
}

mkdirSync(BUNDLE, { recursive: true })
writeFileSync(path.join(BUNDLE, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

// When invoked through `npm run bundle-dsh`, npm_execpath points at the
// npm-cli.js of the running npm — spawn it with the current node. Otherwise
// fall back to `npm` on PATH (Windows needs a shell for npm.cmd).
const npmCli = process.env.npm_execpath
const command = npmCli ? process.execPath : 'npm'
const baseArgs = [
  'install',
  '--no-save',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  `@deepseek-ai/dsh@${DSH_VERSION}`,
  '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6',
  'koffi@3.1.4',
  'node-pty@1.1.0',
  'protobufjs@7.6.5',
]
const args = npmCli ? [npmCli, ...baseArgs] : baseArgs

console.log(`installing @deepseek-ai/dsh@${DSH_VERSION} into ${path.relative(ROOT, BUNDLE)} …`)
const res = spawnSync(command, args, {
  cwd: BUNDLE,
  stdio: 'inherit',
  shell: npmCli ? false : process.platform === 'win32',
})
if (res.status !== 0) {
  console.error('dsh bundle install failed')
  process.exit(res.status ?? 1)
}

const bin = path.join(BUNDLE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const group = path.join(BUNDLE, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
if (!existsSync(bin)) {
  console.error(`missing ${path.relative(ROOT, bin)}`)
  process.exit(1)
}
if (!existsSync(group)) {
  console.error(`missing ${path.relative(ROOT, group)}`)
  process.exit(1)
}
console.log('dsh bundle ready:', path.relative(ROOT, bin))
