/**
 * LaTeX → GDI+ 的真机预览 + 自查脚本。
 *
 * 为什么非要在真窗口里画：math.mjs 的输出只有数字（子路径/矩形），离线和单测都无法证明
 * 「字形孔洞真的挖出来了、基线真的对」。所以这里开一个原生分层窗口，用真正的
 * painter.fillSubpaths 把 8 条公式画上去，抓屏存图，人眼（和 read_image）过一遍。
 *
 * 用法（必须用 Electron 的 node 模式，否则 koffi 解析不到）：
 *   cd "D:/非项目分组/dsh-select-assist-share/pkg"
 *   ELECTRON_RUN_AS_NODE=1 "D:/dsh/DSH Desktop/DSH Desktop.exe" scripts/math-preview.mjs [outBmp]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { captureScreenRect } from '../companion/native/capture.mjs'
import { createGdi, rgb } from '../companion/native/gdi.mjs'
import { createNativeWindow } from '../companion/native/window.mjs'
import { createWin32, monitorScaleForPoint, workAreaForPoint } from '../companion/win32.mjs'
import { clearMathCache, ensureMathReady, mathStats, renderMath } from '../companion/native/math.mjs'

// Electron 自带的 node 进程里 koffi 只能从 DSH 的 lib 目录解析（插件运行时也走这条路）
const HINT = 'D:/dsh/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js'
const OUT_BMP = process.argv[2] ?? 'D:/非项目分组/math-preview.bmp'
const AT_X = 120
const AT_Y = 120
// 窗口最外圈 1px 会被 DWM 的描边/阴影挤进来（抓屏时是灰度边，不是我们画的白色），
// 抓屏往里缩 1px 再抓，图上就全是窗口自己的像素了
const SHOT_INSET = 1

// 预览用的 8 条：分式、求和、根号、积分、矩阵、复杂下标、黑板体、帽子，覆盖常见的排版分支
const SAMPLE = [
  '\\frac{a}{b}',
  '\\sum_{i=1}^{N} x_i^2',
  '\\sqrt{x^2+y^2}',
  '\\int_0^1 f(x)\\,dx',
  '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}',
  "\\eta_i=\\alpha+x_i'\\beta+u_{r[i]}+\\gamma_{t[i]}",
  '\\mathbb{E}[X]',
  '\\hat{\\beta}_{OLS}',
]

const FONT_SIZE = 16 // CSS px（DIP）
const PAD = 40
const GAP = 26
const LABEL_W = 24
const INK = 0xff1f2328
const GUIDE = 0x209ca3af
const MUTED = 0xff9ca3af
const WHITE = 0xffffffff

const api = createWin32([HINT])
if (api === null) {
  console.log('koffi unavailable')
  process.exit(1)
}
const gdi = createGdi(api.koffi)
if (!gdi.startup()) {
  console.log('GdiplusStartup failed')
  process.exit(1)
}

// ── 1. 懒加载（只测第一次真实的 require+jax 构建）────────────────────────────
const loadStart = performance.now()
const ready = await ensureMathReady()
const loadMs = performance.now() - loadStart
console.log('ensureMathReady=' + ready + ' ' + loadMs.toFixed(1) + 'ms')
if (!ready) {
  console.log('MathJax 未就绪（mathjax-full 没装上？）')
  gdi.shutdown()
  process.exit(1)
}

// ── 2. 性能：30 条互不相同（冷解析）＋ 同样 30 条再来一遍（缓存命中）──────────
const bench = []
for (let i = 0; i < 30; i++) bench.push(SAMPLE[i % SAMPLE.length] + '+n_{' + i + '}')
clearMathCache()
const coldStart = performance.now()
for (const tex of bench) renderMath(tex, { display: true, fontSize: FONT_SIZE })
const coldMs = performance.now() - coldStart
const hitStart = performance.now()
for (const tex of bench) renderMath(tex, { display: true, fontSize: FONT_SIZE })
const hitMs = performance.now() - hitStart
console.log('bench: 30 cold=' + coldMs.toFixed(2) + 'ms (avg ' + (coldMs / 30).toFixed(2) + 'ms/条) 30 cache=' + hitMs.toFixed(2) + 'ms')
console.log('stats: ' + JSON.stringify(mathStats()))

// ── 3. 排版：先算出每条的位置与整窗尺寸，再开窗（onPaint 里只做几何搬运）───────
const items = []
let cursor = PAD
let contentWidth = 0
for (const tex of SAMPLE) {
  const box = renderMath(tex, { display: true, fontSize: FONT_SIZE })
  if (box === null) {
    console.log('RENDER FAILED: ' + tex)
    continue
  }
  const baseline = cursor + box.height
  items.push({ tex, box, baseline })
  cursor = baseline + box.depth + GAP
  contentWidth = Math.max(contentWidth, box.width)
}
if (items.length === 0) {
  console.log('没有可画的公式')
  gdi.shutdown()
  process.exit(1)
}
const cssW = Math.ceil(contentWidth) + PAD * 2 + LABEL_W
const cssH = Math.ceil(cursor - GAP + PAD)

// show() 收物理像素：主屏 150% 时 scale=1.5
const scale = monitorScaleForPoint(api, AT_X, AT_Y) || 1
const work = workAreaForPoint(api, AT_X, AT_Y)
const width = Math.min(Math.round(cssW * scale), work.right - work.left - 24)
const height = Math.min(Math.round(cssH * scale), work.bottom - work.top - 24)
const winX = Math.max(work.left, Math.min(AT_X, work.right - width - 8))
const winY = Math.max(work.top, Math.min(AT_Y, work.bottom - height - 8))
console.log('window css=' + cssW + 'x' + cssH + ' scale=' + scale + ' phys=' + width + 'x' + height + ' at ' + winX + ',' + winY)

// 画布坐标 = 公式坐标 + 左边距；留到 onPaint 里再乘窗口实际 scale，
// 免得 monitorScaleForPoint 和窗口自己的 DPI 不一致时画歪
const originX = PAD + LABEL_W
const guideLeft = originX - 8
const guideRight = originX + contentWidth + 8

const win = createNativeWindow({
  api,
  gdi,
  className: 'DshMathPreview' + Date.now(),
  title: 'math preview',
  initialState: { painted: true },
  minSize: { width: 200, height: 200 },
  onPaint(painter, w, h, data, windowScale) {
    const s = windowScale || 1
    painter.fillRect(0, 0, w, h, WHITE)
    for (let i = 0; i < items.length; i++) {
      const row = items[i]
      const baseline = row.baseline * s
      // 基线参考线：检查「有没有坐偏」最直观的东西，颜色压到很淡不干扰看字形
      painter.fillRect(guideLeft * s, baseline, (guideRight - guideLeft) * s, Math.max(1, s * 0.5), GUIDE)
      painter.text(String(i + 1), PAD * s, baseline - 12 * s, LABEL_W * s, 14 * s, {
        size: 11 * s,
        color: MUTED,
      })
      // 整条公式一次填充（FillModeWinding），孔洞靠子路径方向挖出来
      const subpaths = row.box.subpaths.map((subpath) => ({
        closed: subpath.closed,
        fill: subpath.fill,
        points: subpath.points.map(([x, y]) => [x * s + originX * s, y * s + baseline]),
      }))
      painter.fillSubpaths(subpaths, INK)
      for (const r of row.box.rects) painter.fillRect(r.x + originX * s, r.y + baseline, r.w, r.h, INK)
    }
  },
})

win.create()
win.show(winX, winY, width, height)

// ── 4. 等窗口真正画出来再抓屏（分层窗口第一帧可能还没提交）────────────────────
await new Promise((r) => setTimeout(r, 500))
const shotX = winX + SHOT_INSET
const shotY = winY + SHOT_INSET
const shotW = width - SHOT_INSET * 2
const shotH = height - SHOT_INSET * 2
let shot = captureScreenRect(api, gdi, shotX, shotY, shotW, shotH, OUT_BMP)
if (shot === null) {
  console.log('capture failed')
  win.destroy()
  gdi.shutdown()
  process.exit(1)
}
// 全白说明这一帧没画上：再等一会儿补拍一次
if (inkRatio(OUT_BMP) < 0.002) {
  await new Promise((r) => setTimeout(r, 600))
  shot = captureScreenRect(api, gdi, shotX, shotY, shotW, shotH, OUT_BMP)
}
const ink = inkRatio(OUT_BMP)
console.log('captured ' + JSON.stringify(shot) + ' ink=' + (ink * 100).toFixed(2) + '%')

for (const item of items) {
  const box = item.box
  console.log(
    '  ' + item.tex.padEnd(28) + ' w=' + box.width.toFixed(1) +
      ' h=' + box.height.toFixed(1) + ' d=' + box.depth.toFixed(1) +
      ' paths=' + box.subpaths.length + ' rects=' + box.rects.length,
  )
}

win.destroy()
gdi.shutdown()
process.exit(0)

/** BMP（32bpp 顶朝下/底朝下都能读）里非白像素占比：用来判断「是不是空白一帧」。 */
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
