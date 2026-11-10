/**
 * 抓取屏幕区域为 32bpp BMP（验收/排障用）。
 * 从屏幕 DC 做 BitBlt，分层窗口的 alpha 结果会被如实抓到。
 *
 * 绑定只建一次：koffi 的类型名是全局的，重复 koffi.struct 同名字会报
 * "Duplicate type name"（踩过）。
 */
import { writeFileSync } from 'node:fs'

let cached = null

function bindings(api) {
  if (cached !== null) return cached
  const koffi = api.koffi
  const HEADER = koffi.struct('DST_CAP_BITMAPINFOHEADER', {
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
  cached = {
    koffi,
    HEADER,
    getScreenDc: api.user32.func('void *GetDC(void *hwnd)'),
    releaseDc: api.user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
    createCompatibleDc: api.gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    deleteDc: api.gdi32.func('int DeleteDC(void *hdc)'),
    selectObject: api.gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    deleteObject: api.gdi32.func('int DeleteObject(void *obj)'),
    bitBlt: api.gdi32.func('int BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32_t rop)'),
    createDib: api.gdi32.func('void *CreateDIBSection(void *hdc, DST_CAP_BITMAPINFOHEADER *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)'),
  }
  return cached
}

/**
 * 抓取屏幕矩形并存成 BMP。
 * @returns { width, height, filePath }
 */
export function captureScreenRect(api, _gdi, x, y, width, height, filePath) {
  const b = bindings(api)
  const koffi = b.koffi
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const screenDc = b.getScreenDc(null)
  const memDc = b.createCompatibleDc(screenDc)
  const header = {
    biSize: koffi.sizeof(b.HEADER),
    biWidth: w,
    biHeight: -h,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: w * h * 4,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  }
  const bitsRef = [null]
  const dib = b.createDib(screenDc, header, 0, bitsRef, null, 0)
  if (dib === null) {
    b.deleteDc(memDc)
    b.releaseDc(null, screenDc)
    throw new Error('CreateDIBSection failed')
  }
  const previous = b.selectObject(memDc, dib)
  try {
    b.bitBlt(memDc, 0, 0, w, h, screenDc, Math.round(x), Math.round(y), 0x00cc0020)
    const pixels = Buffer.from(koffi.decode(bitsRef[0], 'uint8_t', w * h * 4))
    const fileHeader = Buffer.alloc(14)
    fileHeader.write('BM', 0, 'ascii')
    fileHeader.writeUInt32LE(14 + 40 + pixels.length, 2)
    fileHeader.writeUInt32LE(0, 6)
    fileHeader.writeUInt32LE(14 + 40, 10)
    const info = Buffer.alloc(40)
    info.writeUInt32LE(40, 0)
    info.writeInt32LE(w, 4)
    info.writeInt32LE(-h, 8)
    info.writeUInt16LE(1, 12)
    info.writeUInt16LE(32, 14)
    info.writeUInt32LE(0, 16)
    info.writeUInt32LE(pixels.length, 20)
    writeFileSync(filePath, Buffer.concat([fileHeader, info, pixels]))
    return { width: w, height: h, filePath }
  } finally {
    b.selectObject(memDc, previous)
    b.deleteObject(dib)
    b.deleteDc(memDc)
    b.releaseDc(null, screenDc)
  }
}
