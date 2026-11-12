/**
 * companion/gesture.mjs 的单测：手势状态机。
 *
 * 重点钉两件事：
 * 1. `double` 的时间窗语义——它只是复述系统（Windows 默认 500ms）已经做出的双击判定，
 *    窗口太紧就会"系统选好了词、插件没手势"，那就是用户嘴里的"有概率没反应"；
 * 2. 窗口放宽之后**两次独立单击仍然不能拼成双击**——这是放宽唯一的风险点，必须有用例。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GESTURE_DEFAULTS, createGestureDetector, pointInRect } from '../companion/gesture.mjs'

/** 造一个采样（down=true 表示左键按下）。 */
function sample(down, x, y, time) {
  return { down, x, y, time }
}

/** 新建检测器并收集手势/按下回调。 */
function detector(options = {}) {
  const gestures = []
  const presses = []
  const instance = createGestureDetector({
    ...options,
    onGesture: (gesture) => gestures.push(gesture),
    onPress: (press) => presses.push(press),
  })
  return { push: instance.push, gestures, presses }
}

/** 一次完整点击：按下、松开（间隔 gapMs，位置不动）。 */
function click(target, x, y, downAt, gapMs) {
  target.push(sample(true, x, y, downAt))
  target.push(sample(false, x, y, downAt + gapMs))
}

test('默认阈值：双击窗口 550ms（不能窄于系统的 500ms），拖选 5px，双击 6px', () => {
  assert.equal(GESTURE_DEFAULTS.doubleClickMs, 550)
  assert.equal(GESTURE_DEFAULTS.dragMinDistance, 5)
  assert.equal(GESTURE_DEFAULTS.doubleClickSlop, 6)
})

test('drag：按下后移动超过阈值再松开，报 drag 且带按下点', () => {
  const target = detector()
  target.push(sample(true, 100, 100, 1000))
  target.push(sample(true, 111, 100, 1016))
  target.push(sample(false, 120, 100, 1032))
  assert.equal(target.gestures.length, 1)
  const [gesture] = target.gestures
  assert.equal(gesture.kind, 'drag')
  assert.equal(gesture.x, 120)
  assert.equal(gesture.y, 100)
  assert.equal(gesture.downX, 100)
  assert.equal(gesture.downY, 100)
  assert.equal(gesture.distance, 20)
  assert.equal(gesture.time, 1032)
})

test('drag：松开点回到按下点附近，但中途移动过——仍按最大位移算 drag', () => {
  const target = detector()
  target.push(sample(true, 100, 100, 0))
  target.push(sample(true, 160, 100, 20))
  target.push(sample(false, 102, 100, 40))
  assert.equal(target.gestures.length, 1)
  assert.equal(target.gestures[0].kind, 'drag')
  assert.equal(target.gestures[0].distance, 60)
})

test('drag：位移刚好等于阈值（5px）也算拖选（阈值为 >=）', () => {
  const target = detector()
  target.push(sample(true, 100, 100, 0))
  target.push(sample(false, 105, 100, 40))
  assert.deepEqual(target.gestures.map((gesture) => gesture.kind), ['drag'])
})

test('单击：位移不足阈值、又不是任何一次点击的第二下——不产生手势', () => {
  const target = detector()
  click(target, 200, 200, 0, 80)
  click(target, 200, 200, 5000, 80)
  assert.deepEqual(target.gestures, [])
})

test('两次独立单击（间隔 551ms）不能被拼成双击', () => {
  const target = detector()
  click(target, 300, 300, 0, 60) // 第一下：0~60
  click(target, 300, 300, 611, 60) // 第二下按下距上次松开 551ms > 550
  assert.deepEqual(target.gestures, [])
  assert.deepEqual(target.presses.map((press) => press.second), [false, false])
})

test('双击：间隔 400ms 报 double（这一档正是老默认 420 会漏掉、系统却已经选好词的地方）', () => {
  const target = detector()
  click(target, 300, 300, 0, 60) // 松开在 t=60
  click(target, 300, 300, 460, 60) // 第二下按下距上次松开 400ms
  assert.deepEqual(target.gestures.map((gesture) => gesture.kind), ['double'])
  assert.deepEqual(target.presses.map((press) => press.second), [false, true])
})

test('双击：间隔 480ms（>老默认 420、<系统 500）仍报 double', () => {
  const target = detector()
  click(target, 300, 300, 0, 60)
  click(target, 300, 300, 540, 60) // 480ms
  assert.deepEqual(target.gestures.map((gesture) => gesture.kind), ['double'])
})

test('双击边界：间隔恰好 550ms 仍算双击（<=），551ms 不算', () => {
  const inside = detector()
  click(inside, 300, 300, 0, 60)
  click(inside, 300, 300, 610, 60) // 550ms
  assert.deepEqual(inside.gestures.map((gesture) => gesture.kind), ['double'])

  const justOutside = detector()
  click(justOutside, 300, 300, 0, 60)
  click(justOutside, 300, 300, 611, 60) // 551ms
  assert.deepEqual(justOutside.gestures, [])
})

test('双击：第二下位置偏离 6px 以内算双击，超过 6px 不算', () => {
  const near = detector()
  click(near, 300, 300, 0, 60)
  click(near, 306, 300, 300, 60) // 偏 6px
  assert.deepEqual(near.gestures.map((gesture) => gesture.kind), ['double'])

  const far = detector()
  click(far, 300, 300, 0, 60)
  click(far, 307, 300, 300, 60) // 偏 7px
  assert.deepEqual(far.gestures, [])
})

test('双击窗口可配置：仍可收紧回 420ms（老调用方显式传参不受默认值改动影响）', () => {
  const target = detector({ doubleClickMs: 420 })
  click(target, 300, 300, 0, 60)
  click(target, 300, 300, 540, 60) // 480ms：默认 550 会算双击，420 不算
  assert.deepEqual(target.gestures, [])
  click(target, 300, 300, 600, 60) // 距上次松开 60ms → 双击
  assert.deepEqual(target.gestures.map((gesture) => gesture.kind), ['double'])
})

test('双击的第二下如果拖开了，按拖选处理（不能既算双击又算拖选）', () => {
  const target = detector()
  click(target, 300, 300, 0, 60)
  target.push(sample(true, 300, 300, 200))
  target.push(sample(true, 340, 300, 240))
  target.push(sample(false, 340, 300, 280))
  assert.deepEqual(target.gestures.map((gesture) => gesture.kind), ['drag'])
})

test('拖选之后紧跟的一次点击不会被当成"双击的第二下"', () => {
  const target = detector()
  target.push(sample(true, 100, 100, 0))
  target.push(sample(false, 140, 100, 60)) // drag，松开在 t=60
  target.push(sample(true, 140, 100, 100)) // 40ms 后按下同一位置
  assert.deepEqual(target.presses.map((press) => press.second), [false, false])
  target.push(sample(false, 140, 100, 140))
  assert.deepEqual(target.gestures.map((gesture) => gesture.kind), ['drag'])
})

test('onPress：按下即回调，带坐标/时间，第二下标 second=true', () => {
  const target = detector()
  target.push(sample(true, 10, 20, 1234))
  assert.deepEqual(target.presses, [{ x: 10, y: 20, time: 1234, second: false }])
  target.push(sample(false, 10, 20, 1300))
  target.push(sample(true, 10, 20, 1400))
  assert.deepEqual(target.presses[1], { x: 10, y: 20, time: 1400, second: true })
})

test('按住期间重复的 down 采样不会重复触发 onPress，也不重复计位移', () => {
  const target = detector()
  target.push(sample(true, 100, 100, 0))
  target.push(sample(true, 104, 100, 16))
  target.push(sample(true, 108, 100, 32))
  assert.equal(target.presses.length, 1)
  target.push(sample(false, 108, 100, 48))
  assert.equal(target.gestures[0].distance, 8)
})

test('没有按下就收到 up：忽略（不会凭空产生手势）', () => {
  const target = detector()
  target.push(sample(false, 100, 100, 0))
  assert.deepEqual(target.gestures, [])
  assert.deepEqual(target.presses, [])
})

test('pointInRect：命中/未命中/null 矩形', () => {
  const box = { left: 100, top: 100, right: 200, bottom: 150 }
  assert.equal(pointInRect({ x: 100, y: 100 }, box), true)
  assert.equal(pointInRect({ x: 200, y: 150 }, box), true)
  assert.equal(pointInRect({ x: 201, y: 150 }, box), false)
  assert.equal(pointInRect({ x: 150, y: 99 }, box), false)
  assert.equal(pointInRect({ x: 150, y: 120 }, null), false)
  assert.equal(pointInRect({ x: 150, y: 120 }, undefined), false)
})
