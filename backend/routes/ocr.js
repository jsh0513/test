// OCR 识别路由：接收图片，使用 tesseract.js 识别文字，并解析运单字段回填表单
const express = require('express');
const multer = require('multer');
const { recognizeText } = require('../ocrEngine');
const { authRequired } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 与前端选项保持一致，保证回填下拉框合法
const CARGO_OPTIONS = ['普通货物', '电子产品', '服装', '生鲜', '家具', '药品', '食品', '冷链物资', '建材', '其他'];
const VEHICLE_OPTIONS = ['厢式货车', '平板车', '冷链车', '半挂'];

// 货物别名 → 标准下拉选项（识别常见同义写法）
const CARGO_ALIASES = [
  ['普货', '普通货物'], ['电器', '电子产品'], ['家电', '电子产品'], ['手机', '电子产品'], ['电脑', '电子产品'],
  ['衣物', '服装'], ['纺织', '服装'], ['服饰', '服装'],
  ['水果', '生鲜'], ['蔬菜', '生鲜'], ['海鲜', '生鲜'], ['水产', '生鲜'], ['冷冻', '冷链物资'], ['冷藏', '冷链物资'], ['冻品', '冷链物资'],
  ['医药', '药品'], ['钢材', '建材'], ['水泥', '建材'], ['沙石', '建材'],
];
// 车型别名 → 标准下拉选项
const VEHICLE_ALIASES = [
  ['厢货', '厢式货车'], ['厢车', '厢式货车'], ['封闭货车', '厢式货车'],
  ['冷藏车', '冷链车'], ['保温车', '冷链车'], ['冷车', '冷链车'],
  ['高栏', '平板车'], ['栏板', '平板车'],
  ['挂车', '半挂'], ['牵引车', '半挂'], ['集装箱', '半挂'],
];

// 从 OCR 文本中解析运单字段
function parseFields(rawText) {
  const fields = {};
  if (!rawText) return fields;

  const raw = String(rawText).replace(/\r/g, '');
  // tesseract 识别中文时常在字与字之间插入空格，压缩空白后按关键词解析
  const t = raw.replace(/[ \t ]+/g, '');
  if (!t.trim()) return fields;

  // ---------- 1) 调度单行式解析："装 上海仓 芝郁杭州站"（动词 + 起点 + 终点） ----------
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const loadLine = lines.find(s => /^(装货地点|装货地|装货|装|发货地|发货|起运地|起运|始发地|始发)/.test(s) && s.length > 1);
  if (loadLine) {
    const body = loadLine.replace(/^(装货地点|装货地|装货|装|发货地|发货|起运地|起运|始发地|始发)[：:＝=]*/, '').trim();
    const segs = body.split(/\s+/).filter(Boolean);
    if (segs.length >= 2 && segs[0].length >= 2) {
      fields.origin = segs[0];
      fields.destination = segs.slice(1).join('').replace(/^(卸货|卸|收货|送达|送到|目的地|目的)/, '');
    } else if (segs.length === 1) {
      const parts = body.split(/(?:卸|至|→|—)/).filter(Boolean);
      if (parts.length >= 2 && parts[0].length >= 2) {
        fields.origin = parts[0];
        fields.destination = parts.slice(1).join('');
      }
    } else if (segs.length) {
      fields.origin = segs.join('');
    }
  }
  if (!fields.destination) {
    const unloadLine = lines.find(s => /^(卸货地点|卸货地|卸货|卸|收货地点|收货地|收货|目的地|目的|送达|送到)/.test(s) && s.length > 1);
    if (unloadLine) {
      const body = unloadLine.replace(/^(卸货地点|卸货地|卸货|卸|收货地点|收货地|收货|目的地|目的|送达|送到)[：:＝=]*/, '').trim();
      if (body) fields.destination = body.split(/\s+/).join('');
    }
  }

  // ---------- 2) 关键词解析（行式未命中时兜底） ----------
  const aliasStops = [...CARGO_ALIASES.map(a => a[0]), ...VEHICLE_ALIASES.map(a => a[0])].join('|');
  const placeStop = `卸|运费|货物|品名|商品|重量|车型|车辆|车种|备注|说明|加急|紧急|优先|SLA|时效|吨|元|￥|¥|${CARGO_OPTIONS.join('|')}|${VEHICLE_OPTIONS.join('|')}|${aliasStops}|[\\n,，;；。]|$`;
  const placeChar = '[一-龥A-Za-z0-9.]{2,20}?';

  // 起点
  if (!fields.origin) {
    const m = t.match(new RegExp(`(?:起运地|起始地|发货地|始发地|装货地点|装货地|装货城市|发货城市|装货|起点|起运|发货|始发|装)[：:＝=\\s]*(${placeChar})(?=${placeStop})`));
    if (m) {
      const v = m[1].replace(/^(地点|地址|城市|地)/, '').replace(/[.\s]+$/, '').trim();
      if (v) fields.origin = v;
    }
  }

  // 终点
  if (!fields.destination) {
    const m = t.match(new RegExp(`(?:卸货地点|卸货地|卸货城市|卸货|收货地点|收货地|收货|目的地|目的|终点|终到|送达|送到|卸)[：:＝=\\s]*(${placeChar})(?=${placeStop})`));
    if (m) {
      const v = m[1].replace(/^(地点|地址|城市|地)/, '').replace(/[.\s]+$/, '').trim();
      if (v) fields.destination = v;
    }
  }

  // "A→B / A至B" 起终点连写
  if (!fields.origin && !fields.destination) {
    for (const line of lines) {
      const tok = line.split(/\s+/).find(s => s.includes('→') || s.includes('->'));
      if (!tok) continue;
      const sides = tok.split(/→|->/).filter(Boolean);
      if (sides.length >= 2 && sides[0].length >= 2 && sides[1].length >= 2) {
        fields.origin = sides[0];
        fields.destination = sides.slice(1).join('');
        break;
      }
    }
    if (!fields.origin && !fields.destination) {
      const m = t.match(/([一-龥A-Za-z0-9]{2,12}?)(?:→|->|至)([一-龥A-Za-z0-9]{2,12}?)(?=${placeStop})/);
      if (m) { fields.origin = m[1]; fields.destination = m[2]; }
    }
  }

  // 货物类型
  let cargoHit = CARGO_OPTIONS.find(c => t.includes(c));
  if (!cargoHit) {
    const alias = CARGO_ALIASES.find(([kw]) => t.includes(kw));
    if (alias) cargoHit = alias[1];
  }
  if (cargoHit) fields.cargo = cargoHit;

  // 车型
  let vehicleHit = VEHICLE_OPTIONS.find(v => t.includes(v));
  if (!vehicleHit) {
    const alias = VEHICLE_ALIASES.find(([kw]) => t.includes(kw));
    if (alias) vehicleHit = alias[1];
  }
  if (vehicleHit) fields.recommended_vehicle_type = vehicleHit;

  // 重量
  const mw = t.match(/(\d+(?:\.\d+)?)\s*吨/) || t.match(/(?:重量|载重)[：:＝=]\s*(\d+(?:\.\d+)?)/);
  if (mw) fields.weight = Number(mw[1]);

  // 运费
  const mf = t.match(/(?:运费|金额|费用)[：:＝=\s]*[￥¥]?\s*(?:RMB|rmb)?\s*(\d+(?:\.\d+)?)/)
    || t.match(/[￥¥]\s*(\d+(?:\.\d+)?)/)
    || t.match(/(\d+(?:\.\d+)?)\s*元/);
  if (mf) {
    fields.freight = Number(mf[1]);
  } else {
    // 行内孤立金额兜底
    for (const line of lines) {
      if (/T-\d|20\d{2}[-/.]\d|\d{1,2}:\d{2}/.test(line)) continue;
      if (!/吨|SLA|运费|车|货/.test(line)) continue;
      const lm = line.match(/[""''\s](\d{3,5})(?:\s*$|[""''\s])/) || line.match(/(\d{3,5})\s*$/);
      if (lm) { fields.freight = Number(lm[1]); break; }
    }
    if (fields.freight == null) {
      const tail = t.match(/(?<![:：\d-])(\d{2,6})(?:元|块)?[。.，,！!]?\s*$/);
      if (tail) fields.freight = Number(tail[1]);
    }
  }

  // SLA
  const ms_ = t.match(/(\d{1,3})\s*(?:个小时|小时|h|H)(?!\d)/);
  if (ms_ && Number(ms_[1]) >= 1 && Number(ms_[1]) <= 96) fields.sla_hours = Number(ms_[1]);

  // 加急
  if (/加急|紧急|优先/.test(t)) fields.is_urgent = true;

  // 备注
  const mr = t.match(/(?:备注|说明|注意事项?)[：:＝=\s]*([^\n]{2,100})/);
  if (mr) fields.remarks = mr[1].trim();

  return fields;
}

router.post('/', authRequired(), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: '请上传图片文件' });
    const buffer = req.file.buffer;
    const text = await recognizeText(buffer);
    const fields = parseFields(text);
    res.json({ ok: true, text, fields });
  } catch (err) {
    console.error('[OCR] 失败:', err.message);
    res.status(500).json({ message: 'OCR 识别失败：' + err.message });
  }
});

module.exports = router;
