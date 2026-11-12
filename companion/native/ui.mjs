/**
 * 浮层 UI：划词菜单与回答窗口（面板）两种形态的布局、绘制与命中测试。
 *
 * 全部用 GDI+ 画（圆角卡片、字体、换行文本），使用克制的蓝色强调与分层中性色，
 * 深色/浅色跟随系统；不依赖任何浏览器、不额外起进程。
 *
 * 尺寸：设计尺寸是 DIP（=CSS px），绘制时统一乘显示器缩放。
 */
import { rgb } from './gdi.mjs'
import { ensureMathReady, isMathReady, renderMath } from './math.mjs'

/** 深浅主题共用同一层级：正文底色、引用底色、蓝色强调与辅助文本。 */
export const THEMES = {
  dark: { menu: '#1c2433', layer1: '#273142', labelPrimary: '#eef3fb', labelSecondary: '#b9c6d9', labelTertiary: '#8fa1b8', hoverAlpha: 0x20, borderAlpha: 0x20, accent: '#7da6ff', danger: '#ff8f9c', success: '#7adbb5' },
  light: { menu: '#ffffff', layer1: '#f4f7fc', labelPrimary: '#1a1e2e', labelSecondary: '#3d4656', labelTertiary: '#5a6478', hoverAlpha: 0x10, borderAlpha: 0x1e, accent: '#2f63e0', danger: '#c03d50', success: '#1f7e60' },
}

/** 设计尺寸（DIP）。回答窗口只有"面板"一种形态（悬浮球已移除）。 */
export const MODES = {
  menu: { width: 328, height: 36, radius: 10 },
  panel: { width: 380, height: 460, radius: 16 },
}

/** 取调色板（按明暗主题）。 */
export function palette(dark) {
  const t = dark ? THEMES.dark : THEMES.light
  return {
    ...t,
    menuColor: rgb(t.menu),
    layer1Color: rgb(t.layer1),
    labelPrimaryColor: rgb(t.labelPrimary),
    labelSecondaryColor: rgb(t.labelSecondary),
    labelTertiaryColor: rgb(t.labelTertiary),
    hoverColor: rgb(t.accent, t.hoverAlpha),
    borderColor: rgb(dark ? '#a8bddb' : '#7186a5', t.borderAlpha),
    dividerColor: rgb(dark ? '#a8bddb' : '#7186a5', dark ? 0x18 : 0x14),
    accentSoftColor: rgb(dark ? '#2b3d60' : '#eef3ff'),
    footerColor: rgb(dark ? '#19202d' : '#f9fbff'),
    accentColor: rgb(t.accent),
    dangerColor: rgb(t.danger),
    successColor: rgb(t.success),
    // 不可用状态（例如还没有回答时的"复制"）
    disabledColor: rgb(dark ? '#53627a' : '#b1bed0'),
  }
}

/** 面板布局常量（DIP）。 */
export const PANEL = { padding: 16, headerHeight: 48, buttonSize: 28, sourcePadding: 12, sourceMaxHeight: 96, footerHeight: 36, scrollbarWidth: 3 }
/** 菜单绘制与命中共享段尺寸，避免点按错位。 */
const MENU = { padding: 4, segmentWidth: 80, segmentHeight: 28 }
/** 正文区底部与状态条之间留出的空隙（DIP）。 */
const BOTTOM_INSET = 6

/**
 * 缩放手柄的宽度（DIP）：四条边一样窄，四个角都更大。
 *
 * 角必须比边宽：窗口圆角（`MODES.panel.radius` = 16 DIP）让最角落的几个像素画出来是
 * 全透明的，而分层窗口（UpdateLayeredWindow）的透明像素**不接收鼠标**——角区窄了就等于
 * 抓不住（尤其是左上/右上这种"角上就是圆角"的地方）。
 */
export const PANEL_RESIZE = { edge: 6, corner: 16 }

/**
 * 面板各区域（DIP）。
 *
 * 宽高必须传**窗口的实际尺寸**：窗口可以被用户拖着改大小，布局不能钉死在设计尺寸上
 * （踩过：拖动改大小后正文/页脚还按 400×480 排版，窗口下方留一大片空白）。
 * @param width - 实际宽度（DIP），省略时用设计尺寸。
 * @param height - 实际高度（DIP），省略时用设计尺寸。
 */
export function panelLayout(state, width = MODES.panel.width, height = MODES.panel.height) {
  const bodyTop = PANEL.headerHeight + 8
  const bodyHeight = height - bodyTop - PANEL.footerHeight
  const contentWidth = width - PANEL.padding * 2
  // 引用高度随实际宽度估算；小窗口优先给回答留出一行，不让引用挤进状态栏。
  const source = typeof state.source === 'string' ? state.source : ''
  const charsPerLine = Math.max(12, Math.floor((contentWidth - PANEL.sourcePadding * 2) / 12))
  const sourceLines = source.split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  const sourceHeight = source === '' ? 0 : Math.min(PANEL.sourceMaxHeight, 32 + sourceLines * 16, Math.max(0, bodyHeight - 56))
  // 上下文提示和回答标签同处一行，不额外侵占正文高度。
  const contextLine = state.context === undefined || state.context === '' ? 0 : 16
  const answerLabelTop = bodyTop + sourceHeight + (sourceHeight > 0 ? 8 : 0)
  const answerTop = answerLabelTop + 18
  return {
    width,
    height,
    bodyTop,
    bodyHeight,
    sourceHeight,
    contextLine,
    answerLabelTop,
    answerTop,
    answerHeight: Math.max(0, height - PANEL.footerHeight - answerTop),
    contentWidth,
  }
}

/** 标题栏按钮（DIP）：右侧依次是收起/展开、最小化到任务栏、复制、关闭；从**实际宽度**的右边往左排。 */
export function panelButtons(state, width = MODES.panel.width) {
  // 视觉顺序（左→右）：最小化到任务栏（—）、收起/展开（⌃/⌄）、复制、关闭。
  // 数组按"从右往左"排：close 永远在最右，往左依次是 copy、fold、min。
  // fold = 收成标题条（窗口不缩、不离开屏幕）；min = 真缩进 Windows 任务栏。
  // 「问问」不开面板——它直接把原文引用进会话，所以标题栏没有它。
  const ids = ['close', 'copy', 'fold', 'min']
  const boxes = []
  let right = width - 6
  for (const id of ids) {
    right -= PANEL.buttonSize
    boxes.push({ id, x: right, y: (PANEL.headerHeight - PANEL.buttonSize) / 2, size: PANEL.buttonSize })
    right -= 2
  }
  return boxes
}

/** 菜单段命中（DIP）→ 0/1/2/3/-1（0=解释，1=总结，2=翻译，3=问问）。 */
export function menuRowAt(x, y) {
  if (y < MENU.padding || y > MODES.menu.height - MENU.padding) return -1
  const seg = Math.floor((x - MENU.padding) / MENU.segmentWidth)
  return seg === 0 || seg === 1 || seg === 2 || seg === 3 ? seg : -1
}

/** 动作 → 面板标题栏图标。与菜单行图标保持一致。 */
function actionIcon(action) {
  if (action === 'summarize') return 'doc'
  if (action === 'translate') return 'translate'
  return 'lens'
}

/** 动作 → 面板标题栏文字。 */
function actionTitle(action) {
  if (action === 'summarize') return '总结'
  if (action === 'translate') return '翻译'
  return '解释'
}

/** 动作 → 正文区上方的标签（译文 / 总结 / 回答）。 */
function actionBodyLabel(action) {
  if (action === 'summarize') return '总结'
  if (action === 'translate') return '译文'
  return '回答'
}

/**
 * 标题栏按钮 → 图标 id。
 *
 * 折叠按钮的箭头表示"点一下会发生什么"：展开状态画向上箭头（收起），收起状态画向下箭头（展开）。
 * 最小化到任务栏永远是那条下划线（—），与 Windows 窗口控件一致。
 */
function panelButtonIcon(state, id) {
  if (id === 'fold') return state.minimized === true ? 'chevron-down' : 'chevron-up'
  return id
}

function insideBox(x, y, box) {
  return box !== undefined && box !== null && x >= box.x && x <= box.x + box.size && y >= box.y && y <= box.y + box.size
}

/** 面板命中：按钮 id / 'stop' / 'body' / null。 */
export function panelHit(x, y, state, width = MODES.panel.width) {
  for (const button of panelButtons(state, width)) {
    if (insideBox(x, y, button)) return button.id
  }
  if (state.stopBox !== null && state.stopBox !== undefined) {
    const box = state.stopBox
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return 'stop'
  }
  return 'body'
}

/**
 * 回答窗口的缩放命中区（DIP）：**四边 + 四角，八个方向都算**。
 *
 * 坐标传窗口的**实际**宽高（用户可以把窗口拖大拖小），钉死在设计尺寸上手柄就会跑偏。
 * 落在边缘外一点点（原生缩放时坐标可能微负数）也算：比较本身就是"越界即命中"。
 *
 * @param width - 实际宽度（DIP）。
 * @param height - 实际高度（DIP）。
 * @returns `resize-<方向>`（left/right/top/bottom + 四个对角）；不在边缘上返回 null。
 */
export function panelEdgeZone(x, y, width = MODES.panel.width, height = MODES.panel.height) {
  const nearLeft = x < PANEL_RESIZE.corner
  const nearRight = x > width - PANEL_RESIZE.corner
  const nearTop = y < PANEL_RESIZE.corner
  const nearBottom = y > height - PANEL_RESIZE.corner
  // 角优先：只有角区够宽，圆角那一圈才点得到（边只有 6 DIP）
  if (nearLeft && nearTop) return 'resize-topleft'
  if (nearRight && nearTop) return 'resize-topright'
  if (nearLeft && nearBottom) return 'resize-bottomleft'
  if (nearRight && nearBottom) return 'resize-bottomright'
  if (x < PANEL_RESIZE.edge) return 'resize-left'
  if (x > width - PANEL_RESIZE.edge) return 'resize-right'
  // 上边只有最外面这 6 DIP 是缩放手柄：再往下就是标题栏，交给拖动（HTCAPTION）
  if (y < PANEL_RESIZE.edge) return 'resize-top'
  if (y > height - PANEL_RESIZE.edge) return 'resize-bottom'
  return null
}

/**
 * 回答窗口的完整命中区（DIP → 语义），原生窗口的 WM_NCHITTEST 直接吃这个结果。
 *
 * 优先级：**标题栏按钮 / 页脚「停止」 > 八向缩放手柄 > 标题栏（拖动） > 客户区**。
 * 按钮必须先判：缩放手柄就压在它们旁边（上右角贴着关闭按钮、底边贴着「停止」），
 * 反过来会把这两个按钮的边角抢走（踩过的方向：菜单项被 HTCAPTION 吃掉点不动）。
 */
export function panelHitZone(x, y, state, width = MODES.panel.width, height = MODES.panel.height) {
  if (panelHit(x, y, state, width) !== 'body') return 'client'
  // 最小化时只画了顶部标题条：不提供缩放手柄（拖一条 48px 的带子改大小既难抓也没意义），
  // 标题条照旧可以拖动窗口。下方那些像素本来就是透明的（分层窗口透明处不接收鼠标）。
  if (state.minimized === true) return y < PANEL.headerHeight ? 'caption' : 'client'
  const edge = panelEdgeZone(x, y, width, height)
  if (edge !== null) return edge
  return y < PANEL.headerHeight ? 'caption' : 'client'
}

// ---------------------------------------------------------------- 绘制

/** 画划词菜单（横向胶囊条）。 */
export function paintMenu(painter, width, height, state, scale) {
  const p = palette(state.dark)
  const s = scale
  painter.fillRoundRect(0, 0, width, height, MODES.menu.radius * s, p.menuColor)
  painter.strokeRoundRect(0.5 * s, 0.5 * s, width - s, height - s, MODES.menu.radius * s, p.borderColor, Math.max(1, s))
  // 4 段并列：段与段之间画一条 1px 分隔线，让胶囊条不会糊成一坨。
  for (let k = 1; k < 4; k++) {
    const sepX = (MENU.padding + k * MENU.segmentWidth) * s
    painter.line(sepX, 8 * s, sepX, height - 8 * s, p.dividerColor, 1)
  }
  const segs = [
    { label: '解释', icon: 'lens' },
    { label: '总结', icon: 'doc' },
    { label: '翻译', icon: 'translate' },
    { label: '问问', icon: 'ask' },
  ]
  for (let i = 0; i < segs.length; i++) {
    const left = (MENU.padding + i * MENU.segmentWidth) * s
    const active = state.hover === i
    if (active) {
      // 整段胶囊底色 + 文字加粗变色：轻量但一眼能认出当前项。
      painter.fillRoundRect(left, MENU.padding * s, MENU.segmentWidth * s, MENU.segmentHeight * s, 8 * s, p.hoverColor)
    }
    // 图标 + 两字标签，水平居中，垂直居中于段高。
    const labelW = 34 * s
    const iconW = 14 * s
    const gap = 4 * s
    const totalW = iconW + gap + labelW
    const cx = left + (MENU.segmentWidth * s - totalW) / 2
    const iconY = MENU.padding * s + (MENU.segmentHeight - 14) / 2 * s
    const textY = MENU.padding * s + (MENU.segmentHeight - 18) / 2 * s
    drawIcon(painter, segs[i].icon, cx, iconY, iconW, active ? p.accentColor : p.labelPrimaryColor, s)
    painter.text(segs[i].label, cx + iconW + gap, textY, labelW, 20 * s, { size: 13 * s, color: active ? p.accentColor : p.labelPrimaryColor })
  }
}

/**
 * 最小化时只画顶部标题条（48 DIP）。
 *
 * 窗口本身**不缩尺寸**：Windows 的 GETMINMAXINFO 给回答窗压了 200×150 的最小高度，真把
 * 窗口缩到 48px 会被系统弹回去；而且缩窗口会丢掉用户拖出来的大小。这里改成"只画一条带子"，
 * 其余像素保持 alpha 0——分层窗口的全透明像素不接收鼠标，点不到也看不见。
 */
function paintPanelStrip(painter, width, state, s, p, dipWidth) {
  const stripHeight = PANEL.headerHeight * s
  painter.fillRoundRect(0, 0, width, stripHeight, 12 * s, p.menuColor)
  // 底部两个圆角切成直角：最小化后窗口下沿就是这条带子的下沿。
  painter.fillRect(0, stripHeight - 12 * s, width, 12 * s, p.menuColor)
  // 蓝色图标底座在 16~42，标题从 52 起；右侧四个按钮（min/fold/copy/close）占 124px，标题让开。
  painter.fillRoundRect(16 * s, 11 * s, 26 * s, 26 * s, 8 * s, p.accentSoftColor)
  drawIcon(painter, actionIcon(state.action), 21 * s, 16 * s, 16 * s, p.accentColor, s)
  painter.text(actionTitle(state.action), 52 * s, 13 * s, Math.max(40, dipWidth - 184) * s, 23 * s, { size: 14 * s, bold: true, color: p.labelPrimaryColor })
  // 状态圆点：最小化后还看得出来"正在生成/已完成/失败"。
  const statusColor =
    state.status === 'running' || state.status === 'reading'
      ? p.accentColor
      : state.status === 'done'
        ? p.successColor
        : state.status === 'error'
          ? p.dangerColor
          : p.labelTertiaryColor
  painter.fillCircle((dipWidth - 140) * s, stripHeight / 2, 4.5 * s, statusColor)
  const hasAnswer = typeof state.answer === 'string' && state.answer !== ''
  for (const button of panelButtons(state, dipWidth)) {
    const disabled = button.id === 'copy' && !hasAnswer
    const active = state.hoverButton === button.id && !disabled
    const centerX = (button.x + button.size / 2) * s
    const centerY = (button.y + button.size / 2) * s
    if (active) painter.fillRoundRect(button.x * s, button.y * s, button.size * s, button.size * s, 9 * s, p.hoverColor)
    const color = disabled ? p.disabledColor : active ? p.accentColor : p.labelTertiaryColor
    drawIcon(painter, panelButtonIcon(state, button.id), centerX - 8 * s, centerY - 8 * s, 16 * s, color, s)
  }
  painter.line(0, stripHeight, width, stripHeight, p.dividerColor, s)
}

/** 画悬浮窗。 */
export function paintPanel(painter, width, height, state, scale) {
  const p = palette(state.dark)
  const s = scale
  // 窗口可以被用户拖动改大小：布局一律按**实际**宽高（DIP）算，不能钉死设计尺寸。
  const dipWidth = Math.max(200, width / s)
  const dipHeight = Math.max(160, height / s)
  // 最小化：窗口尺寸不变（绕开系统最小高度限制），只画顶部标题条，其余像素保持全透明。
  // 分层窗口里 alpha=0 的像素不接收鼠标，所以下面那块区域既看不见也点不到。
  if (state.minimized === true) {
    paintPanelStrip(painter, width, state, s, p, dipWidth)
    return
  }
  const layout = panelLayout(state, dipWidth, dipHeight)
  painter.fillRoundRect(0, 0, width, height, MODES.panel.radius * s, p.menuColor)

  // 蓝色图标底座在 16~42，标题从 52 起；右侧四个按钮（min/fold/copy/close）占 124px，标题让开。
  painter.fillRoundRect(16 * s, 11 * s, 26 * s, 26 * s, 8 * s, p.accentSoftColor)
  drawIcon(painter, actionIcon(state.action), 21 * s, 16 * s, 16 * s, p.accentColor, s)
  painter.text(actionTitle(state.action), 52 * s, 13 * s, Math.max(40, dipWidth - 184) * s, 23 * s, { size: 14 * s, bold: true, color: p.labelPrimaryColor })
  // "DSH" 水印移除：标题栏保持干净，品牌感由整体配色和圆角传达。
  const hasAnswer = typeof state.answer === 'string' && state.answer !== ''
  for (const button of panelButtons(state, dipWidth)) {
    // 没有内容可复制时把按钮画成灰的，让“点了没反应”变成“看得出点不了”。
    const disabled = button.id === 'copy' && !hasAnswer
    const active = state.hoverButton === button.id && !disabled
    const centerX = (button.x + button.size / 2) * s
    const centerY = (button.y + button.size / 2) * s
    if (active) painter.fillRoundRect(button.x * s, button.y * s, button.size * s, button.size * s, 9 * s, p.hoverColor)
    const color = disabled ? p.disabledColor : active ? p.accentColor : p.labelTertiaryColor
    // 折叠按钮按"点一下会怎样"换箭头：展开时向上（收起）、收起时向下（展开）。
    const icon = panelButtonIcon(state, button.id)
    drawIcon(painter, icon, centerX - 8 * s, centerY - 8 * s, 16 * s, color, s)
  }
  painter.line(PANEL.padding * s, PANEL.headerHeight * s, (dipWidth - PANEL.padding) * s, PANEL.headerHeight * s, p.dividerColor, s)

  if (layout.sourceHeight > 0) {
    const sourceX = PANEL.padding * s
    const sourceY = layout.bodyTop * s
    // 原文区：去掉蓝色背景，只保留左侧竖条作为视觉锚点。
    painter.fillRoundRect(sourceX, sourceY + 12 * s, 3 * s, Math.max(0, layout.sourceHeight - 24) * s, 1.5 * s, p.accentColor)
    painter.text('原文', (PANEL.padding + PANEL.sourcePadding) * s, sourceY + 4 * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, 14 * s, { size: 9.5 * s, bold: true, color: p.labelTertiaryColor })
    // 原文独立裁剪，极窄窗口或连续长词也不能侵入回答区。
    painter.setClip((PANEL.padding + PANEL.sourcePadding) * s, sourceY + 19 * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, Math.max(0, layout.sourceHeight - 25) * s)
    painter.paragraph(state.source, (PANEL.padding + PANEL.sourcePadding) * s, sourceY + 19 * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, {
      size: 11.5 * s,
      lineHeight: 16 * s,
      color: p.labelSecondaryColor,
      maxHeight: Math.max(0, layout.sourceHeight - 25) * s,
    })
    painter.resetClip()
  }

  painter.text(actionBodyLabel(state.action), PANEL.padding * s, layout.answerLabelTop * s, 48 * s, 16 * s, { size: 10.5 * s, bold: true, color: p.labelTertiaryColor })
  if (layout.contextLine > 0) {
    painter.text('已结合上下文', (dipWidth - PANEL.padding - 90) * s, layout.answerLabelTop * s, 90 * s, 16 * s, { size: 9.5 * s, color: p.labelTertiaryColor })
  }

  const clipTop = layout.answerTop * s
  // 底部留一点内边距：滚动内容被裁时不会紧贴状态条的分隔线。
  const clipBottom = (layout.bodyTop + layout.bodyHeight - BOTTOM_INSET) * s
  state.viewHeight = Math.max(0, layout.answerHeight - BOTTOM_INSET)
  // 滚动条单独占据右侧留白，长正文不会与滑块叠在一起。
  painter.setClip(PANEL.padding * s, clipTop, (layout.contentWidth - 8) * s, Math.max(0, clipBottom - clipTop))
  const contentHeight = drawAnswer(painter, state, PANEL.padding * s, clipTop - state.scroll * s, (layout.contentWidth - 8) * s, s, p, clipTop, clipBottom)
  painter.resetClip()
  state.contentHeight = contentHeight / s

  const maxScroll = Math.max(0, state.contentHeight - state.viewHeight)
  if (state.scroll > maxScroll) state.scroll = maxScroll
  if (maxScroll > 0 && state.viewHeight > 0) {
    const visible = Math.min(state.viewHeight, Math.max(24, (state.viewHeight / state.contentHeight) * state.viewHeight))
    const offset = (state.scroll / maxScroll) * (state.viewHeight - visible)
    painter.fillRoundRect((dipWidth - PANEL.padding + 2) * s, (layout.answerTop + offset) * s, PANEL.scrollbarWidth * s, visible * s, (PANEL.scrollbarWidth / 2) * s, p.borderColor)
  }

  const footerTop = dipHeight - PANEL.footerHeight
  // 分层状态栏保留底部圆角；不能用铺满整宽的矩形把窗口圆角填成直角。
  painter.fillRoundRect(0, footerTop * s, width, PANEL.footerHeight * s, MODES.panel.radius * s, p.footerColor)
  painter.fillRect(0, footerTop * s, width, MODES.panel.radius * s, p.footerColor)
  painter.line(PANEL.padding * s, footerTop * s, (dipWidth - PANEL.padding) * s, footerTop * s, p.dividerColor, s)
  const statusText =
    state.status === 'running'
      ? '正在生成…'
      : state.status === 'reading'
        ? '正在读取选区…'
        : state.status === 'done'
          ? '已完成'
          : state.status === 'error'
            ? state.error ? '生成失败 · ' + state.error : '生成失败'
            : '就绪'
  const statusColor =
    state.status === 'running' || state.status === 'reading'
      ? p.accentColor
      : state.status === 'done'
        ? p.successColor
        : state.status === 'error'
          ? p.dangerColor
          : p.labelTertiaryColor
  // 从右向左分配停止与复制回执，避免生成中复制时两段文字互相覆盖。
  let statusRight = dipWidth - PANEL.padding
  if (state.status === 'running') {
    state.stopBox = { x: statusRight - 54, y: footerTop + 6, width: 54, height: 28 }
    const box = state.stopBox
    painter.fillRoundRect(box.x * s, box.y * s, box.width * s, box.height * s, 8 * s, state.hoverButton === 'stop' ? p.hoverColor : p.accentSoftColor)
    drawIcon(painter, 'stop', (box.x + 8) * s, (box.y + 8) * s, 12 * s, p.accentColor, s)
    painter.text('停止', (box.x + 24) * s, (box.y + 5) * s, 28 * s, 18 * s, { size: 11.5 * s, color: p.accentColor })
    statusRight = box.x - 8
  } else {
    state.stopBox = null
  }
  if (typeof state.copyFeedback === 'string' && state.copyFeedback !== '') {
    const feedbackWidth = 70
    painter.text(state.copyFeedback, (statusRight - feedbackWidth) * s, (footerTop + 10) * s, feedbackWidth * s, 18 * s, {
      size: 11.5 * s,
      color: state.copyFeedback === '已复制' || state.copyFeedback === 'Copied' ? p.successColor : p.dangerColor,
    })
    statusRight -= feedbackWidth + 8
  }
  painter.fillCircle(PANEL.padding * s, (footerTop + 17) * s, 5.5 * s, statusColor)
  painter.text(statusText, (PANEL.padding + 13) * s, (footerTop + 10) * s, Math.max(0, statusRight - PANEL.padding - 13) * s, 18 * s, { size: 12 * s, color: state.status === 'error' ? p.dangerColor : p.labelTertiaryColor })
  // 描边最后绘制，让分层背景与四边缩放区始终保持整洁完整。
  painter.strokeRoundRect(0.5 * s, 0.5 * s, width - s, height - s, MODES.panel.radius * s, p.borderColor, Math.max(1, s))
}

/** 画答案（markdown-lite + LaTeX 公式），返回内容高度（物理像素）。 */
function drawAnswer(painter, state, x, y, width, s, p, clipTop, clipBottom) {
  if (state.answer === '') {
    if (state.status === 'running' || state.status === 'reading') {
      painter.fillCircle(x + 2 * s, y + 6 * s, 3.5 * s, p.accentColor)
      painter.text(state.status === 'reading' ? '正在获取所选文本…' : '正在整理回答…', x + 12 * s, y + 1 * s, width - 12 * s, 18 * s, { size: 11.5 * s, color: p.labelTertiaryColor })
      return 20 * s
    }
    painter.text('暂无文本输出', x, y, width, 18 * s, { size: 13 * s, color: p.labelTertiaryColor })
    return 26 * s
  }
  // 回答里出现公式就先把 MathJax 拉起来（约 400ms，只一次）；没就绪的这几十帧先画原始 TeX，
  // 就绪后由 main.mjs 统一刷新重绘成排版好的公式。
  if (state.hasMath !== true) state.hasMath = hasMathSyntax(state.answer)
  if (state.hasMath === true && !isMathReady()) void ensureMathReady()
  const blocks = parseBlocks(state.answer)
  let cursor = y
  const bodySize = 12.5 * s
  const lineHeight = 17 * s
  for (const block of blocks) {
    const near = cursor > clipTop - 600 * s && cursor < clipBottom + 600 * s
    if (block.kind === 'math') {
      const box = block.tex !== '' && isMathReady() ? renderMath(block.tex, { display: true, fontSize: bodySize }) : null
      if (box === null) {
        // 没就绪 / 这条 TeX 解析失败：把原始公式画出来（不丢内容，就绪后自动换成排版）。
        const raw = { kind: 'paragraph', text: '$$' + block.tex + '$$' }
        cursor += near
          ? drawText(painter, raw.text, x, cursor + 4 * s, width, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
          : measureText(painter, raw.text, width, bodySize, lineHeight, false)
        cursor += 4 * s
      } else {
        // 公式比正文区还宽时按比例缩小再渲染一次（矩阵/长式子常见），否则右侧会被裁掉。
        const fitted = box.width > width && width > 0
          ? renderMath(block.tex, { display: true, fontSize: Math.max(6 * s, bodySize * (width / box.width)) })
          : null
        const use = fitted !== null && fitted.width <= width ? fitted : box
        const boxHeight = use.height + use.depth
        if (near) {
          const left = x + Math.max(0, (width - use.width) / 2)
          paintMathBox(painter, use, left, cursor + 10 * s + use.height, p.labelPrimaryColor)
        }
        cursor += Math.max(boxHeight + 20 * s, lineHeight + 6 * s)
      }
    } else if (block.kind === 'heading') {
      const size = (block.level <= 1 ? 15 : 14) * s
      cursor += near
        ? drawText(painter, block.text, x, cursor + 4 * s, width, { size, lineHeight: size * 1.45, bold: true, color: p.labelPrimaryColor })
        : measureText(painter, block.text, width, size, size * 1.45, true)
      cursor += 4 * s
    } else if (block.kind === 'bullet' || block.kind === 'ordered') {
      const marker = block.kind === 'ordered' ? String(block.marker) + '.' : '•'
      painter.text(marker, x, cursor, 18 * s, lineHeight, { size: bodySize, color: p.labelSecondaryColor })
      cursor += near
        ? drawText(painter, block.text, x + 14 * s, cursor, width - 14 * s, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
        : measureText(painter, block.text, width - 14 * s, bodySize, lineHeight, false)
      cursor += 2 * s
    } else if (block.kind === 'code') {
      const codeSize = 11.5 * s
      const codeLine = 17 * s
      const boxHeight = block.lines.length * codeLine + 12 * s
      if (near) {
        painter.fillRoundRect(x, cursor + 2 * s, width, boxHeight, 7 * s, p.layer1Color)
        for (let i = 0; i < block.lines.length; i++) {
          painter.text(block.lines[i], x + 9 * s, cursor + 8 * s + i * codeLine, width - 18 * s, codeLine, { size: codeSize, mono: true, color: p.labelPrimaryColor })
        }
      }
      cursor += boxHeight + 4 * s
    } else if (block.kind === 'quote') {
      const used = near
        ? drawText(painter, block.text, x + 10 * s, cursor, width - 10 * s, { size: bodySize, lineHeight, color: p.labelSecondaryColor })
        : measureText(painter, block.text, width - 10 * s, bodySize, lineHeight, false)
      if (near) painter.fillRect(x, cursor + 2 * s, 2 * s, Math.max(3, used - 3 * s), p.accentColor)
      cursor += used + 3 * s
    } else if (block.kind === 'table') {
      const rowLine = 18 * s
      for (const row of block.rows) {
        cursor += near
          ? drawText(painter, row, x, cursor, width, { size: 12 * s, lineHeight: rowLine, color: p.labelSecondaryColor })
          : measureText(painter, row, width, 12 * s, rowLine, false)
      }
      cursor += 3 * s
    } else if (block.kind === 'hr') {
      if (near) painter.line(x, cursor + 7 * s, x + width, cursor + 7 * s, p.dividerColor, 1)
      cursor += 16 * s
    } else {
      cursor += near
        ? drawText(painter, block.text, x, cursor, width, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
        : measureText(painter, block.text, width, bodySize, lineHeight, false)
      cursor += 3 * s
    }
  }
  return cursor - (clipTop - state.scroll * s)
}

// ---------------------------------------------------------------- 公式（LaTeX）

/** 行内公式：`$...$` 或 `\(...\)`；display 公式（`$$...$$` / `\[...\]`）由 parseBlocks 单独成块。 */
const INLINE_MATH = /\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g
/** 粗略判断"这段文本里有公式"（只用来决定要不要提前加载 MathJax）。 */
function hasMathSyntax(text) {
  return typeof text === 'string' && (/\$[^$\n]+\$/.test(text) || /\\\([\s\S]+?\\\)/.test(text) || /\\\[[\s\S]*?\\\]/.test(text))
}
function hasInlineMath(text) {
  return typeof text === 'string' && (/\$[^$\n]+\$/.test(text) || /\\\([\s\S]+?\\\)/.test(text))
}

/** 把一行文本切成"普通文本 / 行内公式"两段（公式段带 tex）。 */
function splitInlineMath(text) {
  const out = []
  let last = 0
  INLINE_MATH.lastIndex = 0
  let match = INLINE_MATH.exec(text)
  while (match !== null) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) })
    const tex = (match[1] ?? match[2] ?? '').trim()
    if (tex !== '') out.push({ type: 'math', tex })
    last = match.index + match[0].length
    match = INLINE_MATH.exec(text)
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/** 公式盒（BOX 坐标：x 从 0、y 向下、基线在 y=0）画到 (x, baseline)。 */
function paintMathBox(painter, box, x, baseline, color) {
  const subpaths = []
  for (const subpath of box.subpaths) {
    const points = new Array(subpath.points.length)
    for (let i = 0; i < subpath.points.length; i++) {
      points[i] = [x + subpath.points[i][0], baseline + subpath.points[i][1]]
    }
    subpaths.push({ points })
  }
  painter.fillSubpaths(subpaths, color)
  for (const rect of box.rects) {
    painter.fillRect(x + rect.x, baseline + rect.y, rect.w, rect.h, color)
  }
}

/** 普通文本按"词 / 单个 CJK 字 / 空格"切成可断行的 token。 */
function flowTokens(text) {
  const tokens = []
  let buffer = ''
  const flush = () => {
    if (buffer !== '') {
      tokens.push({ text: buffer })
      buffer = ''
    }
  }
  for (const ch of text) {
    if (ch === ' ' || ch === '\t') {
      flush()
      tokens.push({ space: true })
      continue
    }
    if (isCjk(ch)) {
      flush()
      tokens.push({ text: ch })
      continue
    }
    buffer += ch
  }
  flush()
  return tokens
}
function isCjk(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3000 && code <= 0x303f)
  )
}

/** 把一段普通文本按行内样式切成"普通 / 粗体 / 等宽"（`**bold**` 与 `` `code` ``），标记本身不画。 */
function splitInlineStyles(text) {
  const out = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let match = re.exec(text)
  while (match !== null) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[1] !== undefined) out.push({ type: 'bold', text: match[1] })
    else out.push({ type: 'code', text: match[2] })
    last = match.index + match[0].length
    match = re.exec(text)
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/**
 * 带行内公式的段落排版：文字 token 与公式盒一起按宽度断行。
 *
 * 基线用 `lineTop + size * 0.9` 近似（DrawString 的矩形顶对齐 + 常用中文字体 ascent 比例）；
 * 行内公式的 ascent/depth 比文字大时把这一行的行高撑开，避免上下行贴住。
 */
function drawRichText(painter, text, x, y, width, options) {
  const { size, lineHeight, color = 0xff000000, bold = false, mono = false, dryRun = false } = options
  const segments = splitInlineMath(text)
  let cursorX = x
  let lineTop = y
  let lineHeightCur = lineHeight
  const spaceWidth = Math.max(2, painter.measure(' ', { size, bold }).width)
  const newline = () => {
    cursorX = x
    lineTop += lineHeightCur
    lineHeightCur = lineHeight
  }
  const wrapIfNeeded = (tokenWidth) => {
    if (cursorX + tokenWidth > x + width && cursorX > x + 0.5) newline()
  }
  const paintWord = (word, wordBold = bold, wordMono = mono) => {
    const measured = painter.measure(word, { size, bold: wordBold, mono: wordMono }).width
    wrapIfNeeded(measured)
    if (!dryRun) painter.text(word, cursorX, lineTop, measured + 2, lineHeightCur, { size, bold: wordBold, mono: wordMono, color })
    cursorX += measured
  }
  for (const segment of segments) {
    if (segment.type === 'math') {
      const box = isMathReady() ? renderMath(segment.tex, { display: false, fontSize: size }) : null
      if (box === null) {
        // 没就绪 / 解析失败：按原始文本画（用户至少看得到 $...$ 里的内容）。
        paintWord('$' + segment.tex + '$')
        continue
      }
      const boxHeight = box.height + box.depth
      if (boxHeight + 2 > lineHeightCur) lineHeightCur = boxHeight + 2
      wrapIfNeeded(box.width + 1)
      if (!dryRun) paintMathBox(painter, box, cursorX, lineTop + size * 0.9, color)
      cursorX += box.width + 1
    } else {
      for (const styled of splitInlineStyles(segment.text)) {
        const wordBold = bold || styled.type === 'bold'
        const wordMono = mono || styled.type === 'code'
        for (const token of flowTokens(styled.text)) {
          if (token.space === true) {
            const space = Math.max(2, painter.measure(' ', { size, bold: wordBold }).width)
            wrapIfNeeded(space)
            cursorX += space
          } else {
            paintWord(token.text, wordBold, wordMono)
          }
        }
      }
    }
  }
  return lineTop - y + lineHeightCur
}

/** 统一入口：有行内公式且 MathJax 就绪时走富文本排版，否则退回原来的纯文本段落。 */
function drawText(painter, text, x, y, width, options) {
  if (isMathReady() && hasInlineMath(text)) return drawRichText(painter, text, x, y, width, options)
  return painter.paragraph(text, x, y, width, options)
}

function measureText(painter, text, width, size, lineHeight, bold) {
  return drawText(painter, text, 0, 0, width, { size, lineHeight, bold, color: 0, dryRun: true })
}

// ---------------------------------------------------------------- Markdown-lite 解析

/** 把答案切成块（标题 / 列表 / 代码 / 引用 / 表格 / 段落）。 */
export function parseBlocks(text) {
  const TICK = String.fromCharCode(96)
  const FENCE = TICK + TICK + TICK
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  let code = null
  let table = null
  /** 跨行的 display 公式（`$$` / `\[` 开头，收尾在同一行或后面几行）。 */
  let math = null
  const flushTable = () => {
    if (table !== null && table.length > 0) blocks.push({ kind: 'table', rows: table })
    table = null
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    if (code !== null) {
      if (line.trim().startsWith(FENCE)) {
        blocks.push({ kind: 'code', lines: code })
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    // 公式块收集：`\[` / `$$` 单独成行时，后面几行都是公式，直到遇到收尾符号。
    if (math !== null) {
      const closeIndex = line.indexOf(math.close)
      if (closeIndex >= 0) {
        const tex = [...math.lines, line.slice(0, closeIndex)].join('\n').trim()
        if (tex !== '') blocks.push({ kind: 'math', tex })
        math = null
      } else {
        math.lines.push(line)
      }
      continue
    }
    if (line.trim().startsWith(FENCE)) {
      flushTable()
      code = []
      continue
    }
    // display 公式：`$$...$$`（可跨行）或 `\[...\]`（可跨行）。用户截图里那种
    // "\\[ 单独一行 + 公式一行 + \\] 单独一行"的三行式靠这一支收成一个公式块。
    const trimmed = line.trim()
    const dollarOpen = trimmed.startsWith('$$')
    const bracketOpen = trimmed.startsWith('\\[')
    if (dollarOpen || bracketOpen) {
      flushTable()
      const open = dollarOpen ? '$$' : '\\['
      const close = dollarOpen ? '$$' : '\\]'
      const inner = trimmed.slice(open.length)
      const closeIndex = inner.indexOf(close)
      if (closeIndex >= 0) {
        const tex = inner.slice(0, closeIndex).trim()
        if (tex !== '') blocks.push({ kind: 'math', tex })
      } else {
        math = { close, lines: inner.trim() === '' ? [] : [inner.trim()] }
      }
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
      if (table === null) table = []
      table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join('   '))
      continue
    }
    flushTable()
    // 分隔线（---、***、___）画成一条细分隔线，而不是把字符原样画出来。
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      blocks.push({ kind: 'bullet', text: bullet[1] })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      blocks.push({ kind: 'ordered', marker: ordered[1] + '.', text: ordered[2] })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      blocks.push({ kind: 'quote', text: quote[1] })
      continue
    }
    if (line.trim() === '') continue
    blocks.push({ kind: 'paragraph', text: line })
  }
  if (code !== null && code.length > 0) blocks.push({ kind: 'code', lines: code })
  // 收尾没收完的公式块（模型偶尔少写一个 `\]`）：整段按公式画，至少不是一堆反斜杠。
  if (math !== null && math.lines.length > 0) blocks.push({ kind: 'math', tex: math.lines.join('\n').trim() })
  flushTable()
  return blocks
}

// ---------------------------------------------------------------- 图标

/** 画一个 16×16 设计栅格的小图标。 */
export function drawIcon(painter, id, x, y, size, color, s = 1) {
  const u = size / 16
  const px = (v) => x + v * u
  const py = (v) => y + v * u
  const w = Math.max(1, 1.4 * u)
  // 所有图标共用线宽与折线路径，不混用实心喇叭或实心星形。
  const path = (points, closed = false) => {
    const vertices = closed ? [...points, points[0]] : points
    for (let i = 0; i + 1 < vertices.length; i++) {
      painter.line(px(vertices[i][0]), py(vertices[i][1]), px(vertices[i + 1][0]), py(vertices[i + 1][1]), color, w)
    }
  }
  switch (id) {
    case 'copy': {
      path([[3.5, 11], [2, 11], [2, 2], [10, 2], [10, 3.5]])
      painter.strokeRoundRect(px(5), py(5), 9 * u, 9 * u, 1.8 * u, color, w)
      return
    }
    case 'ask': {
      // 对话气泡 + 三个点：菜单里"问问"那一格（把原文引用进会话去问）。
      painter.strokeRoundRect(px(1.8), py(3), 12.4 * u, 8 * u, 2.6 * u, color, w)
      path([[5, 11], [5, 13.6], [8.2, 11]])
      for (const dx of [4.4, 8, 11.6]) painter.fillCircle(px(dx), py(7), 0.9 * u, color)
      return
    }
    case 'lens': {
      // 放大镜：解释 = 凑近看清含义
      painter.strokeEllipse(px(2.8), py(2.6), 8.4 * u, 8.4 * u, color, w)
      path([[9.9, 9.7], [13.9, 13.7]])
      return
    }
    case 'doc': {
      // 文档：总结 = 把长文收成一页
      path([[4.2, 2.4], [8.6, 2.4], [11.8, 5.6], [11.8, 13.2], [4.2, 13.2]], true)
      path([[8.6, 2.4], [8.6, 5.6], [11.8, 5.6]])
      path([[6, 8.2], [10, 8.2]])
      path([[6, 10.6], [10, 10.6]])
      path([[6, 12.8], [8.4, 12.8]])
      return
    }
    case 'translate': {
      // 双向箭头：翻译 = 在两种语言之间来回转换
      path([[2.6, 5.6], [12.4, 5.6]])
      path([[9.9, 3.3], [12.4, 5.6], [9.9, 7.9]])
      path([[13.4, 10.4], [3.6, 10.4]])
      path([[6.1, 8.1], [3.6, 10.4], [6.1, 12.7]])
      return
    }
    case 'chevron': {
      path([[6, 4.5], [9.5, 8], [6, 11.5]])
      return
    }
    case 'stop': {
      painter.strokeRoundRect(px(4), py(4), 8 * u, 8 * u, 1.5 * u, color, w)
      return
    }
    case 'min': {
      painter.line(px(4), py(8.5), px(12), py(8.5), color, w)
      return
    }
    case 'restore': {
      // 向上箭头：最小化之后同一个按钮变成"还原"。
      path([[4.5, 9.5], [8, 6], [11.5, 9.5]])
      return
    }
    case 'chevron-up': {
      // 收起：点一下把窗口收成标题条（图标表示会发生什么）。
      path([[4.5, 9.5], [8, 6], [11.5, 9.5]])
      return
    }
    case 'chevron-down': {
      // 展开：点一下把标题条还原成完整窗口。
      path([[4.5, 6.5], [8, 10], [11.5, 6.5]])
      return
    }
    case 'close': {
      painter.line(px(4.4), py(4.4), px(11.6), py(11.6), color, w)
      painter.line(px(11.6), py(4.4), px(4.4), py(11.6), color, w)
      return
    }
    default:
      return
  }
}
