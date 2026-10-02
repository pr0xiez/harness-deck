/**
 * Rasterises build/icon.svg and build/icon-dev.svg:
 *
 *   build/icon.png    1024x1024, also what Linux ships
 *   build/icon.icns   macOS, built on a Mac from an iconset via `iconutil`
 *   build/icon.ico    Windows, PNG-compressed entries from 16px to 256px
 *   build/icon-dev.png / .ico   blue DEV icon for local runs
 *
 * Run with `npm run icons` after editing the SVG. Electron does the drawing —
 * no ImageMagick or librsvg needed — by painting the SVG onto a canvas at each
 * size, which also means the output is exactly what Chromium renders in-app.
 * Use `npm run icons -- --dev-only` to regenerate just the DEV assets.
 */
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const names = process.argv.includes('--dev-only') ? ['icon-dev'] : ['icon', 'icon-dev']

/** macOS wants both @1x and @2x of each; Windows tops out at 256. */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

/** Packs PNG buffers into an .ico container (PNG-compressed entries). */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette size
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 })

  await win.loadURL('data:text/html,<body style="margin:0">')

  /** Draws the SVG at size x size and returns the PNG bytes. */
  const render = async (svg, size) => {
    const b64 = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = c.height = ${size}
          const ctx = c.getContext('2d')
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, 0, 0, ${size}, ${size})
          resolve(c.toDataURL('image/png').split(',')[1])
        }
        img.onerror = () => reject(new Error('svg failed to load'))
        img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(
          Buffer.from(svg).toString('base64')
        )}
      })
    `)
    return Buffer.from(b64, 'base64')
  }

  for (const name of names) {
    const svg = readFileSync(join(BUILD, `${name}.svg`), 'utf8')
    writeFileSync(join(BUILD, `${name}.png`), await render(svg, 1024))
    console.log(`build/${name}.png    1024x1024`)

    const ico = []
    for (const size of ICO_SIZES) ico.push({ size, data: await render(svg, size) })
    writeFileSync(join(BUILD, `${name}.ico`), buildIco(ico))
    console.log(`build/${name}.ico    ${ICO_SIZES.join(', ')}`)

    // Local macOS runs load the DEV PNG directly; only the bundle needs ICNS.
    if (name === 'icon' && process.platform === 'darwin') {
      const iconset = join(BUILD, 'icon.iconset')
      rmSync(iconset, { recursive: true, force: true })
      mkdirSync(iconset, { recursive: true })
      try {
        const pngs = new Map()
        for (const size of ICNS_SIZES) pngs.set(size, await render(svg, size))
        for (const base of [16, 32, 128, 256, 512]) {
          writeFileSync(join(iconset, `icon_${base}x${base}.png`), pngs.get(base))
          writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), pngs.get(base * 2))
        }
        execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD, 'icon.icns')])
        console.log('build/icon.icns       16-1024 @1x/@2x')
      } finally {
        rmSync(iconset, { recursive: true, force: true })
      }
    }
  }

  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
