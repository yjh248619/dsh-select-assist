/**
 * 原生窗口冒烟探针：建窗 → 自绘 → 抓屏 → 存图。
 * 用法：node companion/native/probe.mjs <dshInstallJsPath> <outBmpPath> [x] [y] [scale]
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureScreenRect } from './capture.mjs'
import { createGdi, rgb } from './gdi.mjs'
import { createNativeWindow } from './window.mjs'
import { createWin32, primaryWorkArea, workAreaForPoint, monitorScaleForPoint } from '../win32.mjs'

const hint = process.argv[2]
const out = process.argv[3] ?? join(tmpdir(), 'dsh-selection-probe.bmp')
const anchorX = Number(process.argv[4] ?? 400)
const anchorY = Number(process.argv[5] ?? 300)

const api = createWin32([hint])
if (api === null) { console.log('koffi unavailable'); process.exit(1) }
const gdi = createGdi(api.koffi)
if (!gdi.startup()) { console.log('GdiplusStartup failed'); process.exit(1) }

const scale = monitorScaleForPoint(api, anchorX, anchorY)
const work = workAreaForPoint(api, anchorX, anchorY)
console.log('anchor=' + anchorX + ',' + anchorY + ' scale=' + scale + ' work=' + JSON.stringify(work))

const CSS = { width: 236, height: 104, radius: 20 }
const width = Math.round(CSS.width * scale)
const height = Math.round(CSS.height * scale)
const x = Math.round(anchorX + 8)
const y = Math.round(anchorY + 8)

const win = createNativeWindow({
  api,
  gdi,
  title: 'DSH 划词助手探针',
  initialState: { hover: 0, mode: 'menu' },
  onPaint(painter, w, h, data, windowScale) {
    const s = windowScale
    // 阴影 + 卡片
    painter.fillRoundRect(0, 0, w, h, 20 * s, rgb('#353638'))
    painter.strokeRoundRect(0.5 * s, 0.5 * s, w - s, h - s, 20 * s, rgb('#ffffff', 0x1a), Math.max(1, s))
    const rows = ['DeepSeek Harness 解释', 'DeepSeek Harness 翻译']
    for (let i = 0; i < rows.length; i++) {
      const top = 4 * s + i * 48 * s
      if (data.hover === i) painter.fillRoundRect(4 * s, top, w - 8 * s, 48 * s, 12 * s, rgb('#ffffff', 0x14))
      painter.fillCircle(14 * s, top + 16 * s, 16 * s, rgb('#adb2b8'))
      painter.text(rows[i], 38 * s, top + 12 * s, w - 48 * s, 24 * s, { size: 14 * s, color: rgb('#f9fafb') })
    }
    painter.text('scale=' + s.toFixed(2), 8 * s, h - 16 * s, 200 * s, 14 * s, { size: 11 * s, color: rgb('#81858c') })
  },
  onHitTest: () => 'caption',
  onHover: (hx, hy, data) => {
    if (hx < 0) { const changed = data.hover !== -1; data.hover = -1; return changed }
    const index = hy < 52 ? 0 : 1
    const changed = data.hover !== index
    data.hover = index
    return changed
  },
  onClick: () => false,
  onWheel: () => false,
})

win.create()
win.show(x, y, width, height)
console.log('window shown at ' + x + ',' + y + ' size ' + width + 'x' + height + ' (CSS ' + CSS.width + 'x' + CSS.height + ')')
await new Promise((r) => setTimeout(r, 1200))
const shot = captureScreenRect(api, gdi, x, y, width, height, out)
console.log('captured ' + JSON.stringify(shot))
win.destroy()
gdi.shutdown()
process.exit(0)
