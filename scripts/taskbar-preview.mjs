/**
 * 「最小化到任务栏」真机验证：
 *  1. 建一扇和回答窗同款的原生窗口并显示，抓一张任务栏基线图；
 *  2. 调 minimizeToTaskbar()，确认窗口真的被系统最小化（IsIconic）、
 *     扩展样式从 TOOLWINDOW 换成了 APPWINDOW（任务栏才会出现按钮），再抓任务栏图；
 *  3. restoreFromTaskbar()，确认回来了，抓第三张任务栏图（按钮应该消失）；
 *  4. 输出 PASS/FAIL。
 *
 * 用法（必须用 Electron 的 node 模式，否则 koffi 解析不到）：
 *   cd "D:/非项目分组/dsh-select-assist-share/pkg"
 *   ELECTRON_RUN_AS_NODE=1 "D:/dsh/DSH Desktop/DSH Desktop.exe" scripts/taskbar-preview.mjs
 */
import { captureScreenRect } from '../companion/native/capture.mjs'
import { createGdi } from '../companion/native/gdi.mjs'
import { createNativeWindow } from '../companion/native/window.mjs'
import { createWin32, monitorScaleForPoint, primaryWorkArea } from '../companion/win32.mjs'
import { MODES, paintPanel } from '../companion/native/ui.mjs'

const HINT = 'D:/dsh/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const HINT_FALLBACK = 'D:/dsh/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js'
const OUT_DIR = 'D:/非项目分组'
const WHITE = 0xffffffff
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_APPWINDOW = 0x00040000

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

const state = {
  mode: 'panel',
  dark: false,
  hover: null,
  hoverButton: null,
  action: 'translate',
  source: '多窗口并存与最小化到任务栏的验收文本。',
  context: '',
  answer: '## 验收\n窗口被系统最小化后，任务栏应该出现一个按钮；点它能回来。',
  status: 'done',
  error: '',
  copyFeedback: '',
  scroll: 0,
  contentHeight: 0,
  viewHeight: 0,
  stopBox: null,
  minimized: false,
  taskbarMinimized: false,
}

const winX = 240
const winY = 160
const scale = monitorScaleForPoint(api, winX, winY) || 1
const width = Math.round(MODES.panel.width * scale)
const height = Math.round(MODES.panel.height * scale)
const win = createNativeWindow({
  api,
  gdi,
  className: 'DshTaskbarPreview' + Date.now(),
  title: 'DSH 划词助手 · 翻译（任务栏验收）',
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
await sleep(500)
const hwnd = win.state.hwnd
const work = primaryWorkArea(api)
const barFile = (name) => OUT_DIR + '/taskbar-' + name + '.bmp'
const shotBar = (name) =>
  captureScreenRect(api, gdi, work.left, work.bottom, work.right - work.left, Math.round(80 * scale), barFile(name))

console.log('before ' + JSON.stringify(readWindowState()))
console.log('bar-before=' + JSON.stringify(shotBar('before')))

const minimized = win.minimizeToTaskbar()
await sleep(1000)
const during = readWindowState()
console.log('during ' + JSON.stringify(during) + ' minimizeToTaskbar()=' + minimized)
console.log('bar-minimized=' + JSON.stringify(shotBar('minimized')))

const restored = win.restoreFromTaskbar()
await sleep(1000)
const after = readWindowState()
console.log('after ' + JSON.stringify(after) + ' restoreFromTaskbar()=' + restored)
console.log('bar-restored=' + JSON.stringify(shotBar('restored')))

win.destroy()
gdi.shutdown()
const ok = during.iconic === true && during.toolwindow === false && during.appwindow === true && after.iconic === false
console.log(ok ? 'PASS: 真的最小化到了任务栏并能回来' : 'FAIL: 看上面的状态')
process.exit(ok ? 0 : 1)

function readWindowState() {
  const ex = Number(api.GetWindowLongPtrW(hwnd, -20))
  return {
    iconic: api.IsIconic(hwnd) === true,
    toolwindow: (ex & WS_EX_TOOLWINDOW) !== 0,
    appwindow: (ex & WS_EX_APPWINDOW) !== 0,
    isTaskbarMinimized: win.isTaskbarMinimized() === true,
    exStyle: '0x' + (ex >>> 0).toString(16),
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
