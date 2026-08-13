'use strict'

/**
 * DSH desktop wrapper.
 *
 * Boots the `dsh web` server (bundled `@deepseek-ai/dsh` + bundled Node
 * runtime, so no system Node/npx is required), waits until it serves, and
 * shows the Web UI in a native window. If a DSH server is already running on
 * the target port, it is reused instead of starting a second one, and quitting
 * the app then leaves that server alone.
 */

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')

const DEFAULT_PORT = 3080
const READY_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 2_000
const IS_WIN = process.platform === 'win32'

// Environment overrides (useful for testing and power users).
const FORCED_PORT = process.env.DSH_DESKTOP_PORT ? Number(process.env.DSH_DESKTOP_PORT) : null
const USER_DATA_OVERRIDE = process.env.DSH_DESKTOP_USER_DATA
if (USER_DATA_OVERRIDE) {
  app.setPath('userData', USER_DATA_OVERRIDE)
}

let win = null
let serverChild = null
let spawnedByUs = false
let booting = false
let quitting = false
let currentPort = null
let logFilePath = null
let logTail = []

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function openLogFile() {
  if (logFilePath) return
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logFilePath = path.join(dir, 'dsh-desktop.log')
}

function log(line) {
  openLogFile()
  const stamped = `[${new Date().toISOString()}] ${line}`
  logTail.push(stamped)
  if (logTail.length > 400) logTail.shift()
  try {
    fs.appendFileSync(logFilePath, stamped + '\n')
  } catch {
    /* logging must never take the app down */
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function runtimeNode() {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  // Windows Node distributions put node.exe at the archive root; macOS/Linux
  // put it under bin/.
  const bin = IS_WIN ? 'node.exe' : path.join('bin', 'node')
  return path.join(base, 'runtime', 'node', bin)
}

function dshBin() {
  return path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

// ---------------------------------------------------------------------------
// Server probing
// ---------------------------------------------------------------------------

/** GET / on a port; resolves to 'dsh' | 'other' | 'free'. */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 64 * 1024) req.destroy()
        })
        res.on('end', () => resolve(body.includes('__DSH_BOOT__') ? 'dsh' : 'other'))
        res.on('error', () => resolve('free'))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve('free')
    })
    req.on('error', () => resolve('free'))
  })
}

/** Wait until the port serves the DSH UI. Resolves when ready, rejects on timeout/death. */
function waitForReady(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (quitting) return reject(new Error('app is quitting'))
      if (serverChild && serverChild.exitCode !== null) {
        return reject(new Error(`dsh 进程提前退出（exit ${serverChild.exitCode}）`))
      }
      probe(port).then((state) => {
        if (state === 'dsh') return resolve()
        if (Date.now() > deadline) {
          return reject(new Error(`等待 http://127.0.0.1:${port} 就绪超时（${READY_TIMEOUT_MS / 1000}s）`))
        }
        setTimeout(tick, 400)
      })
    }
    tick()
  })
}

/** Find a free port starting at `from`, up to `to`. */
async function findFreePort(from, to) {
  const isFree = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
  for (let port = from; port <= to; port += 1) {
    if (await isFree(port)) return port
  }
  throw new Error('3081-3180 范围内没有可用端口')
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function spawnServer(port) {
  const node = runtimeNode()
  const bin = dshBin()
  if (!fs.existsSync(node)) throw new Error(`内置 Node 运行时缺失: ${node}`)
  if (!fs.existsSync(bin)) throw new Error(`内置 dsh CLI 缺失: ${bin}`)

  log(`启动内置服务器: ${node} ${bin} web --port ${port}`)
  const child = spawn(node, [bin, 'web', '--port', String(port)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  spawnedByUs = true
  child.stdout.on('data', (d) => log(`[dsh:out] ${String(d).trimEnd()}`))
  child.stderr.on('data', (d) => log(`[dsh:err] ${String(d).trimEnd()}`))
  child.on('error', (err) => log(`[dsh] spawn error: ${err.message}`))
  child.on('exit', (code, signal) => {
    log(`[dsh] 进程退出 code=${code} signal=${signal}`)
    if (serverChild === child) serverChild = null
    if (!quitting && spawnedByUs && win && !win.isDestroyed()) {
      spawnedByUs = false
      showError(`DSH 服务器意外退出（code=${code} signal=${signal}）。点击“重试”重新启动。`)
    }
  })
  serverChild = child
}

/** Resolve which port to use and make sure a DSH server serves it. */
async function resolveServer(desiredPort) {
  const state = await probe(desiredPort)
  if (state === 'dsh') {
    log(`端口 ${desiredPort} 已有 DSH 服务器，直接复用`)
    spawnedByUs = false
    return desiredPort
  }
  let port = desiredPort
  if (state === 'other' && !FORCED_PORT) {
    port = await findFreePort(3081, 3180)
    log(`端口 ${desiredPort} 被其他服务占用，改用端口 ${port}`)
  }
  spawnServer(port)
  const deadline = Date.now() + READY_TIMEOUT_MS
  await waitForReady(port, deadline)
  return port
}

async function stopServer() {
  const child = serverChild
  if (!child || child.exitCode !== null) return
  // Windows has no POSIX signals: TerminateProcess directly.
  log(IS_WIN ? '[dsh] 终止进程（Windows）' : '[dsh] 发送 SIGTERM，等待退出')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('[dsh] 5s 未退出，强制终止')
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.kill(IS_WIN ? undefined : 'SIGTERM')
    } catch {}
  })
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function showError(message) {
  log(`显示错误页: ${message}`)
  if (!win || win.isDestroyed()) return
  win.loadFile(path.join(app.getAppPath(), 'error.html'), {
    query: { message, log: logTail.join('\n').slice(-12000) },
  })
}

async function showServer(port) {
  log(`加载 http://127.0.0.1:${port}`)
  try {
    await win.loadURL(`http://127.0.0.1:${port}/`)
    watchServer(port)
  } catch (err) {
    log(`loadURL 失败: ${err.message}`)
    showError(`无法加载 DSH 界面: ${err.message}`)
  }
}

let watchTimer = null

/** Poll the loaded port; if the server disappears, offer a retry. */
function watchServer(port) {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = setInterval(() => {
    if (quitting || !win || win.isDestroyed()) return
    probe(port).then((state) => {
      if (state !== 'dsh' && !quitting && win && !win.isDestroyed()) {
        clearInterval(watchTimer)
        watchTimer = null
        showError(`DSH 服务器（http://127.0.0.1:${port}）已停止响应。点击“重试”重新启动。`)
      }
    })
  }, 15_000)
}

async function boot(port) {
  if (booting) return
  booting = true
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  const desired = port ?? FORCED_PORT ?? DEFAULT_PORT
  try {
    if (!win || win.isDestroyed()) createWindow()
    currentPort = await resolveServer(desired)
    await showServer(currentPort)
  } catch (err) {
    log(`启动失败: ${err.message}`)
    showError(`启动失败：${err.message}`)
  } finally {
    booting = false
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'DSH',
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
  })

  const base = () => `http://127.0.0.1:${currentPort ?? FORCED_PORT ?? DEFAULT_PORT}`
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(base())) {
      event.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })
  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    if (code === -3) return // aborted
    log(`页面加载失败 ${code} ${desc} (${url})`)
    showError(`页面加载失败（${code} ${desc}）。`)
  })

  win.loadFile(path.join(app.getAppPath(), 'loading.html'), {
    query: { port: String(FORCED_PORT ?? DEFAULT_PORT) },
  })
}

// ---------------------------------------------------------------------------
// IPC (preload bridge for the loading/error pages)
// ---------------------------------------------------------------------------

ipcMain.on('retry', () => {
  void boot(currentPort ?? FORCED_PORT ?? DEFAULT_PORT)
})
ipcMain.on('open-logs', () => {
  if (logFilePath) shell.openPath(logFilePath)
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    app.setName('DSH')
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    )
    log('==== DSH Desktop 启动 ====')
    log(`electron ${process.versions.electron} / packaged=${app.isPackaged}`)
    void boot()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void boot()
    } else if (win) {
      win.show()
    }
  })

  app.on('window-all-closed', () => {
    // Same mental model as quitting the server manually: close window → quit.
    // Persisted sessions survive in ~/.dsh.
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    if (spawnedByUs && serverChild) {
      event.preventDefault()
      stopServer().finally(() => app.quit())
    }
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
