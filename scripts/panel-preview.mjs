/**
 * 回答窗渲染真机预览：把一份「带行内公式 + 独立公式块 + 粗体/列表」的 Markdown 文本
 * 交给真正的 paintPanel 画出来，抓屏存 BMP，用来人眼验收公式排版。
 *
 * 用法（必须用 Electron 的 node 模式，否则 koffi 解析不到）：
 *   cd "D:/非项目分组/dsh-select-assist-share/pkg"
 *   ELECTRON_RUN_AS_NODE=1 "D:/dsh/DSH Desktop/DSH Desktop.exe" scripts/panel-preview.mjs [outBmp]
 */
import { readFileSync } from 'node:fs'

import { captureScreenRect } from '../companion/native/capture.mjs'
import { createGdi } from '../companion/native/gdi.mjs'
import { createNativeWindow } from '../companion/native/window.mjs'
import { createWin32, monitorScaleForPoint, workAreaForPoint } from '../companion/win32.mjs'
import { ensureMathReady } from '../companion/native/math.mjs'
import { MODES, paintPanel } from '../companion/native/ui.mjs'

const HINT = 'D:/dsh/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const HINT_FALLBACK = 'D:/dsh/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js'
const OUT_BMP = process.argv[2] ?? 'D:/非项目分组/panel-preview.bmp'
const AT_X = 160
const AT_Y = 120
const SHOT_INSET = 1
const WHITE = 0xffffffff

const ANSWER = [
  '## 模型设定',
  '这是**加权的伪后验**，其中 $w_i^*$ 是缩尾后的权重：',
  '$$w_i^* = N \\cdot \\frac{w_i^{win}}{\\sum_{j=1}^{N} w_j^{win}}$$',
  '- 第一行：$\\eta_i = \\alpha + x_i\'\\beta + u_{r[i]} + \\gamma_{t[i]}$。',
  '- 第二行：随机截距 $u_r \\sim \\mathcal{N}(0, \\sigma_u^2)$，相关系数 $\\rho = 0.42$。',
  '**固定效应**与随机效应的区别见下表：',
  '| 项目 | 固定 | 随机 |',
  '| --- | --- | --- |',
  '| 参数 | $\\beta$ | $u_r$ |',
  '普通段落：$\\hat{\\beta}_{OLS} = (X^\\top X)^{-1} X^\\top y$，以及 $\\sqrt{x^2+y^2}$。',
].join('\n')

const api = createWin32([HINT, HINT_FALLBACK])
if (api === null) {
  console.log('koffi unavailable')
  process.exit(1)
}
const gdi = createGdi(api.koffi)
if (!gdi.startup()) {
  console.log('GdiplusStartup failed')
  process.exit(1)
}
const ready = await ensureMathReady()
console.log('ensureMathReady=' + ready)
if (!ready) {
  gdi.shutdown()
  process.exit(1)
}

const state = {
  mode: 'panel',
  dark: false,
  hover: null,
  hoverButton: null,
  action: 'explain',
  source: "\\eta_i = \\alpha + x_i'\\beta + u_{r[i]} + \\gamma_{t[i]}",
  context: '',
  answer: ANSWER,
  status: 'done',
  error: '',
  copyFeedback: '',
  scroll: 0,
  contentHeight: 0,
  viewHeight: 0,
  stopBox: null,
  minimized: false,
}

const scale = monitorScaleForPoint(api, AT_X, AT_Y) || 1
const work = workAreaForPoint(api, AT_X, AT_Y)
const cssW = MODES.panel.width
const cssH = MODES.panel.height
const width = Math.round(cssW * scale)
const height = Math.round(cssH * scale)
const winX = Math.max(work.left, Math.min(AT_X, work.right - width - 8))
const winY = Math.max(work.top, Math.min(AT_Y, work.bottom - height - 8))
console.log('window css=' + cssW + 'x' + cssH + ' scale=' + scale + ' phys=' + width + 'x' + height + ' at ' + winX + ',' + winY)

const win = createNativeWindow({
  api,
  gdi,
  className: 'DshPanelPreview' + Date.now(),
  title: 'panel preview',
  initialState: state,
  minSize: { width: 260, height: 200 },
  onPaint(painter, w, h, data, windowScale) {
    painter.fillRect(0, 0, w, h, WHITE)
    const st = { ...data }
    paintPanel(painter, w, h, st, windowScale || 1)
    data.contentHeight = st.contentHeight
    data.viewHeight = st.viewHeight
  },
})

win.create()
win.show(winX, winY, width, height)
await new Promise((r) => setTimeout(r, 500))
const shot = captureScreenRect(api, gdi, winX + SHOT_INSET, winY + SHOT_INSET, width - SHOT_INSET * 2, height - SHOT_INSET * 2, OUT_BMP)
console.log('captured ' + JSON.stringify(shot) + ' ink=' + (inkRatio(OUT_BMP) * 100).toFixed(2) + '%')
win.destroy()
gdi.shutdown()
process.exit(shot === null ? 1 : 0)

function inkRatio(file) {
  try {
    const buf = readFileSync(file)
    const offset = buf.readUInt32LE(10)
    const px = buf.length - offset
    if (px <= 0) return 0
    let ink = 0
    for (let i = offset; i + 3 < buf.length; i += 4) {
      if (buf[i] < 245 || buf[i + 1] < 245 || buf[i + 2] < 245) ink += 1
    }
    return ink / (px / 4)
  } catch {
    return 0
  }
}
