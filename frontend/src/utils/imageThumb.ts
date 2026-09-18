/**
 * 弹窗照片缩略图工具
 *
 * 解决的性能问题：任务照片以 base64 dataURL 存储（单张可达 ~1MB），
 * el-image 直接用原图做 72px 缩略图时，浏览器会在主线程同步解码大图，
 * 与弹窗打开动画抢占同一帧，产生数百毫秒级长任务（Chrome Performance 面板可见）。
 *
 * 方案：createImageBitmap 在浏览器后台线程解码 + canvas 缩到 maxSide 小图，
 * 列表展示用小图（解码成本趋近 0），点击预览仍传原图 preview-src-list，业务不变。
 * 解码失败时回退原图，保证功能可用性不受影响。
 */
export async function makeThumbnail(dataUrl: string, maxSide = 144): Promise<string> {
  try {
    // 非 dataURL（http 链接）由浏览器自带懒解码处理，无需缩略
    if (!dataUrl.startsWith('data:image')) return dataUrl
    const blob = await (await fetch(dataUrl)).blob()
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale))
    c.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = c.getContext('2d')
    if (!ctx) { bmp.close(); return dataUrl }
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    return c.toDataURL('image/jpeg', 0.7)
  } catch (_) {
    return dataUrl
  }
}

/** 批量生成缩略图（顺序处理，避免多张大图同时解码挤占同一时间段） */
export async function makeThumbnails(urls: string[], maxSide = 144): Promise<string[]> {
  const out: string[] = []
  for (const u of urls) out.push(await makeThumbnail(u, maxSide))
  return out
}
