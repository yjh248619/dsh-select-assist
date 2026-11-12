/**
 * LaTeX 公式 → GDI+ 矢量绘制。
 *
 * 为什么借 MathJax 的 SVG 输出：TeX 的分式/根号/矩阵/上下标排版规则极多，自己写必然
 * 出错；而 MathJax 输出的 SVG 里只有 <path>/<rect>，把坐标读出来交给 GDI+ 填充，既保留
 * "原生窗口、不开浏览器"的前提，又能拿到真正的字形轮廓（不是拿字体凑）。
 *
 * 坐标约定：MathJax 的 viewBox 单位是 1/1000 em，根 <g> 的 scale(1,-1) 已经把 TeX 的
 * y-up 翻成屏幕的 y-down，基线正好是 y=0。所以最终像素 = viewBox 单位 × fontSize/1000，
 * 且 px=(x-minX)*s、py=y*s。
 *
 * 关键约束：字形里的孔洞（a/e/o 中间那块）只有在**一次** FillPath 里按 winding 规则
 * 填充才正确，所以整条公式被压成若干独立闭合子路径，交给 gdi.painterFromHdc().fillSubpaths。
 *
 * 性能：mathjax-full 只在第一次真正需要渲染时懒加载（require 全套约 365ms），加载期间
 * renderMath 立刻返回 null，绝不卡住窗口绘制。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 缓存上限：一次会话里出现过的公式不会太多，300 条足够，且能挡住重绘时的重复解析。 */
const CACHE_LIMIT = 300
/** 曲线压平误差（像素）。0.25px 在 200% 缩放下也看不出折线。 */
const FLATNESS = 0.25
/** 对半拆分的层数上限（正常 3~4 层就收敛，这里只做防御，避免坏数据把递归打爆）。 */
const MAX_DEPTH = 12
/** 渲染失败也进缓存：否则一条坏 TeX 会在每一帧重试一次 ~30ms 的解析。 */
const FAILED = Symbol('math-failed')
const IDENTITY = [1, 0, 0, 1, 0, 0]
/** 不产生几何的标签：<use>/<defs> 在 fontCache:'none' 下本来就不会出现，这里只是兜底。 */
const SKIPPED = new Set(['defs', 'symbol', 'use', 'clipPath', 'mask', 'pattern', 'text'])

let ready = false
let loading = null
let scheduled = false
let loadFailed = false
let jaxDocument = null
let lastMs = 0
const cache = new Map()

/** MathJax 是否已就绪（ui.mjs 用它决定这一帧要不要画公式）。 */
export function isMathReady() {
  return ready
}

/**
 * 懒加载 MathJax（幂等 + 并发安全：并发调用共享同一个 Promise）。
 * 失败返回 false，绝不抛——渲染路径不该因为依赖没装好而崩掉整个浮层。
 */
export async function ensureMathReady() {
  if (ready) return true
  if (loading !== null) return loading
  // 显式调用视为「再试一次」：上次失败后装上了依赖也能捡回来
  loadFailed = false
  loading = (async () => {
    try {
      ready = await loadMathJax()
      return ready
    } catch {
      return false
    } finally {
      // 失败后清掉 Promise，下次调用还能重试（比如依赖刚装上）；成功则后续走 ready 快路径
      if (!ready) loading = null
    }
  })()
  return loading
}

/**
 * 把懒加载推到下一个宏任务。渲染路径里必须这么干：require 全套 MathJax 是同步的 ~350ms，
 * 直接在 onPaint 里做会把这一帧卡住（用户看到浮层先白一下）。
 */
function scheduleLoad() {
  if (scheduled || ready || loadFailed) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    void ensureMathReady().then((ok) => {
      if (!ok) loadFailed = true
    })
  }, 0)
}

/**
 * 渲染一条 TeX，同步返回几何；未就绪/解析失败都返回 null（并已把失败写进缓存）。
 * @param {string} tex - TeX 源码；带 $…$ / \[…\] 定界符也行（会自动剥掉）
 * @param {{display?: boolean, fontSize?: number}} [options]
 * @returns {{width:number, height:number, depth:number, subpaths:Array, rects:Array, tex:string, display:boolean, fontSize:number}|null}
 */
export function renderMath(tex, options = {}) {
  // 只接受字符串/数字：别的类型 String() 出来是 "[object Object]" 这种垃圾，画出来更糟
  const raw = typeof tex === 'string' ? tex : typeof tex === 'number' && Number.isFinite(tex) ? String(tex) : ''
  // 划词时经常把定界符一起选中（$x^2$ / \[x\]），这里顺手剥掉，免得画出一串字面量 $
  const source = unwrapDelimiters(raw)
  if (source === '') return null
  const display = options.display === true
  const fontSize = Number.isFinite(options.fontSize) && options.fontSize > 0 ? Number(options.fontSize) : 12.5
  const key = (display ? '1' : '0') + '|' + fontSize + '|' + source
  const cached = cache.get(key)
  if (cached !== undefined) {
    // 命中就挪到队尾：Map 的插入顺序即 LRU 顺序
    cache.delete(key)
    cache.set(key, cached)
    return cached === FAILED ? null : cached
  }
  if (!ready) {
    // 放个宏任务再加载：require MathJax 是同步的 ~350ms，直接在渲染帧里做会把这一帧卡住。
    // 用 setTimeout 而不是 void ensureMathReady()，是为了让当前这次 onPaint 先画完。
    scheduleLoad()
    return null
  }
  const started = performance.now()
  let box = null
  try {
    const node = jaxDocument.convert(source, { display })
    box = buildBox(node, source, display, fontSize)
  } catch {
    box = null
  }
  lastMs = performance.now() - started
  remember(key, box === null ? FAILED : box)
  return box
}

/** 清空缓存（改字号/换主题后想强制重算时用）。 */
export function clearMathCache() {
  cache.clear()
}

/** 运行状态：是否就绪、缓存条数、最近一次真实解析耗时。 */
export function mathStats() {
  return { ready, entries: cache.size, lastMs }
}

// ── 加载 ────────────────────────────────────────────────────────────────────

/** 在给定的 require 作用域里把 MathJax 的入口模块全部取出来。 */
function requireMathJax(require) {
  return {
    mathjax: require('mathjax-full/js/mathjax.js').mathjax,
    TeX: require('mathjax-full/js/input/tex.js').TeX,
    SVG: require('mathjax-full/js/output/svg.js').SVG,
    liteAdaptor: require('mathjax-full/js/adaptors/liteAdaptor.js').liteAdaptor,
    RegisterHTMLHandler: require('mathjax-full/js/handlers/html.js').RegisterHTMLHandler,
    AllPackages: require('mathjax-full/js/input/tex/AllPackages.js').AllPackages,
  }
}

/**
 * 候选 require 位置：先插件自己的 node_modules，再本机解包目录（离线/装不上时的兜底）。
 * 用 createRequire 而不是 import()，因为 mathjax-full 3.2.1 是 CJS 包。
 */
function requireCandidates() {
  const out = [import.meta.url]
  const here = fileURLToPath(new URL('.', import.meta.url))
  const dirs = [process.env.DSH_MATHJAX_DIR, '../../../../.tmp-mj']
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir === '') continue
    try {
      // 环境变量给的是绝对路径；相对路径按本文件位置解析成 .tmp-mj 这类解包目录
      out.push(join(dir.startsWith('.') ? here : dir, 'noop.js'))
    } catch {
      /* 路径不合法就跳过这个候选 */
    }
  }
  return out
}

/** 建 jax（只建一次）。任何候选位置成功即返回 true。 */
async function loadMathJax() {
  for (const base of requireCandidates()) {
    try {
      const require = createRequire(base)
      const modules = requireMathJax(require)
      const adaptor = modules.liteAdaptor()
      modules.RegisterHTMLHandler(adaptor)
      // formatError 默认把错消息排成红字塞进输出里；我们宁可让 convert 直接抛，
      // 由 renderMath 统一兜成 null，上层好回落到原文显示
      const tex = new modules.TeX({
        packages: modules.AllPackages,
        formatError: () => {
          throw new Error('tex-error')
        },
      })
      // fontCache:'none'：字形直接内联成 <path>，不会出现 <defs>/<use> 需要跳转
      const svg = new modules.SVG({ fontCache: 'none' })
      jaxDocument = modules.mathjax.document('', { InputJax: tex, OutputJax: svg })
      return jaxDocument !== null
    } catch {
      /* 换下一个候选位置 */
    }
  }
  return false
}

// ── 缓存 ────────────────────────────────────────────────────────────────────

/**
 * 剥掉公式外侧的定界符（$…$ / $$…$$ / \(…\) / \[…\]）。
 * 划词选中的往往带定界符，直接喂给 TeX 会把 $ 当成普通字符画出来。
 */
function unwrapDelimiters(text) {
  const trimmed = text.trim()
  const pairs = [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['$', '$'],
  ]
  for (const [open, close] of pairs) {
    if (trimmed.length > open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      const inner = trimmed.slice(open.length, trimmed.length - close.length).trim()
      if (inner !== '') return inner
    }
  }
  return trimmed
}

function remember(key, value) {
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) return
    cache.delete(oldest.value)
  }
}

// ── 几何：SVG 树 → Box ──────────────────────────────────────────────────────

/**
 * 把 mjx-container 里的 <svg> 走一遍，攒出子路径与矩形。
 * @returns {object|null} Box；没有可画的几何时返回 null。
 */
function buildBox(container, tex, display, fontSize) {
  const svg = findNode(container, 'svg')
  if (svg === null) return null
  const attributes = svg.attributes ?? {}
  const viewBox = parseViewBox(attributes.viewBox)
  if (viewBox === null) return null
  const [minX, minY, vbWidth, vbHeight] = viewBox
  if (!(vbWidth > 0) || !(vbHeight > 0)) return null
  const s = fontSize / 1000
  // viewBox 单位 → 像素：x 平移到 0 起，y 以基线为 0 向下为正
  const toPixels = [s, 0, 0, s, -minX * s, 0]
  const root = typeof attributes.transform === 'string' ? multiply(toPixels, parseTransform(attributes.transform)) : toPixels
  const geometry = { subpaths: [], rects: [], error: false }
  walk(svg, root, geometry)
  // merror：坏 TeX 会被 MathJax 排成红字错误说明，画出来比不画更难看
  if (geometry.error) return null
  if (geometry.subpaths.length === 0 && geometry.rects.length === 0) return null
  return {
    width: vbWidth * s,
    height: Math.max(0, -minY * s),
    depth: Math.max(0, (minY + vbHeight) * s),
    subpaths: geometry.subpaths,
    rects: geometry.rects,
    tex,
    display,
    fontSize,
  }
}

function findNode(node, kind) {
  if (node === null || typeof node !== 'object') return null
  if (node.kind === kind) return node
  const children = node.children
  if (!Array.isArray(children)) return null
  for (const child of children) {
    const found = findNode(child, kind)
    if (found !== null) return found
  }
  return null
}

function parseViewBox(text) {
  if (typeof text !== 'string') return null
  const parts = text.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  return parts
}

/** 递归累积仿射变换（lite 节点：kind=标签名，attributes=普通对象）。 */
function walk(node, matrix, geometry) {
  if (node === null || typeof node !== 'object') return
  const kind = node.kind
  if (typeof kind !== 'string' || SKIPPED.has(kind)) return
  const attributes = node.attributes ?? {}
  // 坏 TeX 的第二种表现：未定义命令不走 formatError，会被排成红色 mtext 错误说明。
  // 只认 mtext（\color{red} 之类给的是 mstyle），避免把合法的彩色公式当成错误
  const isErrorText = attributes['data-mml-node'] === 'mtext' && (attributes.fill === 'red' || attributes.stroke === 'red')
  if (attributes['data-mml-node'] === 'merror' || isErrorText) {
    geometry.error = true
    return
  }
  const transform = attributes.transform
  const local = typeof transform === 'string' ? multiply(matrix, parseTransform(transform)) : matrix
  if (kind === 'path') {
    const fill = attributes.fill
    if (fill === 'none' || fill === 'transparent') return
    if (typeof attributes.d === 'string' && attributes.d !== '') addPathData(attributes.d, local, geometry)
    return
  }
  if (kind === 'rect') {
    addRect(attributes, local, geometry)
    return
  }
  const children = node.children
  if (Array.isArray(children)) {
    for (const child of children) walk(child, local, geometry)
  }
}

/** <rect>：四角变换后取包围盒（MathJax 只会用平移/缩放，包围盒即真矩形）。 */
function addRect(attributes, matrix, geometry) {
  const x = Number(attributes.x ?? 0)
  const y = Number(attributes.y ?? 0)
  const w = Number(attributes.width ?? 0)
  const h = Number(attributes.height ?? 0)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return
  if (!(w > 0) || !(h > 0)) return
  const corners = [applyMatrix(matrix, x, y), applyMatrix(matrix, x + w, y), applyMatrix(matrix, x + w, y + h), applyMatrix(matrix, x, y + h)]
  const left = Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0])
  const right = Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0])
  const top = Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1])
  const bottom = Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1])
  if (!(right > left) || !(bottom > top)) return
  geometry.rects.push({ x: left, y: top, w: right - left, h: bottom - top })
}

// ── 仿射变换 ────────────────────────────────────────────────────────────────

/** 复合：先 inner 后 outer（SVG transform="A B" 的含义）。 */
function multiply(outer, inner) {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ]
}

function applyMatrix(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
}

const TRANSFORM_PATTERN = /([a-zA-Z]+)\s*\(([^)]*)\)/g

/** 解析 transform 串（translate/scale/matrix/rotate/skew），支持多个函数串联。 */
function parseTransform(text) {
  let matrix = IDENTITY
  if (typeof text !== 'string' || text === '') return matrix
  TRANSFORM_PATTERN.lastIndex = 0
  let match = TRANSFORM_PATTERN.exec(text)
  while (match !== null) {
    const name = match[1]
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((value) => Number.isFinite(value))
    matrix = multiply(matrix, transformOne(name, args))
    match = TRANSFORM_PATTERN.exec(text)
  }
  return matrix
}

function transformOne(name, args) {
  switch (name) {
    case 'translate':
      return [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]
    case 'scale': {
      const sx = args[0] ?? 1
      return [sx, 0, 0, args.length > 1 ? args[1] : sx, 0, 0]
    }
    case 'matrix':
      return args.length >= 6 ? args.slice(0, 6) : IDENTITY
    case 'rotate': {
      const angle = ((args[0] ?? 0) * Math.PI) / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const rotation = [cos, sin, -sin, cos, 0, 0]
      if (args.length < 3) return rotation
      const cx = args[1]
      const cy = args[2]
      return multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy])
    }
    case 'skewX':
      return [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
    case 'skewY':
      return [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
    default:
      return IDENTITY
  }
}

// ── path ────────────────────────────────────────────────────────────────────

const PATH_TOKEN = /([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g

function pathTokens(d) {
  const tokens = []
  PATH_TOKEN.lastIndex = 0
  let match = PATH_TOKEN.exec(d)
  while (match !== null) {
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]))
    match = PATH_TOKEN.exec(d)
  }
  return tokens
}

/**
 * 解析一条 d 并压平成像素折线。
 *
 * 控制点在**变换到像素坐标之后**才细分：误差判据用的是最终像素误差，这样小字号
 * （整体缩小）也不会被过度细分，大字号也不会欠采样。
 */
function addPathData(d, matrix, geometry) {
  const tokens = pathTokens(d)
  let index = 0
  let command = null
  let subpath = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let controlX = 0
  let controlY = 0
  let previous = ''

  const number = () => {
    const value = tokens[index]
    if (typeof value !== 'number') return NaN
    index += 1
    return value
  }
  const join = (px, py) => {
    const point = applyMatrix(matrix, px, py)
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return
    if (subpath !== null) subpath.points.push(point)
  }
  const endSubpath = () => {
    if (subpath !== null && subpath.points.length >= 2) geometry.subpaths.push(subpath)
    subpath = null
  }
  const beginSubpath = (px, py) => {
    endSubpath()
    // fill 恒为 true：fill="none" 的路径在 walk() 里就被丢掉了，能走到这里的都是要填充的字形
    subpath = { points: [], closed: false, fill: true }
    join(px, py)
    startX = px
    startY = py
  }
  const ensureSubpath = () => {
    if (subpath === null) beginSubpath(x, y)
  }
  const line = (px, py) => {
    ensureSubpath()
    join(px, py)
    x = px
    y = py
  }
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    ensureSubpath()
    const p0 = applyMatrix(matrix, x, y)
    const p1 = applyMatrix(matrix, x1, y1)
    const p2 = applyMatrix(matrix, x2, y2)
    const p3 = applyMatrix(matrix, x3, y3)
    flattenCubic(subpath.points, p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], 0)
    x = x3
    y = y3
  }
  // 二次贝塞尔升阶成三次（精确等价），这样只需维护一套压平逻辑
  const quadratic = (qx, qy, x3, y3) => {
    cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3), x3, y3)
  }
  const arc = (rx, ry, rotation, largeArc, sweep, x3, y3) => {
    ensureSubpath()
    for (const segment of arcToCubics(x, y, rx, ry, rotation, largeArc, sweep, x3, y3)) {
      cubic(segment[0], segment[1], segment[2], segment[3], segment[4], segment[5])
    }
    x = x3
    y = y3
  }

  parse: while (index < tokens.length) {
    const token = tokens[index]
    if (typeof token === 'string') {
      command = token
      index += 1
      if (command === 'Z' || command === 'z') {
        if (subpath !== null) subpath.closed = true
        endSubpath()
        x = startX
        y = startY
        previous = 'Z'
        command = null
      }
      continue
    }
    if (command === null) {
      index += 1
      continue
    }
    const upper = command.toUpperCase()
    const relative = command !== upper
    switch (upper) {
      case 'M': {
        const px = number()
        const py = number()
        if (!Number.isFinite(px) || !Number.isFinite(py)) break parse
        const ax = relative ? x + px : px
        const ay = relative ? y + py : py
        beginSubpath(ax, ay)
        x = ax
        y = ay
        // 规范：M 之后连续的坐标对按 lineto 处理
        command = relative ? 'l' : 'L'
        previous = 'M'
        break
      }
      case 'L': {
        const px = number()
        const py = number()
        if (!Number.isFinite(px) || !Number.isFinite(py)) break parse
        line(relative ? x + px : px, relative ? y + py : py)
        previous = 'L'
        break
      }
      case 'H': {
        const px = number()
        if (!Number.isFinite(px)) break parse
        line(relative ? x + px : px, y)
        previous = 'H'
        break
      }
      case 'V': {
        const py = number()
        if (!Number.isFinite(py)) break parse
        line(x, relative ? y + py : py)
        previous = 'V'
        break
      }
      case 'C': {
        const x1 = number()
        const y1 = number()
        const x2 = number()
        const y2 = number()
        const x3 = number()
        const y3 = number()
        if (![x1, y1, x2, y2, x3, y3].every(Number.isFinite)) break parse
        // 相对坐标要基于**调用前**的当前点换算，cubic 会改 x/y
        const c1x = relative ? x + x1 : x1
        const c1y = relative ? y + y1 : y1
        const c2x = relative ? x + x2 : x2
        const c2y = relative ? y + y2 : y2
        cubic(c1x, c1y, c2x, c2y, relative ? x + x3 : x3, relative ? y + y3 : y3)
        controlX = c2x
        controlY = c2y
        previous = 'C'
        break
      }
      case 'S': {
        const x2 = number()
        const y2 = number()
        const x3 = number()
        const y3 = number()
        if (![x2, y2, x3, y3].every(Number.isFinite)) break parse
        const c2x = relative ? x + x2 : x2
        const c2y = relative ? y + y2 : y2
        const c1x = previous === 'C' || previous === 'S' ? 2 * x - controlX : x
        const c1y = previous === 'C' || previous === 'S' ? 2 * y - controlY : y
        cubic(c1x, c1y, c2x, c2y, relative ? x + x3 : x3, relative ? y + y3 : y3)
        controlX = c2x
        controlY = c2y
        previous = 'S'
        break
      }
      case 'Q': {
        const qx = number()
        const qy = number()
        const x3 = number()
        const y3 = number()
        if (![qx, qy, x3, y3].every(Number.isFinite)) break parse
        const ax = relative ? x + qx : qx
        const ay = relative ? y + qy : qy
        quadratic(ax, ay, relative ? x + x3 : x3, relative ? y + y3 : y3)
        controlX = ax
        controlY = ay
        previous = 'Q'
        break
      }
      case 'T': {
        const x3 = number()
        const y3 = number()
        if (!Number.isFinite(x3) || !Number.isFinite(y3)) break parse
        const qx = previous === 'Q' || previous === 'T' ? 2 * x - controlX : x
        const qy = previous === 'Q' || previous === 'T' ? 2 * y - controlY : y
        quadratic(qx, qy, relative ? x + x3 : x3, relative ? y + y3 : y3)
        controlX = qx
        controlY = qy
        previous = 'T'
        break
      }
      case 'A': {
        const rx = number()
        const ry = number()
        const rotation = number()
        const largeArc = number()
        const sweep = number()
        const x3 = number()
        const y3 = number()
        if (![rx, ry, rotation, largeArc, sweep, x3, y3].every(Number.isFinite)) break parse
        arc(rx, ry, rotation, largeArc !== 0, sweep !== 0, relative ? x + x3 : x3, relative ? y + y3 : y3)
        previous = 'A'
        break
      }
      default:
        index += 1
        command = null
        break
    }
  }
  endSubpath()
}

/**
 * 三次贝塞尔自适应压平：控制点到弦的距离和即误差上界，不满足就 de Casteljau 对半拆。
 * 只把后续点追加进 points（起点已在里面）。
 */
function flattenCubic(points, x0, y0, x1, y1, x2, y2, x3, y3, depth) {
  if (depth >= MAX_DEPTH || isFlatCubic(x0, y0, x1, y1, x2, y2, x3, y3)) {
    points.push([x3, y3])
    return
  }
  const x01 = (x0 + x1) / 2
  const y01 = (y0 + y1) / 2
  const x12 = (x1 + x2) / 2
  const y12 = (y1 + y2) / 2
  const x23 = (x2 + x3) / 2
  const y23 = (y2 + y3) / 2
  const x012 = (x01 + x12) / 2
  const y012 = (y01 + y12) / 2
  const x123 = (x12 + x23) / 2
  const y123 = (y12 + y23) / 2
  const midX = (x012 + x123) / 2
  const midY = (y012 + y123) / 2
  flattenCubic(points, x0, y0, x01, y01, x012, y012, midX, midY, depth + 1)
  flattenCubic(points, midX, midY, x123, y123, x23, y23, x3, y3, depth + 1)
}

function isFlatCubic(x0, y0, x1, y1, x2, y2, x3, y3) {
  const dx = x3 - x0
  const dy = y3 - y0
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= FLATNESS * FLATNESS) {
    // 弦近乎退化成一个点：只看两个控制点离起点够不够近
    return Math.hypot(x1 - x0, y1 - y0) <= FLATNESS && Math.hypot(x2 - x0, y2 - y0) <= FLATNESS
  }
  const d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx)
  const d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx)
  return (d1 + d2) * (d1 + d2) <= FLATNESS * FLATNESS * lengthSquared
}

/**
 * SVG 椭圆弧（端点式参数）→ 若干三次贝塞尔段（每段 ≤90°）。
 * 返回 [[c1x,c1y,c2x,c2y,x,y], ...]（局部坐标）。
 */
function arcToCubics(x0, y0, rx, ry, rotation, largeArc, sweep, x1, y1) {
  if (!(rx > 0) || !(ry > 0)) return [[x1, y1, x1, y1, x1, y1]]
  const phi = (((rotation % 360) * Math.PI) / 180) % (Math.PI * 2)
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const halfDx = (x0 - x1) / 2
  const halfDy = (y0 - y1) / 2
  const xp = cosPhi * halfDx + sinPhi * halfDy
  const yp = -sinPhi * halfDx + cosPhi * halfDy
  // 半径不够长时按规范等比放大
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  let radiusX = rx
  let radiusY = ry
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    radiusX *= scale
    radiusY *= scale
  }
  const rx2 = radiusX * radiusX
  const ry2 = radiusY * radiusY
  const denominator = rx2 * yp * yp + ry2 * xp * xp
  let numerator = rx2 * ry2 - rx2 * yp * yp - ry2 * xp * xp
  if (numerator < 0) numerator = 0
  let coefficient = denominator === 0 ? 0 : Math.sqrt(numerator / denominator)
  if (largeArc === sweep) coefficient = -coefficient
  const cxp = (coefficient * radiusX * yp) / radiusY
  const cyp = (-coefficient * radiusY * xp) / radiusX
  const centerX = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2
  const centerY = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2
  const angleOf = (ux, uy, vx, vy) => {
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    if (length === 0) return 0
    const cosine = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / length))
    const sign = ux * vy - uy * vx < 0 ? -1 : 1
    return sign * Math.acos(cosine)
  }
  const startAngle = angleOf(1, 0, (xp - cxp) / radiusX, (yp - cyp) / radiusY)
  let delta = angleOf((xp - cxp) / radiusX, (yp - cyp) / radiusY, (-xp - cxp) / radiusX, (-yp - cyp) / radiusY)
  if (!sweep && delta > 0) delta -= Math.PI * 2
  if (sweep && delta < 0) delta += Math.PI * 2
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
  const step = delta / segments
  const handle = (4 / 3) * Math.tan(step / 4)
  const out = []
  for (let i = 0; i < segments; i++) {
    const a1 = startAngle + i * step
    const a2 = a1 + step
    const p1x = centerX + radiusX * cosPhi * Math.cos(a1) - radiusY * sinPhi * Math.sin(a1)
    const p1y = centerY + radiusX * sinPhi * Math.cos(a1) + radiusY * cosPhi * Math.sin(a1)
    const p2x = centerX + radiusX * cosPhi * Math.cos(a2) - radiusY * sinPhi * Math.sin(a2)
    const p2y = centerY + radiusX * sinPhi * Math.cos(a2) + radiusY * cosPhi * Math.sin(a2)
    const d1x = -radiusX * cosPhi * Math.sin(a1) - radiusY * sinPhi * Math.cos(a1)
    const d1y = -radiusX * sinPhi * Math.sin(a1) + radiusY * cosPhi * Math.cos(a1)
    const d2x = -radiusX * cosPhi * Math.sin(a2) - radiusY * sinPhi * Math.cos(a2)
    const d2y = -radiusX * sinPhi * Math.sin(a2) + radiusY * cosPhi * Math.cos(a2)
    out.push([p1x + handle * d1x, p1y + handle * d1y, p2x - handle * d2x, p2y - handle * d2y, p2x, p2y])
  }
  // 末点用声明的端点，避免累积误差让字形轮廓出现缝隙
  if (out.length > 0) out[out.length - 1][4] = x1
  if (out.length > 0) out[out.length - 1][5] = y1
  return out
}
