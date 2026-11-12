/**
 * 把一段文本"填进"当前前台 Agent 的输入框——只粘贴，不发送。
 *
 * 为什么不用 UIA 的 ValuePattern::SetValue：Codex/Claude 桌面都是 Chromium，
 * 输入框是 ProseMirror（contenteditable）。实测 SetValue 返回 hr=0 但内容不变
 * （是 no-op），只能"点一下输入框 + 剪贴板 Ctrl+V"。
 *
 * 安全边界：
 * - 只认白名单进程（ChatGPT.exe / Claude.exe），别的一律不动；
 * - 必须点中一个「Edit/Document + ValuePattern/TextPattern」的控件才粘贴，
 *   否则直接失败返回，绝不往未知控件里塞字；
 * - 全程不发 Enter，交不交给模型由用户按回车决定。
 *
 * 依赖：koffi 由 win32.mjs 的 loadKoffi() 解析（DSH 宿主会传 hint），
 * 本模块**不直接 import 'koffi'**，全部走 api.koffi，避免普通 node 装不上。
 */
import {
  findWindowByPid,
  focusWindow,
  processImage,
  readClipboardText,
  sendCopyShortcut,
  windowClass,
  windowPid,
  windowRect,
  windowTitle,
  writeClipboardText,
} from '../win32.mjs'

/** 白名单：桌面进程名 → 对外标签。 */
const AGENT_HOSTS = new Map([
  ['chatgpt.exe', { kind: 'codex', label: 'Codex' }],
  ['claude.exe', { kind: 'claude', label: 'Claude' }],
])

const NAMESPACE = 'DSSAInject'
const CLSID_UI_AUTOMATION = [0xff48dba4, 0x60ef, 0x4201, [0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e]]
const IID_UI_AUTOMATION = [0x30cbe57d, 0xd9d0, 0x452a, [0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee]]
const IID_VALUE_PATTERN = [0xa94cd8b1, 0x0844, 0x4cd6, [0x9d, 0x2d, 0x64, 0x05, 0x37, 0xab, 0x39, 0xe9]]
const IID_TEXT_PATTERN = [0x32eba289, 0x3583, 0x42c9, [0x9c, 0x59, 0x3b, 0x6d, 0x9a, 0x1e, 0x9b, 0x6a]]

const UIA_CONTROL_TYPE_DOCUMENT = 50030
const UIA_CONTROL_TYPE_EDIT = 50004
const UIA_PROPERTY_CONTROL_TYPE = 30003
const UIA_PROPERTY_CLASS_NAME = 30012
const UIA_PROPERTY_NAME = 30005
const UIA_PATTERN_VALUE = 10002
const UIA_PATTERN_TEXT = 10014

const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const CLICK_SETTLE_MS = 400
const PASTE_SETTLE_MS = 700
const PASTE_RETRY_GAP_MS = 450
const FOCUS_SETTLE_MS = 650

// --- 以下句柄/原型在 initAutomation() 里按 api.koffi 建一次 ---
let K = null
let GUID = null
let VARIANT = null
let automation = null
let sysFree = null
let RELEASE_PROTO = null
let FOCUSED_PROTO = null
let PATTERN_PROTO = null
let PROPERTY_PROTO = null
let SET_FOCUS_PROTO = null
let VALUE_GET_PROTO = null
let TEXT_DOC_RANGE_PROTO = null
let TEXT_GET_PROTO = null

function guidTuple(parts) {
  return { Data1: parts[0], Data2: parts[1], Data3: parts[2], Data4: parts[3] }
}

function vtableSlot(iface, index) {
  return K.decode(K.decode(iface, 'void *'), index * 8, 'void *')
}

function initAutomation(api) {
  if (automation !== null) return automation
  K = api.koffi
  GUID = K.struct(NAMESPACE + 'GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8 [8]' })
  VARIANT = K.struct(NAMESPACE + 'Variant', { raw: 'uint8 [24]' })
  RELEASE_PROTO = K.proto('uint32 __stdcall ' + NAMESPACE + 'Release(void *self)')
  FOCUSED_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'Focused(void *self, _Out_ void **element)')
  PATTERN_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'Pattern(void *self, int id, ' + NAMESPACE + 'GUID *iid, _Out_ void **pattern)')
  PROPERTY_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'Property(void *self, int id, _Out_ ' + NAMESPACE + 'Variant *value)')
  SET_FOCUS_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'SetFocus(void *self)')
  VALUE_GET_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'ValueGet(void *self, _Out_ void **value)')
  TEXT_DOC_RANGE_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'TextDocRange(void *self, _Out_ void **range)')
  TEXT_GET_PROTO = K.proto('int __stdcall ' + NAMESPACE + 'TextGet(void *self, int max, _Out_ void **text)')
  const ole32 = K.load('ole32.dll')
  const oleaut32 = K.load('oleaut32.dll')
  ole32.func('int __stdcall CoInitializeEx(void *reserved, uint32_t coinit)')(null, 0)
  sysFree = oleaut32.func('void __stdcall SysFreeString(void *bstr)')
  const coCreate = ole32.func(
    'int __stdcall CoCreateInstance(' + NAMESPACE + 'GUID *clsid, void *outer, uint32_t ctx, ' + NAMESPACE + 'GUID *iid, _Out_ void **out)',
  )
  const out = [null]
  const hr = coCreate(guidTuple(CLSID_UI_AUTOMATION), null, 1, guidTuple(IID_UI_AUTOMATION), out)
  if (hr !== 0 || out[0] === null || out[0] === undefined) throw new Error('CoCreateInstance(CUIAutomation) failed: hr=0x' + (hr >>> 0).toString(16))
  automation = out[0]
  return automation
}

function sysFreePointer(pointer) {
  if (pointer === null || pointer === undefined || sysFree === null) return
  try {
    sysFree(pointer)
  } catch {
    // ignore
  }
}

function readBstr(pointer) {
  if (pointer === null || pointer === undefined) return ''
  const base = BigInt(pointer)
  const length = Number(K.decode(base - 4n, 'int32'))
  if (!Number.isFinite(length) || length <= 0) return ''
  return Array.from(K.decode(base, 'char16_t', Math.floor(length / 2))).join('')
}

function takeBstr(pointer) {
  try {
    return readBstr(pointer)
  } finally {
    sysFreePointer(pointer)
  }
}

function releaseElement(element) {
  if (element === null || element === undefined) return
  try {
    K.call(vtableSlot(element, 2), RELEASE_PROTO, element)
  } catch {
    // ignore
  }
}

function readProperty(element, id) {
  const holder = [null]
  if (K.call(vtableSlot(element, 10), PROPERTY_PROTO, element, id, holder) !== 0 || holder[0] === null) return null
  const bytes = holder[0].raw
  const vt = bytes[0] | (bytes[1] << 8)
  if (vt === 3) return bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)
  if (vt === 8) {
    let pointer = 0n
    for (let i = 7; i >= 0; i--) pointer = pointer * 256n + BigInt(bytes[8 + i] ?? 0)
    return takeBstr(pointer)
  }
  return null
}

function patternOf(element, patternId, iidParts) {
  const holder = [null]
  if (K.call(vtableSlot(element, 14), PATTERN_PROTO, element, patternId, guidTuple(iidParts), holder) !== 0) return null
  return holder[0]
}

function valueText(element) {
  const pattern = patternOf(element, UIA_PATTERN_VALUE, IID_VALUE_PATTERN)
  if (pattern === null) return null
  try {
    const holder = [null]
    if (K.call(vtableSlot(pattern, 4), VALUE_GET_PROTO, pattern, holder) !== 0) return null
    return takeBstr(holder[0])
  } finally {
    releaseElement(pattern)
  }
}

function documentText(element) {
  const pattern = patternOf(element, UIA_PATTERN_TEXT, IID_TEXT_PATTERN)
  if (pattern === null) return null
  try {
    const holder = [null]
    if (K.call(vtableSlot(pattern, 7), TEXT_DOC_RANGE_PROTO, pattern, holder) !== 0 || holder[0] === null) return null
    const range = holder[0]
    try {
      const textHolder = [null]
      if (K.call(vtableSlot(range, 12), TEXT_GET_PROTO, range, -1, textHolder) !== 0) return null
      return takeBstr(textHolder[0])
    } finally {
      releaseElement(range)
    }
  } finally {
    releaseElement(pattern)
  }
}

function composerText(element) {
  if (element === null || element === undefined) return null
  const value = valueText(element)
  const text = documentText(element)
  if (typeof value === 'string' && typeof text === 'string') return text.length >= value.length ? text : value
  return typeof value === 'string' ? value : text
}

function normalizePasted(value) {
  return String(value ?? '').replace(/\s+/g, '')
}

function focusedElement() {
  const holder = [null]
  if (K.call(vtableSlot(automation, 8), FOCUSED_PROTO, automation, holder) !== 0) return null
  return holder[0]
}

function agentForPid(api, pid) {
  const numeric = Number(pid)
  if (!(numeric > 0)) return null
  const image = processImage(api, numeric)
  if (typeof image !== 'string' || image === '') return null
  const base = image.replace(/\\/g, '/').split('/').pop().toLowerCase()
  const host = AGENT_HOSTS.get(base)
  if (!host) return null
  const found = findWindowByPid(api, [numeric])
  if (found === null) return null
  return {
    hwnd: found.hwnd,
    pid: numeric,
    kind: host.kind,
    label: host.label,
    title: windowTitle(api, found.hwnd),
    className: windowClass(api, found.hwnd),
  }
}

/**
 * 前台窗口属于哪个 Agent。
 * @returns {{hwnd:*, pid:number, kind:string, label:string, title:string, className:string}|null}
 */
export function detectAgentHost(api, hwnd = api.GetForegroundWindow()) {
  if (hwnd === null || hwnd === undefined) return null
  return agentForPid(api, Number(windowPid(api, hwnd)))
}

/**
 * 按 pid 判断它是不是白名单里的 Agent（划词时的 sourcePid 就是它）。
 * @returns {{hwnd:*, pid:number, kind:string, label:string, title:string, className:string}|null}
 */
export function detectAgentHostForPid(api, pid) {
  return agentForPid(api, pid)
}

function clickAt(api, x, y) {
  const user32 = K.load('user32.dll')
  user32.func('bool SetCursorPos(int x, int y)')(Math.round(x), Math.round(y))
  const mouseEvent = user32.func('void mouse_event(uint32_t flags, int32_t dx, int32_t dy, uint32_t data, uintptr_t extra)')
  mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
  mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把 text 填进前台 Agent 的输入框（只粘贴、不发送）。
 *
 * @param api - createWin32() 出来的 api。
 * @param {{hwnd?:*, text:string}} options
 * @returns {Promise<{ok:boolean, host?:object, clicks?:object[], composer?:object, before?:string|null, after?:string|null, reason?:string}>}
 */
export async function fillAgentComposer(api, options) {
  const text = String(options?.text ?? '')
  if (text === '') return { ok: false, reason: 'empty-text' }
  const host = detectAgentHost(api, options?.hwnd)
  if (host === null) return { ok: false, reason: 'unsupported-host' }
  const result = {
    ok: false,
    host: { kind: host.kind, label: host.label, pid: host.pid, title: host.title, className: host.className },
    clicks: [],
    composer: null,
    before: null,
    after: null,
  }
  try {
    initAutomation(api)
  } catch (error) {
    result.reason = 'uia-init-failed'
    result.error = String(error?.message ?? error)
    return result
  }
  // 必须真的把它切到前台再点：否则点击会落到当前前台窗口上，等于往别的应用里乱点。
  let foregroundOk = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    focusWindow(api, host.hwnd)
    await sleep(FOCUS_SETTLE_MS)
    if (Number(windowPid(api, api.GetForegroundWindow())) === host.pid) {
      foregroundOk = true
      break
    }
  }
  if (!foregroundOk) {
    result.reason = 'not-foreground'
    return result
  }
  const rect = windowRect(api, host.hwnd)
  if (rect === null || rect.right <= rect.left || rect.bottom <= rect.top) {
    result.reason = 'window-not-restorable'
    return result
  }
  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  const centerX = rect.left + width / 2
  const fractionList = [0.09, 0.13, 0.17, 0.22, 0.27, 0.32, 0.36, 0.40, 0.44, 0.48]
  const isEditable = (info) => info.controlType === UIA_CONTROL_TYPE_EDIT && info.className !== '' && (info.valuePattern || info.textPattern)
  const isMaybeTarget = (info) => info.controlType === UIA_CONTROL_TYPE_DOCUMENT && (info.valuePattern || info.textPattern)
  let composer = null
  let weakTarget = null

  const probeFocused = () => {
    const focused = focusedElement()
    if (focused === null) return { element: null, info: null }
    const info = {
      controlType: readProperty(focused, UIA_PROPERTY_CONTROL_TYPE),
      className: String(readProperty(focused, UIA_PROPERTY_CLASS_NAME) ?? ''),
      name: String(readProperty(focused, UIA_PROPERTY_NAME) ?? ''),
      valuePattern: patternOf(focused, UIA_PATTERN_VALUE, IID_VALUE_PATTERN) !== null,
      textPattern: patternOf(focused, UIA_PATTERN_TEXT, IID_TEXT_PATTERN) !== null,
    }
    return { element: focused, info }
  }

  // 0) 用户刚在 Agent 里操作过的话，输入框可能已经是焦点，先直接用。
  const initial = probeFocused()
  if (initial.element !== null) {
    if (isEditable(initial.info)) {
      composer = initial.element
      result.composer = { className: initial.info.className, name: initial.info.name, controlType: initial.info.controlType, at: 'already-focused' }
    } else {
      releaseElement(initial.element)
    }
  }

  // 1) 否则从窗口底部往上扫：只接受「Edit + 有 pattern」的真输入框；
  //    顺便记住第一个 Document 作为兜底（Chromium 的文档节点也会吃粘贴）。
  if (composer === null) {
    for (const fraction of fractionList) {
      const at = [Math.round(centerX), Math.round(rect.bottom - height * fraction)]
      clickAt(api, at[0], at[1])
      await sleep(CLICK_SETTLE_MS)
      const probed = probeFocused()
      if (probed.element === null) {
        result.clicks.push({ at, error: 'no-focused-element' })
        continue
      }
      const info = { at, ...probed.info }
      result.clicks.push(info)
      if (isEditable(probed.info)) {
        composer = probed.element
        result.composer = { className: probed.info.className, name: probed.info.name, controlType: probed.info.controlType, at }
        break
      }
      if (weakTarget === null && isMaybeTarget(probed.info)) {
        weakTarget = { element: probed.element, info, at }
        continue
      }
      releaseElement(probed.element)
    }
  }
  if (composer === null && weakTarget !== null) {
    composer = weakTarget.element
    result.composer = { className: weakTarget.info.className, name: weakTarget.info.name, controlType: weakTarget.info.controlType, at: weakTarget.at, weak: true }
  }
  if (composer === null) {
    result.reason = 'composer-not-found'
    return result
  }
  try {
    const expected = normalizePasted(text)
    const originalClipboard = readClipboardText(api)
    writeClipboardText(api, text)
    await sleep(120)
    // 粘贴有可能被系统/宿主吃掉一次（窗口刚被拉到前台、输入法尚未就绪、
    // 键盘队列还没转过来）。验证失败时再试一次——但第二次粘之前先重读一遍，
    // 避免第一次其实粘进去了、只是读回时机不对，结果贴了两遍。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await sleep(PASTE_RETRY_GAP_MS)
        const retryText = composerText(composer)
        if (typeof retryText === 'string' && normalizePasted(retryText).includes(expected)) {
          result.after = retryText
          result.ok = true
          result.pasteTarget = 'late-read'
          break
        }
      }
      K.call(vtableSlot(composer, 3), SET_FOCUS_PROTO, composer)
      await sleep(120)
      if (result.before === null) result.before = composerText(composer)
      sendCopyShortcut(api, 0x56)
      await sleep(PASTE_SETTLE_MS)
      // Chromium 的文档节点和输入框可能共用一次点击：粘贴后焦点往往才真正落进
      // contenteditable。所以读回时优先用「当前的焦点元素」，它才是文本真正去的地方。
      const focusedAfter = focusedElement()
      let verifiedText = null
      if (focusedAfter !== null && focusedAfter !== composer) {
        verifiedText = composerText(focusedAfter)
        result.focusAfterPaste = {
          controlType: readProperty(focusedAfter, UIA_PROPERTY_CONTROL_TYPE),
          className: String(readProperty(focusedAfter, UIA_PROPERTY_CLASS_NAME) ?? ''),
          name: String(readProperty(focusedAfter, UIA_PROPERTY_NAME) ?? ''),
        }
        result.pasteTarget = 'focused-after-paste'
        releaseElement(focusedAfter)
      } else if (focusedAfter !== null) {
        releaseElement(focusedAfter)
      }
      const ownText = composerText(composer)
      result.after = verifiedText ?? ownText
      const flattened = normalizePasted(result.after)
      result.ok = expected !== '' && flattened.includes(expected)
      if (!result.ok && normalizePasted(ownText).includes(expected)) {
        result.after = ownText
        result.ok = true
        result.pasteTarget = 'clicked-element'
      }
      if (result.ok) break
    }
    if (!result.ok) result.reason = 'verify-failed'
    if (typeof originalClipboard === 'string' && originalClipboard !== '') {
      try {
        writeClipboardText(api, originalClipboard)
      } catch {
        // ignore
      }
    }
  } finally {
    releaseElement(composer)
  }
  return result
}

/** 测试/诊断用：当前焦点元素快照。 */
export function readFocusedSnapshot(api) {
  try {
    initAutomation(api)
  } catch {
    return null
  }
  const focused = focusedElement()
  if (focused === null) return null
  try {
    return {
      controlType: readProperty(focused, UIA_PROPERTY_CONTROL_TYPE),
      className: String(readProperty(focused, UIA_PROPERTY_CLASS_NAME) ?? ''),
      name: String(readProperty(focused, UIA_PROPERTY_NAME) ?? ''),
      value: valueText(focused),
      text: documentText(focused),
    }
  } finally {
    releaseElement(focused)
  }
}
