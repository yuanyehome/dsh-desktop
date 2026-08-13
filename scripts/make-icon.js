'use strict'

/**
 * Renders the DSH favicon SVG onto a DeepSeek-blue rounded background and
 * saves build/icon-1024.png. Run with the Electron binary: `electron scripts/make-icon.js`.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const OUT = path.join(__dirname, '..', 'build', 'icon-1024.png')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })

  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'favicon-source.svg'), 'utf8')
  const html = `<!doctype html>
<html>
<head>
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; overflow: hidden; background: transparent; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #5b7cfa 0%, #4d6bfe 45%, #2447c9 100%);
    border-radius: 228px;
  }
  .logo { width: 600px; height: 600px; }
  .logo svg { width: 600px; height: 600px; display: block; }
  .logo svg path { fill: #ffffff !important; }
</style>
</head>
<body>
  <div class="logo">${svg}</div>
</body>
</html>`

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  // Give the offscreen renderer time to paint.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, image.toPNG())
  console.log('wrote', OUT, image.getSize())
  app.exit(0)
})
