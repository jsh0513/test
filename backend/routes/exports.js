// 导出：任务 Excel / 出勤记录 Excel / 对账表 Excel（支持按筛选 + 已选 IDs 下载）
const express = require('express');
const XLSX = require('xlsx');
const router = express.Router();
const {
  MOCK_TASKS, MOCK_DRIVERS, authRequired, getTaskTimelyFlag, buildAttendance,
  getTaskDeadlineMs, parseD,
} = require('../db');

// 本地时区时间格式化（避免 toISOString 导致 UTC 偏差）
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtLocal(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(Number(v));
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 状态兜底：与 tasks.js decorate() 的推导规则保持一致
function effectiveStatus(t) {
  const base = t.status || (t.dispatch_time ? (t.departure_time ? '进行中' : '待发车') : '待派发');
  // 只有派发后且发车后，才会进入超时判定
  if ((base === '进行中' || base === '已延误') && t.departure_time) {
    const tf = getTaskTimelyFlag(t);
    if (tf.overtime) return '已超时';
  }
  return base;
}

// 生成 xlsx 文件 Buffer：aoa 为二维数组（首行为表头），widths 为每列字符宽度
function buildXlsxBuf(aoa, widths, sheetName) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = widths.map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.end(Buffer.from(buf, 'binary'));
}

function filterIds(list, idsParam) {
  if (!idsParam) return list;
  const ids = String(idsParam).split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return list;
  // Tasks use IDs like T-xxx, drivers use numeric IDs
  if (ids.every(x => /^\d+$/.test(x))) {
    const idNums = ids.map(x => Number(x));
    return list.filter(x => idNums.includes(x.id));
  }
  return list.filter(x => ids.includes(x.id));
}

// GET 任务记录 Excel 导出
router.get('/tasks/xlsx', authRequired(), (req, res) => {
  const { keyword = '', start_date = '', end_date = '', status = '', ids = '' } = req.query;
  let list = [...MOCK_TASKS].filter(t => t.published !== false);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(t =>
      t.id.toLowerCase().includes(kw) ||
      t.origin.toLowerCase().includes(kw) ||
      t.destination.toLowerCase().includes(kw)
    );
  }
  // 按有效状态过滤（含已超时推导），与页面列表展示一致
  if (status) list = list.filter(t => effectiveStatus(t) === status);
  if (start_date) list = list.filter(t => (t.publish_time || t.create_time || '').slice(0,10) >= start_date);
  if (end_date)   list = list.filter(t => (t.publish_time || t.create_time || '').slice(0,10) <= end_date);
  list = filterIds(list, ids);

  // 与「历史任务详情」三段信息对齐：基本信息 / 时间信息 / 其他信息
  const header = [
    // 基本信息
    '任务编号','司机','装货地点','卸货地点','货物类型','重量(吨)','推荐车辆类型','状态','是否加急','运费(元)','TRIP小计里程(km)',
    // 时间信息
    '发布时间','派发时间','发车时间','完成时间','最迟发车时间','完成期限(小时)','任务截止时间',
    // 其他信息
    '发车是否超时','任务是否超时','取消原因','备注','附加备注','创建人','调度员',
  ];
  const rows = list.map(t => [
    t.id, t.driver_name || '', t.origin, t.destination, t.cargo, t.weight,
    t.recommended_vehicle_type || '', effectiveStatus(t),
    (t.is_urgent || t.urgent_manual) ? '是' : '否',
    t.freight || 0,
    (t.trip_mileage !== null && t.trip_mileage !== undefined) ? t.trip_mileage : '',
    t.publish_time || '', t.dispatch_time || '', t.departure_time || '', t.complete_time || '',
    t.latest_departure_time || '', t.sla_hours || 8,
    // 任务截止时间严格 = 派发时间 + SLA小时。派发前留空。
    t.dispatch_time ? fmtLocal(getTaskDeadlineMs(t)) : '',
    t.depart_overdue ? '是' : '否',
    t.task_overdue ? '是' : '否',
    t.cancel_reason || '',
    t.remarks || '', t.extra_remarks || '',
    t.creator || '', t.dispatcher_name || '',
  ]);
  const widths = [14,10,12,12,10,9,13,9,9,10,16,18,18,18,18,18,13,18,11,11,16,24,24,10,10];
  const buf = buildXlsxBuf([header, ...rows], widths, '任务记录');
  sendXlsx(res, buf, `任务记录_${new Date().toISOString().slice(0,10)}.xlsx`);
});

// GET 员工出勤记录 Excel 导出（按月或按时间范围）
router.get('/drivers/attendance/xlsx', authRequired(), (req, res) => {
  const { year, month, start_date = '', end_date = '', ids = '' } = req.query;
  let drivers = [...MOCK_DRIVERS];
  drivers = filterIds(drivers, ids);

  // 月份优先；否则尝试时间范围
  let y = Number(year)  || new Date().getFullYear();
  let m = Number(month) || (new Date().getMonth() + 1);
  if (!year && start_date) {
    const d = new Date(String(start_date));
    y = d.getFullYear(); m = d.getMonth() + 1;
  }

  const header = ['司机ID','司机姓名','车牌','日期','出勤状态'];
  const rows = [];
  for (const dr of drivers) {
    const cal = buildAttendance(dr.id, y, m);
    for (const item of cal) {
      if (start_date && item.date < start_date) continue;
      if (end_date   && item.date > end_date)   continue;
      rows.push([dr.id, dr.name, dr.plate, item.date, item.status]);
    }
  }
  const widths = [9,12,14,13,12];
  const buf = buildXlsxBuf([header, ...rows], widths, '员工出勤记录');
  sendXlsx(res, buf, `员工出勤记录_${y}-${pad2(m)}.xlsx`);
});

// GET 订单/运单对账表 Excel 导出
router.get('/reconciliation/xlsx', authRequired(), (req, res) => {
  const { keyword = '', start_date = '', end_date = '', status = '', ids = '' } = req.query;
  let list = [...MOCK_TASKS].filter(t => t.published !== false);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(t =>
      t.id.toLowerCase().includes(kw) ||
      t.origin.toLowerCase().includes(kw) ||
      t.destination.toLowerCase().includes(kw)
    );
  }
  if (status) list = list.filter(t => effectiveStatus(t) === status);
  if (start_date) list = list.filter(t => (t.publish_time || t.create_time || '').slice(0,10) >= start_date);
  if (end_date)   list = list.filter(t => (t.publish_time || t.create_time || '').slice(0,10) <= end_date);
  list = filterIds(list, ids);

  const header = ['任务编号','状态','装货地点','卸货地点','司机','车牌','货物','重量(吨)','TRIP小计里程(km)','推荐车辆类型','是否加急','运费(元)','创建人','调度员','备注'];
  const plateOf = (driverId) => {
    const d = MOCK_DRIVERS.find(x => x.id === Number(driverId));
    return d ? d.plate : '';
  };
  const rows = list.map(t => [
    t.id, effectiveStatus(t), t.origin, t.destination,
    t.driver_name || '', plateOf(t.driver_id), t.cargo, t.weight,
    (t.trip_mileage !== null && t.trip_mileage !== undefined) ? t.trip_mileage : '',
    t.recommended_vehicle_type || '',
    t.is_urgent ? '是' : '否', t.freight || 0,
    t.creator || '', t.dispatcher_name || '', t.remarks || '',
  ]);
  const widths = [14,9,12,12,10,14,10,9,16,13,9,10,10,10,24];
  const buf = buildXlsxBuf([header, ...rows], widths, '订单运单对账表');
  sendXlsx(res, buf, `订单运单对账表_${new Date().toISOString().slice(0,10)}.xlsx`);
});

// GET 报表导出(模拟)
router.get('/report/summary', authRequired(), (req, res) => {
  const status = {};
  const filtered = MOCK_TASKS.filter(t => t.published !== false);
  for (const t of filtered) status[t.status] = (status[t.status] || 0) + 1;
  const over = filtered.filter(t => getTaskTimelyFlag(t) === 'overdue').length;
  const soon = filtered.filter(t => getTaskTimelyFlag(t) === 'soon').length;
  res.json({
    title: '货运司机任务报表 — ' + new Date().toLocaleDateString(),
    total: filtered.length, status, overdue: over, soon,
    exportedAt: new Date().toISOString(),
  });
});

module.exports = router;
