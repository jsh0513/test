// OCR 引擎封装：使用 tesseract.js（纯 JS，Node 可直接运行）
// 如需切换为 Paddle-OCR JS 版，替换 recognizeText 内部实现即可，接口签名保持不变。
let worker = null;
let workerPromise = null;

async function getWorker() {
  if (worker) return worker;
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    // 中文简体 + 英文识别
    worker = await createWorker(['chi_sim', 'eng']);
    // 保留词间空格：调度单"装 A B"行式格式依赖空格切分起终点
    try {
      await worker.setParameters({ preserve_interword_spaces: '1' });
    } catch (_) { /* 旧版本不支持时忽略 */ }
    return worker;
  })();
  return workerPromise;
}

async function recognizeText(buffer) {
  const w = await getWorker();
  const { data } = await w.recognize(buffer);
  return data.text || '';
}

module.exports = { recognizeText };
