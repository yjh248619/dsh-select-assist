/**
 * 从"当前前台应用"里取回用户刚选中的文字。
 *
 * 做法是 Windows 划词工具的通行方案：注入一次 Ctrl+C，然后读剪贴板。它的代价是短暂
 * 改写剪贴板——所以默认会把用户原来的剪贴板内容**原样还原**。控制台类窗口（Ctrl+C 是
 * 中断）默认跳过，避免误伤正在跑的命令。
 *
 * 剪贴板是**全局资源**，谁都能在同一时刻写它，所以取词有三条硬规则（每条都对应一个
 * 真实踩过的坑，见 README「设计要点」）：
 *
 * 1. **用户此刻正按着 Ctrl+C 就绝不注入**。我们注入的 Ctrl 抬起事件会把用户那个还没
 *    松开的组合键拆散（应用收到的是"一个没有 Ctrl 的 c"），用户按了 Ctrl+C 却没复制
 *    成功，还可能在正文里多出一个字符。
 * 2. **不认"别的进程写的那次复制"**。剪贴板序号变化只说明"有人写了"：剪贴板管理器同步、
 *    别的应用复制，都会让它变。按序号就认，菜单与回答窗口就会拿着一整段跟这次选区无关的
 *    文字弹出来。"无属主/认不出属主"的写入仍然放行——真实机器上它并不罕见（进程退出、
 *    无窗口写入），一律拒绝会让个别应用再也弹不出菜单，而"我们自己的还原落在别人的取词
 *    窗口里"这条已经被手势串行队列从根上排除（见 gesture.mjs 的 createLatestQueue）。
 * 3. **只在"这之后没人再写过"时才还原**。还原是为了不弄丢用户原来的剪贴板内容；可要是
 *    用户在我们取词期间自己复制了东西，还原就变成"把用户刚复制的内容踩掉"——表现正是
 *    "按了 Ctrl+C 却粘贴出旧内容"。
 */
import { win32 as path } from 'node:path'
import {
  WIN,
  clipboardOwnerWindow,
  clipboardFormats,
  foregroundEditor,
  keyDown,
  processImage,
  readClipboardText,
  rootWindow,
  sendCopyShortcut,
  windowClass,
  windowPid,
} from './win32.mjs'

/** 控制台/终端窗口类名（Ctrl+C 在这些窗口里是中断而不是复制）。 */
const TERMINAL_CLASSES = [
  'ConsoleWindowClass',
  'CASCADIA_HOSTING_WINDOW_CLASS',
  'mintty',
  'PuTTY',
  'ConEmu',
  'Windows.UI.Core.CoreWindow',
]

/** 取词默认参数。 */
export const CAPTURE_DEFAULTS = {
  /** 轮询剪贴板序号的间隔（毫秒）。 */
  pollMs: 40,
  /** 一次取词的时间预算（毫秒）。 */
  timeoutMs: 900,
}

/** 前台窗口是否是终端（取词前先排除）。 */
export function isTerminalWindow(api, hwnd) {
  const name = windowClass(api, hwnd)
  return TERMINAL_CLASSES.some((prefix) => name.startsWith(prefix))
}

/**
 * 用户此刻是不是正在按 Ctrl+C（Ctrl 或 C 任意一个按着就算）。
 * 这种时候既不能注入按键、也不能还原剪贴板：两条都会毁掉用户自己那次复制。
 */
export function userCopyPending(api) {
  return keyDown(api, WIN.VK_CONTROL) || keyDown(api, WIN.VK_C)
}

/**
 * 这次剪贴板写入跟前台窗口是什么关系。
 *
 * - \`ours\`：前台窗口自己（或同进程的窗口）写的——这就是我们要的那次复制；
 * - \`same-window-tree\`：不同进程但同一个顶层窗口（UWP：前台是框架窗口，实际复制的是
 *   它的子窗口）——同样算数；
 * - \`foreign\`：明确是别的进程写的（剪贴板管理器、另一个应用）——**只有这一种要丢掉**；
 * - \`no-owner\`：写入方没有窗口（进程已退出、无窗口写入）——判断不了，放行；
 * - \`unknown\`：读不到属主或读不到前台窗口的进程——判断不了，放行。
 *
 * @param api - createWin32() 的产物。
 * @param foreground - 注入 Ctrl+C 时的前台窗口。
 * @returns 关系字符串。
 */
export function ownerRelation(api, foreground) {
  const owner = clipboardOwnerWindow(api)
  if (owner === undefined) return 'unknown'
  const foregroundPid = windowPid(api, foreground)
  if (!(foregroundPid > 0)) return 'unknown'
  if (owner === null) return 'no-owner'
  const ownerPid = windowPid(api, owner)
  if (!(ownerPid > 0)) return 'no-owner'
  if (ownerPid === foregroundPid) return 'ours'
  const ownerRoot = rootWindow(api, owner)
  const foregroundRoot = rootWindow(api, foreground)
  const ownerRootPid = ownerRoot === null ? 0 : windowPid(api, ownerRoot)
  const foregroundRootPid = foregroundRoot === null ? 0 : windowPid(api, foregroundRoot)
  if (ownerRootPid > 0 && ownerRootPid === foregroundRootPid) return 'same-window-tree'
  // WPS 把文档引擎放在**独立进程**里，而且复制时用的是它自己一个无属主、隐藏的
  // CLIPBRDWNDCLASS 窗口——两个进程都不是前台窗口那一棵窗口树。只认这一种例外：
  // 前后台都是同一套 WPS 安装目录下的文档进程（wps/et/wpp），别的兄弟进程一律不认。
  if (windowClass(api, owner) === 'CLIPBRDWNDCLASS') {
    const app = processImage(api, foregroundPid).toLowerCase()
    const writer = processImage(api, ownerPid).toLowerCase()
    const engines = new Set(['wps.exe', 'et.exe', 'wpp.exe'])
    if (app && writer && engines.has(path.basename(app)) && engines.has(path.basename(writer))
      && path.dirname(app) === path.dirname(writer)) return 'wps-document-process'
  }
  return 'foreign'
}

/** 睡眠。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 取回选中文本。
 *
 * @param api - createWin32() 的产物。
 * @param options - \`restoreClipboard\`（默认 true）、\`checkOwner\`（默认 true）、
 *   \`restoreWhenEmpty\`（默认 false，见下）、\`timeoutMs\`、\`pollMs\`、
 *   \`onReport\`（拿一份"这次取词做了什么"的诊断）。
 * @returns 选中文本；没取到返回 null。
 */
export async function captureSelection(api, options = {}) {
  const restoreClipboard = options.restoreClipboard !== false
  const checkOwner = options.checkOwner !== false
  /**
   * 没取到文字时要不要把用户原来的文字放回去（默认 false = 一个字节都不动）。
   *
   * 默认不还原是有原因的：那会儿剪贴板里可能是**别人**刚写的东西（剪贴板管理器、用户自己
   * 复制），动它就是踩用户。但"用剪贴板核实这次手势选没选中文字"那一路（见 main.mjs 的
   * confirmByClipboard）不一样：那次 Ctrl+C 是**我们自己**发的，而且非常常见的结局是
   * "应用把整个形状/图片复制走了，一个文字都没有"——不还原就等于我们白白弄丢了用户原来
   * 的剪贴板内容。所以这一路显式传 true，判据收紧到：确实观察到写入、那次写入不是别的
   * 进程写的、之后没人再写过、用户也没在此期间自己复制过。
   */
  const restoreWhenEmpty = options.restoreWhenEmpty === true
  const timeoutMs = options.timeoutMs ?? CAPTURE_DEFAULTS.timeoutMs
  const pollMs = options.pollMs ?? CAPTURE_DEFAULTS.pollMs
  const startedAt = Date.now()
  const report = {
    ok: false,
    reason: 'timeout',
    length: 0,
    at: startedAt,
    elapsedMs: 0,
    injected: false,
    /** 取词期间观察到"用户自己按了 Ctrl+C"。 */
    userCopyObserved: false,
    /** 取词期间观察到的剪贴板写入次数（按序号变化去重）。 */
    writes: 0,
    /** 最终采信的那次写入跟前台窗口的关系（ours / same-window-tree / unknown）。 */
    owner: 'unknown',
    /** 还原结果：restored / none / failed / skip:user-copy / skip:newer-write。 */
    restore: 'none',
  }
  const finish = (text, reason) => {
    report.ok = text !== null
    report.reason = reason
    report.length = typeof text === 'string' ? text.length : 0
    report.elapsedMs = Date.now() - startedAt
    options.onReport?.(report)
    return text
  }

  const foreground = api.GetForegroundWindow()
  report.foregroundPid = windowPid(api, foreground)
  report.foregroundClass = windowClass(api, foreground)
  if (options.textOnly === true) {
    report.editor = foregroundEditor(api)
    // 表格里的选区不是"文字编辑"，先在注入 Ctrl+C **之前**就挡掉：这一下会真的触发
    // 一次复制，还会把 WPS/Excel 的复制模式搅乱（网格控件是 EXCEL7，编辑框是 EXCEL6/_WwG）。
    if (report.foregroundClass === 'XLMAIN' && report.editor?.focusClass === 'EXCEL7') return finish(null, 'not-text-editing')
  }
  if (isTerminalWindow(api, foreground)) return finish(null, 'terminal')
  // 规则 1：用户正在按 Ctrl+C，这次取词直接放弃——不注入、不还原、一个字节都不动。
  if (userCopyPending(api)) return finish(null, 'user-copy')

  const before = readClipboardText(api)
  const beforeSeq = Number(api.GetClipboardSequenceNumber())
  sendCopyShortcut(api)
  report.injected = true

  const deadline = Date.now() + timeoutMs
  let text = null
  let textSeq = null
  let foreignSeen = false
  let nonTextSelection = false
  let lastSeq = beforeSeq
  while (Date.now() < deadline) {
    await delay(pollMs)
    if (userCopyPending(api)) report.userCopyObserved = true
    const seq = Number(api.GetClipboardSequenceNumber())
    if (seq === lastSeq) continue
    lastSeq = seq
    report.writes += 1
    // 规则 2：确定是别的进程写的那次就不要，继续等（真正那次复制通常紧跟其后）。
    const relation = checkOwner ? ownerRelation(api, foreground) : 'ours'
    report.owner = relation
    const owner = clipboardOwnerWindow(api)
    report.ownerPid = owner == null ? 0 : windowPid(api, owner)
    report.ownerClass = owner == null ? '' : windowClass(api, owner)
    if (relation === 'foreign') {
      foreignSeen = true
      continue
    }
    report.formats = options.textOnly === true ? clipboardFormats(api) : []
    if (Number(api.GetClipboardSequenceNumber()) !== seq) continue
    // 单元格区域和嵌入对象**也会**在剪贴板里挂一份纯文本，光看"复制出文字了没有"
    // 分不开。改用剪贴板自己的**原生对象格式**当证据：只有 HTML/RTF 是正常的富文本。
    if (options.textOnly === true && report.formats.some((format) =>
      /^(?:WPS Spreadsheets .* Format|XML Spreadsheet|Biff\d*)$/i.test(format))) {
      nonTextSelection = true
      break
    }
    const captured = readClipboardText(api)
    if (typeof captured === 'string' && captured.trim() !== '') {
      text = captured
      textSeq = seq
      report.owner = relation
      break
    }
  }

  if (text === null) {
    // 没取到选区时**默认绝不还原**：此刻剪贴板里是别人（或用户自己）的东西，动它就是踩用户。
    // 唯一的例外是"我们自己的那次注入确实写走了剪贴板、却一个文字都没复制出来"——见
    // restoreWhenEmpty 的说明。
    if (restoreWhenEmpty && typeof before === 'string' && before !== '' && report.writes > 0 && !foreignSeen) {
      if (report.userCopyObserved) {
        report.restore = 'skip:user-copy'
      } else if (Number(api.GetClipboardSequenceNumber()) !== lastSeq) {
        report.restore = 'skip:newer-write'
      } else {
        report.restore = 'failed'
        try {
          const { writeClipboardText } = await import('./win32.mjs')
          if (writeClipboardText(api, before) !== false) report.restore = 'restored'
        } catch {
          /* 还原失败不影响本次取词 */
        }
      }
    }
    return finish(null, nonTextSelection ? 'non-text-selection' : foreignSeen ? 'foreign-write' : 'timeout')
  }

  // 规则 3：还原只在"我们读完之后没人再写过剪贴板"时才做。
  if (restoreClipboard && typeof before === 'string' && before !== text) {
    if (report.userCopyObserved) {
      report.restore = 'skip:user-copy'
    } else if (Number(api.GetClipboardSequenceNumber()) !== textSeq) {
      report.restore = 'skip:newer-write'
    } else {
      report.restore = 'failed'
      try {
        const { writeClipboardText } = await import('./win32.mjs')
        if (writeClipboardText(api, before) !== false) report.restore = 'restored'
      } catch {
        /* 还原失败不影响本次取词 */
      }
    }
  }
  return finish(text, 'ok')
}

/** 供路由使用：把选中文本裁到上限。 */
export function clampSelection(text, limit) {
  if (typeof text !== 'string') return ''
  return text.length > limit ? text.slice(0, limit) : text
}
