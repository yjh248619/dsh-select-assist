/**
 * 原生分层窗口（Layered Window）：无边框、置顶、逐像素透明、圆角/圆形，
 * 窗口就在本进程里，不依赖任何浏览器、不额外起进程。
 *
 * 绘制流程：把一帧画进 32bpp DIB（GDI+）→ UpdateLayeredWindow 带 alpha 贴到屏幕上。
 * 这样圆角与阴影都是抗锯齿的真透明，不是硬边裁剪。
 *
 * 消息循环：用 PeekMessage 轮询而不是阻塞 GetMessage——伴生进程的主线程还要跑
 * HTTP/SSE，不能被阻塞。
 */

const WM = {
  PAINT: 0x000f,
  SETCURSOR: 0x0020,
  ERASEBKGND: 0x0014,
  NCHITTEST: 0x0084,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  CAPTURECHANGED: 0x0215,
  MOUSEMOVE: 0x0200,
  MOUSEWHEEL: 0x020a,
  MOUSELEAVE: 0x02a3,
  RBUTTONDOWN: 0x0204,
  MOVE: 0x0003,
  EXITSIZEMOVE: 0x0232,
  GETMINMAXINFO: 0x0024,
  SIZE: 0x0005,
  DPICHANGED: 0x02e0,
  DESTROY: 0x0002,
}

const HT = {
  CLIENT: 1,
  CAPTION: 2,
  LEFT: 10,
  RIGHT: 11,
  TOP: 12,
  TOPLEFT: 13,
  TOPRIGHT: 14,
  BOTTOM: 15,
  BOTTOMLEFT: 16,
  BOTTOMRIGHT: 17,
}

/**
 * 语义命中区 → `WM_NCHITTEST` 返回值。
 *
 * **八个方向都要映射**：窗口本身是 WS_POPUP、没有 WS_THICKFRAME，但只要命中区返回了
 * HT 边框代码，DefWindowProc 就会起自己的缩放循环（拖动时窗口跟着动、WM_SIZE 回到
 * 我们这边，绘制按新尺寸重排），四边与四角都是同一条路径。
 */
export const HIT_TEST_CODES = {
  caption: HT.CAPTION,
  'resize-left': HT.LEFT,
  'resize-right': HT.RIGHT,
  'resize-top': HT.TOP,
  'resize-bottom': HT.BOTTOM,
  'resize-topleft': HT.TOPLEFT,
  'resize-topright': HT.TOPRIGHT,
  'resize-bottomleft': HT.BOTTOMLEFT,
  'resize-bottomright': HT.BOTTOMRIGHT,
}

/** 语义命中区 → HT 代码（认不出的区按客户区处理）。 */
export function hitTestCode(zone) {
  return HIT_TEST_CODES[zone] ?? HT.CLIENT
}

/**
 * 创建原生浮层窗口。
 * @param options.api - win32.mjs 的 createWin32() 产物（提供 koffi/user32/gdi32）。
 * @param options.gdi - native/gdi.mjs 的 createGdi() 产物。
 * @param options.title - 窗口标题（诊断用）。
 * @param options.onPaint - (painter, width, height, state) => void，state 由 setState 提供。
 * @param options.onHitTest - (x, y, state) => 语义命中区（'caption' | 'client' | 'resize-<方向>'），
 *   决定这一块是拖动、点击还是缩放（八向缩放 = resize-left/right/top/bottom + 四个对角）。
 * @param options.onClick - (x, y, state) => boolean（true 表示已处理，需要重绘）。
 * @param options.onHover - (x, y, state) => boolean（hover 状态是否变化）。
 * @param options.onWheel - (delta, state) => boolean。
 * @param options.onDpiChanged - (scale) => void。
 */
/**
 * koffi 的类型名是**全局**的：同进程里创建第二个窗口时再定义同名结构体会抛
 * "Duplicate type name"（踩过）。所以类型定义集中到模块级、只建一次。
 */
let cachedTypes = null
function windowTypes(koffi) {
  if (cachedTypes !== null) return cachedTypes
  let wndProcProto = null
  try {
    wndProcProto = koffi.proto('intptr_t __stdcall DST_NW_WndProc(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  } catch {
    wndProcProto = koffi.pointer('DST_NW_WndProc')
  }
  const RECT = koffi.struct('DST_NW_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = koffi.struct('DST_NW_POINT', { x: 'long', y: 'long' })
  const SIZE = koffi.struct('DST_NW_SIZE', { cx: 'long', cy: 'long' })
  const BLENDFUNCTION = koffi.struct('DST_NW_BLENDFUNCTION', { BlendOp: 'uint8', BlendFlags: 'uint8', SourceConstantAlpha: 'uint8', AlphaFormat: 'uint8' })
  const BITMAPINFOHEADER = koffi.struct('DST_NW_BITMAPINFOHEADER', {
    biSize: 'uint32',
    biWidth: 'long',
    biHeight: 'long',
    biPlanes: 'uint16',
    biBitCount: 'uint16',
    biCompression: 'uint32',
    biSizeImage: 'uint32',
    biXPelsPerMeter: 'long',
    biYPelsPerMeter: 'long',
    biClrUsed: 'uint32',
    biClrImportant: 'uint32',
  })
  const WNDCLASSEXW = koffi.struct('DST_NW_WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: koffi.pointer(wndProcProto ?? 'DST_NW_WndProc'),
    cbClsExtra: 'int',
    cbWndExtra: 'int',
    hInstance: 'void *',
    hIcon: 'void *',
    hCursor: 'void *',
    hbrBackground: 'void *',
    lpszMenuName: 'const char16_t *',
    lpszClassName: 'const char16_t *',
    hIconSm: 'void *',
  })
  const TRACKMOUSEEVENT = koffi.struct('DST_NW_TRACKMOUSEEVENT', { cbSize: 'uint32', dwFlags: 'uint32', hwndTrack: 'void *', dwHoverTime: 'uint32' })
  const MINMAXINFO = koffi.struct('DST_NW_MINMAXINFO', {
    ptReserved: POINT,
    ptMaxSize: POINT,
    ptMaxPosition: POINT,
    ptMinTrackSize: POINT,
    ptMaxTrackSize: POINT,
  })
  const MSG = koffi.struct('DST_NW_MSG', { hwnd: 'void *', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: POINT })
  cachedTypes = { wndProcProto, RECT, POINT, SIZE, BLENDFUNCTION, BITMAPINFOHEADER, WNDCLASSEXW, TRACKMOUSEEVENT, MSG, MINMAXINFO }
  return cachedTypes
}

export function createNativeWindow(options) {
  const { api, gdi } = options
  const koffi = api.koffi
  const user32 = api.user32
  const gdi32 = api.gdi32

  const { wndProcProto, RECT, POINT, SIZE, BLENDFUNCTION, BITMAPINFOHEADER, WNDCLASSEXW, TRACKMOUSEEVENT, MSG, MINMAXINFO } = windowTypes(koffi)

  const u = {
    RegisterClassExW: user32.func('uint16 RegisterClassExW(DST_NW_WNDCLASSEXW *wc)'),
    CreateWindowExW: user32.func('void *CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)'),
    DefWindowProcW: user32.func('intptr_t DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    DestroyWindow: user32.func('bool DestroyWindow(void *hwnd)'),
    GetModuleHandleW: api.kernel32.func('void *GetModuleHandleW(const char16_t *name)'),
    PeekMessageW: user32.func('bool PeekMessageW(_Out_ DST_NW_MSG *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)'),
    TranslateMessage: user32.func('bool TranslateMessage(DST_NW_MSG *msg)'),
    DispatchMessageW: user32.func('intptr_t DispatchMessageW(DST_NW_MSG *msg)'),
    GetDC: user32.func('void *GetDC(void *hwnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
    BeginPaint: user32.func('void *BeginPaint(void *hwnd, _Out_ DST_NW_RECT *ps)'),
    EndPaint: user32.func('bool EndPaint(void *hwnd, DST_NW_RECT *ps)'),
    InvalidateRect: user32.func('bool InvalidateRect(void *hwnd, DST_NW_RECT *rect, bool erase)'),
    UpdateLayeredWindow: user32.func('bool UpdateLayeredWindow(void *hwnd, void *dstDc, DST_NW_POINT *dst, DST_NW_SIZE *size, void *srcDc, DST_NW_POINT *src, uint32_t key, DST_NW_BLENDFUNCTION *blend, uint32_t flags)'),
    SetWindowPos: user32.func('bool SetWindowPos(void *hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    ShowWindow: user32.func('bool ShowWindow(void *hwnd, int cmd)'),
    GetCursorPos: user32.func('bool GetCursorPos(_Out_ DST_NW_POINT *pt)'),
    SetCapture: user32.func('void *SetCapture(void *hwnd)'),
    ReleaseCapture: user32.func('bool ReleaseCapture()'),
    SetCursor: user32.func('void *SetCursor(void *cursor)'),
    LoadCursorW: user32.func('void *LoadCursorW(void *instance, const char16_t *name)'),
    TrackMouseEvent: user32.func('bool TrackMouseEvent(_Inout_ DST_NW_TRACKMOUSEEVENT *event)'),
    GetDpiForWindow: user32.func('uint32 GetDpiForWindow(void *hwnd)'),
    GetWindowRect: user32.func('bool GetWindowRect(void *hwnd, _Out_ DST_NW_RECT *rect)'),
  }
  const g = {
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    CreateDIBSection: gdi32.func('void *CreateDIBSection(void *hdc, DST_NW_BITMAPINFOHEADER *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)'),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    DeleteObject: gdi32.func('int DeleteObject(void *obj)'),
    DeleteDC: gdi32.func('int DeleteDC(void *hdc)'),
    CreateRoundRectRgn: gdi32.func('void *CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)'),
    CreateEllipticRgn: gdi32.func('void *CreateEllipticRgn(int x1, int y1, int x2, int y2)'),
  }
  const SetWindowRgn = user32.func('int SetWindowRgn(void *hwnd, void *hrgn, bool redraw)')

  const WS_POPUP = 0x80000000
  const WS_EX_LAYERED = 0x00080000
  const WS_EX_TOOLWINDOW = 0x00000080
  const WS_EX_TOPMOST = 0x00000008
  const WS_EX_NOACTIVATE = 0x08000000
  const SWP_NOSIZE = 0x0001
  const SWP_NOMOVE = 0x0002
  const SWP_NOZORDER = 0x0004
  const SWP_NOACTIVATE = 0x0010
  const SWP_SHOWWINDOW = 0x0040
  const SW_HIDE = 0
  const SW_SHOWNOACTIVATE = 4
  const ULW_ALPHA = 0x00000002
  const AC_SRC_OVER = 0x00
  const AC_SRC_ALPHA = 0x01

  const state = {
    hwnd: null,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: false,
    data: options.initialState ?? {},
    hover: null,
    cursor: 'default',
    tracking: false,
    destroyed: false,
    drag: null,
  }

  let className = null
  let wndProc = null
  let timer = null
  const message = {}
  /** 最近收到的消息 id（排障用：能看到 Windows 到底发了什么过来）。 */
  const recentMessages = []

  /** 当前缩放（1.0 = 96dpi）。 */
  function scale() {
    try {
      const dpi = Number(u.GetDpiForWindow(state.hwnd))
      return dpi > 0 ? dpi / 96 : 1
    } catch {
      return 1
    }
  }

  /** 光标形状（拖动区/缩放区/普通）。 */
  const CURSORS = {
    default: null,
    hand: 32649, // IDC_HAND
    sizeAll: 32646, // IDC_SIZEALL
    sizeNWSE: 32642,
    sizeNESW: 32643,
    sizeWE: 32644,
    sizeNS: 32645,
  }
  function applyCursor(name, force = false) {
    if (!force && state.cursor === name) return
    state.cursor = name
    const id = CURSORS[name]
    if (id === null || id === undefined) return
    const handle = u.LoadCursorW(null, koffi.as(id, 'char16_t *'))
    if (handle !== null) u.SetCursor(handle)
  }

  /**
   * 缩放方向的 HT 代码 → 光标形状。
   *
   * 光标必须自己换：类光标是 null，光靠 DefWindowProc 不保证在无边框弹窗上给出
   * 拉伸指针；而"这条边能不能拉"全靠指针告诉用户（尤其是新加的上边）。
   */
  const RESIZE_CURSORS = {
    [HT.LEFT]: 'sizeWE',
    [HT.RIGHT]: 'sizeWE',
    [HT.TOP]: 'sizeNS',
    [HT.BOTTOM]: 'sizeNS',
    [HT.TOPLEFT]: 'sizeNWSE',
    [HT.BOTTOMRIGHT]: 'sizeNWSE',
    [HT.TOPRIGHT]: 'sizeNESW',
    [HT.BOTTOMLEFT]: 'sizeNESW',
  }

  /** 把一帧画进 DIB 并带 alpha 贴到屏幕。 */
  function paint() {
    if (state.hwnd === null || state.destroyed) return
    const width = Math.max(1, Math.round(state.width))
    const height = Math.max(1, Math.round(state.height))
    // 以系统里的真实位置为准（原生拖动期间 state.x/y 由 WM_MOVE 同步，这里再兜一层）
    if (state.visible) {
      const actual = {}
      if (u.GetWindowRect(state.hwnd, actual)) {
        state.x = actual.left
        state.y = actual.top
      }
    }
    const screenDc = u.GetDC(null)
    const memDc = g.CreateCompatibleDC(screenDc)
    const header = {
      biSize: koffi.sizeof(BITMAPINFOHEADER),
      biWidth: width,
      biHeight: -height, // 自上而下
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    }
    const bits = [null]
    const dib = g.CreateDIBSection(screenDc, header, 0, bits, null, 0)
    if (dib === null) {
      g.DeleteDC(memDc)
      u.ReleaseDC(null, screenDc)
      return
    }
    const previous = g.SelectObject(memDc, dib)
    try {
      const painter = gdi.painterFromHdc(memDc)
      if (painter !== null) {
        try {
          options.onPaint(painter, width, height, state.data, scale())
        } finally {
          painter.dispose()
        }
      }
      const blend = { BlendOp: AC_SRC_OVER, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA }
      u.UpdateLayeredWindow(state.hwnd, screenDc, { x: Math.round(state.x), y: Math.round(state.y) }, { cx: width, cy: height }, memDc, { x: 0, y: 0 }, 0, blend, ULW_ALPHA)
    } finally {
      g.SelectObject(memDc, previous)
      g.DeleteObject(dib)
      g.DeleteDC(memDc)
      u.ReleaseDC(null, screenDc)
    }
  }

  /** 请求重绘。 */
  function invalidate() {
    paint()
  }

  /** 窗口过程。 */
  function handleMessage(hwnd, msg, wParam, lParam) {
    switch (msg) {
      case WM.NCHITTEST: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        const screen = { x, y }
        const localX = screen.x - Math.round(state.x)
        const localY = screen.y - Math.round(state.y)
        // 只有真正的拖动/缩放区才返回非 HTCLIENT：返回 HTCAPTION 的区域，
        // Windows 会当成标题栏点击处理，**永远不会**把 WM_LBUTTONDOWN 发给客户区
        // （踩过：菜单项因此完全点不动）。
        const zone = options.onHitTest?.(localX, localY, state.data) ?? 'client'
        return hitTestCode(zone)
      }
      case WM.SETCURSOR: {
        // 光标形状跟着命中区走：缩放边上要看到对应的双箭头。其余区（按钮、正文、
        // 标题栏）交回 DefWindowProc，保持默认箭头。
        const name = RESIZE_CURSORS[Number(lParam) & 0xffff]
        if (name === undefined) return u.DefWindowProcW(hwnd, msg, wParam, lParam)
        applyCursor(name, true)
        return 1
      }
      case WM.MOUSEMOVE: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (state.drag !== null) {
          // 拖动用**屏幕坐标**算：窗口在光标下移动，客户区坐标会跟着变。
          const cursor = {}
          u.GetCursorPos(cursor)
          const dx = cursor.x - state.drag.screenX
          const dy = cursor.y - state.drag.screenY
          if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return 0
          state.drag.moved = true
          state.x = state.drag.winX + dx
          state.y = state.drag.winY + dy
          u.SetWindowPos(hwnd, -1, Math.round(state.x), Math.round(state.y), 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)
          paint()
          return 0
        }
        if (!state.tracking) {
          state.tracking = true
          u.TrackMouseEvent({ cbSize: koffi.sizeof(TRACKMOUSEEVENT), dwFlags: 0x00000002 /* TME_LEAVE */, hwndTrack: hwnd, dwHoverTime: 0 })
        }
        const changed = options.onHover?.(x, y, state.data) === true
        if (changed) invalidate()
        return 0
      }
      case WM.MOUSELEAVE: {
        state.tracking = false
        if (options.onHover?.(-1, -1, state.data) === true) invalidate()
        return 0
      }
      case WM.LBUTTONDOWN: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        const intent = options.onMouseDown?.(x, y, state.data) ?? 'click'
        state.lastDown = { x, y, intent, at: Date.now() }
        if (intent === 'drag') {
          const cursor = {}
          u.GetCursorPos(cursor)
          state.drag = { screenX: cursor.x, screenY: cursor.y, winX: state.x, winY: state.y, moved: false }
          u.SetCapture(hwnd)
        }
        if (options.onPressed?.(x, y, state.data) === true) invalidate()
        return 0
      }
      case WM.LBUTTONUP: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (state.drag !== null) {
          const drag = state.drag
          state.drag = null
          u.ReleaseCapture()
          if (drag.moved) {
            state.x = Math.round(state.x)
            state.y = Math.round(state.y)
            options.onDragEnd?.(state.x, state.y, state.data)
            return 0
          }
        }
        state.lastUp = { x, y, at: Date.now() }
        const handled = options.onClick?.(x, y, state.data) === true
        state.lastClickHandled = handled
        if (handled) invalidate()
        return 0
      }
      case WM.CAPTURECHANGED:
        state.drag = null
        return 0
      case WM.RBUTTONDOWN: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (options.onRightClick?.(x, y, state.data) === true) invalidate()
        return 0
      }
      case WM.MOVE: {
        // 原生拖动（HTCAPTION）期间系统会连续发 WM_MOVE，不跟上的话内部坐标会过期，
        // 下一次重绘就会把窗口"拉回"旧位置（踩过：拖完窗口一滚轮就跳回去）。
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (x !== state.x || y !== state.y) {
          state.x = x
          state.y = y
          options.onMoved?.(x, y, state.data)
        }
        return 0
      }
      case WM.EXITSIZEMOVE: {
        options.onMoved?.(state.x, state.y, state.data)
        return 0
      }
      case WM.MOUSEWHEEL: {
        const delta = (Number(wParam) >> 16) << 16 >> 16
        if (options.onWheel?.(delta, state.data) === true) invalidate()
        return 0
      }
      case WM.ERASEBKGND:
        return 1
      case WM.PAINT: {
        const ps = {}
        u.BeginPaint(hwnd, ps)
        u.EndPaint(hwnd, ps)
        paint()
        return 0
      }
      case WM.GETMINMAXINFO: {
        // 缩放的下限：不然用户能把浮窗拖成一条线，布局就没法看了（尺寸选项是 DIP）。
        const min = options.minSize
        if (min !== undefined && min !== null) {
          const s = scale()
          const info = koffi.decode(BigInt(lParam), MINMAXINFO)
          info.ptMinTrackSize = { x: Math.round(min.width * s), y: Math.round(min.height * s) }
          koffi.encode(BigInt(lParam), MINMAXINFO, info)
        }
        return 0
      }
      case WM.SIZE: {
        const width = Number(lParam) & 0xffff
        const height = (Number(lParam) >> 16) & 0xffff
        if (width > 0 && height > 0) {
          state.width = width
          state.height = height
          // 通知调用方：窗口尺寸变了（它要更新对外汇报的矩形与"用户改过的尺寸"）。
          options.onResized?.(width, height, state.data)
          paint()
        }
        return 0
      }
      case WM.DPICHANGED: {
        const suggested = lParam
        options.onDpiChanged?.(scale(), suggested)
        invalidate()
        return 0
      }
      case WM.DESTROY:
        state.destroyed = true
        return 0
      default:
        return u.DefWindowProcW(hwnd, msg, wParam, lParam)
    }
  }

  return {
    /** 创建窗口（不可见）。 */
    create() {
      if (state.hwnd !== null) return state.hwnd
      className = options.className ?? 'DshSelectionToolsOverlay'
      // WndProc 里抛出的异常会被 koffi 吞掉、表现为"点了没反应"，所以这里兜住并上报。
      wndProc = koffi.register((hwnd, msg, wParam, lParam) => {
        recentMessages.push(Number(msg))
        if (recentMessages.length > 24) recentMessages.shift()
        try {
          return handleMessage(hwnd, msg, wParam, lParam)
        } catch (error) {
          options.onError?.(error)
          return 0
        }
      }, koffi.pointer(wndProcProto ?? 'DST_NW_WndProc'))
      const wc = {
        cbSize: koffi.sizeof(WNDCLASSEXW),
        style: 0,
        lpfnWndProc: wndProc,
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: u.GetModuleHandleW(null),
        hIcon: null,
        hCursor: null,
        hbrBackground: null,
        lpszMenuName: null,
        lpszClassName: className,
        hIconSm: null,
      }
      u.RegisterClassExW(wc)
      const exStyle = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE
      const hwnd = u.CreateWindowExW(exStyle, className, options.title ?? 'DSH', WS_POPUP, -32000, -32000, 10, 10, null, null, u.GetModuleHandleW(null), null)
      if (hwnd === null) throw new Error('CreateWindowExW failed')
      state.hwnd = hwnd
      state.destroyed = false
      // 消息泵：PeekMessage 轮询，避免阻塞伴生进程的事件循环
      timer = setInterval(() => {
        try {
          let guard = 0
          while (u.PeekMessageW(message, null, 0, 0, 1 /* PM_REMOVE */) && guard < 200) {
            guard += 1
            u.TranslateMessage(message)
            u.DispatchMessageW(message)
          }
        } catch (error) {
          options.onError?.(error)
        }
      }, 8)
      timer.unref?.()
      return hwnd
    },
    /** 显示并定位（尺寸为物理像素）。 */
    show(x, y, width, height) {
      state.x = x
      state.y = y
      state.width = width
      state.height = height
      state.visible = true
      u.SetWindowPos(state.hwnd, -1 /* HWND_TOPMOST */, Math.round(x), Math.round(y), Math.round(width), Math.round(height), SWP_NOACTIVATE | SWP_SHOWWINDOW)
      paint()
    },
    hide() {
      state.visible = false
      if (state.hwnd !== null) u.ShowWindow(state.hwnd, SW_HIDE)
    },
    invalidate,
    scale,
    state,
    /** 当前窗口尺寸（物理像素）。 */
    size: () => ({ width: state.width, height: state.height }),
    /**
     * 更新业务状态并重绘。
     * 就地合并（不换对象）：绘制期间回写的 contentHeight / stopBox 等要向调用方可见。
     */
    setState(patch) {
      Object.assign(state.data, patch)
      invalidate()
    },
    data: () => state.data,
    destroy() {
      if (timer !== null) clearInterval(timer)
      timer = null
      if (state.hwnd !== null) u.DestroyWindow(state.hwnd)
      if (wndProc !== null) koffi.unregister(wndProc)
      state.hwnd = null
      state.destroyed = true
    },
    isAlive: () => state.hwnd !== null && !state.destroyed,
    /** 最近收到的窗口消息（排障）。 */
    recentMessages: () => recentMessages.slice(),
    /** 鼠标事件轨迹（排障）。 */
    events: () => ({ down: state.lastDown ?? null, up: state.lastUp ?? null, clickHandled: state.lastClickHandled ?? null }),
    WM,
  }
}