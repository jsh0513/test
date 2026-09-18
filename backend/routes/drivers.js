const express = require('express');
const router = express.Router();
const db = require('../db');
const {
  MOCK_DRIVERS, MOCK_TASKS, MOCK_VIOLATIONS, MOCK_DRIVER_CHANGE_LOGS,
  buildAttendance, authRequired, pushDriverChangeLog, maintenanceInfo,
  notifyAdmins, addDriverMeta,
} = db;

// 计算司机是否"任务中"(存在未结束在途任务：待发车/进行中/已延误/已超时/未完成异常)
function recalcDriverStatus(driver) {
  if (['已停用', '待审核', '请假', '休假'].includes(driver.status)) return;
  const hasRunning = MOCK_TASKS.some(t => t.driver_id === driver.id &&
    !['已完成', '已取消'].includes(t.status) && !(t.status === '异常' && t.complete_time));
  driver.status = hasRunning ? '任务中' : '空闲';
}

function enrich(d) {
  recalcDriverStatus(d);
  return d;
}

// ---------- 静态路由（放在 /:id 之前，避免被参数路由吞掉） ----------

// 待审核司机列表（人员变动模块）
// 管理员：可看全部待审核申请；调度员：只能看到自己提交的申请
router.get('/pending/all', authRequired(), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const all = MOCK_DRIVERS
    .filter(d => d.audit_status === 'pending')
    .filter(d => isAdmin || d.creator_id === req.user.id)
    .map(d => ({ ...d }));
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 10));
  const total = all.length;
  const start = (page - 1) * pageSize;
  const list = all.slice(start, start + pageSize);
  res.json({ list, total, page, pageSize });
});

// 司机状态变更记录（人员变动-管理员页面）
router.get('/change-logs/all', authRequired(), (req, res) => {
  // 只返回允许展示的操作类型
  const all = MOCK_DRIVER_CHANGE_LOGS.filter(l => l.allowed !== false);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 10));
  const total = all.length;
  const start = (page - 1) * pageSize;
  const list = all.slice(start, start + pageSize);
  res.json({ list, total, page, pageSize });
});

// 空闲司机(用于派发下拉)：只有"空闲"才可被派发，请假/休假/任务中一律排除，避免一人多单
router.get('/list/available', authRequired(), (req, res) => {
  const list = MOCK_DRIVERS
    .filter(d => d.audit_status === 'approved')
    .map(d => { const n = { ...d }; enrich(n); return n; })
    .filter(d => d.status === '空闲');
  res.json({ list });
});

// 出勤日历（按年月）
router.get('/:id/attendance', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month) || (new Date().getMonth() + 1);
  const list = buildAttendance(id, year, month);
  const stats = { '出勤': 0, '请假': 0, '缺勤': 0, '休假': 0 };
  for (const item of list) {
    if (stats[item.status] !== undefined) stats[item.status]++;
  }
  res.json({ list, stats, year, month });
});

// 接单历史（按年月）
router.get('/:id/tasks', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month) || (new Date().getMonth() + 1);
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const list = MOCK_TASKS
    .filter(t => t.driver_id === id)
    .filter(t => {
      const ref = String(t.dispatch_time || t.complete_time || t.departure_time || t.create_time || '');
      return ref.slice(0, 7) === ym;
    })
    .sort((a, b) => String(b.dispatch_time || b.create_time || '').localeCompare(String(a.dispatch_time || a.create_time || '')));
  res.json({ list, year, month, total: list.length });
});

// 违章记录（按年月）
router.get('/:id/violations', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month) || (new Date().getMonth() + 1);
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const list = MOCK_VIOLATIONS
    .filter(v => v.driver_id === id)
    .filter(v => String(v.time || '').slice(0, 7) === ym);
  res.json({ list, year, month, total: list.length });
});

// GET /api/drivers
router.get('/', authRequired(), (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword = '', status = '', city = '', audit_status = '' } = req.query;
    let list = MOCK_DRIVERS.map(d => ({ ...d }));
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(kw) || d.phone.includes(kw) || d.plate.toLowerCase().includes(kw));
    }
    if (status)       list = list.filter(d => d.status === status);
    if (city)         list = list.filter(d => d.city === city);
    if (audit_status) list = list.filter(d => d.audit_status === audit_status);

    list.forEach(enrich);

    const total = list.length;
    const offset = (Number(page) - 1) * Number(pageSize);
    list = list.slice(offset, offset + Number(pageSize));
    res.json({ list, total });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST 新增司机(调度员录入注册申请)——默认为待审核
router.post('/', authRequired(), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.phone) return res.status(400).json({ message: '请填写司机姓名和手机号' });
    const d = {
      id: db.driverSeq++,
      audit_status: 'pending',
      status: '待审核',
      rating: 4.5,
      join_date: new Date().toISOString().slice(0, 10),
      // 记录提交人：调度员录入后，待审核列表只对本人可见，管理员可见全部
      creator_id: req.user.id,
      creator_name: req.user.name,
      ...body,
    };
    addDriverMeta(d);
    MOCK_DRIVERS.unshift(d);
    // 通知管理员审核
    notifyAdmins({
      from: req.user.name || '调度员',
      title: `新司机注册申请：${d.name}（${d.plate || d.phone}），请前往「人员变动」审核`,
      type: 'info',
      link: '/personnel',
    });
    res.json(d);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// 停用/启用（管理员可启用；调度员只能停用非任务中司机）
router.post('/:id/toggle-disable', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  const isAdmin = req.user.role === 'admin';
  const before = { status: d.status };
  let actionText = '';
  if (d.status === '已停用') {
    if (!isAdmin) return res.status(403).json({ message: '仅管理员可启用已停用司机' });
    d.status = '空闲';
    d.audit_status = 'approved';
    actionText = '启用';
    pushDriverChangeLog({ driver: d, action: 'enable', before, after: { status: d.status }, user_id: req.user.id, user_name: req.user.name });
  } else {
    if (d.status === '任务中') return res.status(400).json({ message: '任务中司机不能停用' });
    d.status = '已停用';
    actionText = '停用';
    pushDriverChangeLog({ driver: d, action: 'disable', before, after: { status: d.status }, user_id: req.user.id, user_name: req.user.name });
  }
  // 白名单：司机停用/启用操作记录 → 通知管理员
  notifyAdmins({
    from: req.user.name,
    title: `司机「${d.name}（${d.plate}）」已被${actionText}（操作人：${req.user.name}）`,
    type: actionText === '停用' ? 'warning' : 'success',
    link: '/personnel',
  });
  res.json({ ok: true, status: d.status });
});

// 车辆保修登记（body.date 为空=今天完成保修）
router.post('/:id/maintenance', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  const { date } = req.body || {};
  const today = new Date().toISOString().slice(0, 10);
  const newDate = date || today;
  if (date && date > today) return res.status(400).json({ message: '保修日期不能晚于今天' });
  const before = { last_maintenance: d.last_maintenance || '' };
  d.last_maintenance = newDate;
  pushDriverChangeLog({ driver: d, action: 'maintenance', before, after: { last_maintenance: newDate }, user_id: req.user.id, user_name: req.user.name });
  res.json({ ok: true, maintenance: maintenanceInfo(d) });
});

// PUT 修改
router.put('/:id', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  const body = req.body || {};
  // 记录变更前快照（仅记录可编辑字段）
  const before = {
    name: d.name, phone: d.phone, plate: d.plate, city: d.city,
    vehicle_type: d.vehicle_type, status: d.status, age: d.age, gender: d.gender,
  };
  Object.assign(d, body);
  if (body.audit_status === 'approved' && d.status === '待审核') d.status = '空闲';
  if (body.audit_status === 'rejected') d.status = '已停用';
  const after = {
    name: d.name, phone: d.phone, plate: d.plate, city: d.city,
    vehicle_type: d.vehicle_type, status: d.status, age: d.age, gender: d.gender,
  };
  pushDriverChangeLog({ driver: d, action: 'edit', before, after, user_id: req.user.id, user_name: req.user.name });
  res.json({ ok: true });
});

// DELETE (仅管理员)
router.delete('/:id', authRequired(['admin']), (req, res) => {
  const id = Number(req.params.id);
  const idx = MOCK_DRIVERS.findIndex(d => d.id === id);
  if (idx < 0) return res.status(404).json({ message: '司机不存在' });
  const d = MOCK_DRIVERS[idx];
  pushDriverChangeLog({ driver: d, action: 'delete', before: { status: d.status }, after: {}, user_id: req.user.id, user_name: req.user.name });
  MOCK_DRIVERS.splice(idx, 1);
  res.json({ ok: true });
});

// 审核通过/驳回(仅管理员)
router.post('/:id/audit', authRequired(['admin']), (req, res) => {
  const id = Number(req.params.id);
  const { pass, reason = '' } = req.body || {};
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  const before = { status: d.status, audit_status: d.audit_status };
  d.audit_status = pass ? 'approved' : 'rejected';
  d.status = pass ? '空闲' : '已停用';
  pushDriverChangeLog({
    driver: d,
    action: pass ? 'audit_pass' : 'audit_reject',
    before,
    after: { status: d.status, audit_status: d.audit_status, reason: pass ? '' : reason },
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ ok: true });
});

// 司机详情(基础信息 + 统计 + 保修 + 当月接单 + 当月出勤)
router.get('/:id/detail', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const d = MOCK_DRIVERS.find(x => x.id === id);
  if (!d) return res.status(404).json({ message: '司机不存在' });
  enrich(d);

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const tasksOfDriver = MOCK_TASKS.filter(t => t.driver_id === id);
  const completed = tasksOfDriver.filter(t => t.status === '已完成').length;
  const ongoing   = tasksOfDriver.filter(t => ['进行中', '已延误', '已超时'].includes(t.status)).length;
  const cancelled = tasksOfDriver.filter(t => t.status === '已取消').length;

  const violations = MOCK_VIOLATIONS.filter(v => v.driver_id === id);
  const attendanceList = buildAttendance(id, year, month);
  const attendStats = { '出勤': 0, '请假': 0, '缺勤': 0, '休假': 0 };
  for (const item of attendanceList) {
    if (attendStats[item.status] !== undefined) attendStats[item.status]++;
  }
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const monthTasks = tasksOfDriver
    .filter(t => String(t.dispatch_time || t.complete_time || t.create_time || '').slice(0, 7) === ym)
    .sort((a, b) => String(b.dispatch_time || b.create_time || '').localeCompare(String(a.dispatch_time || a.create_time || '')));

  res.json({
    driver: d,
    stats: {
      task_total: tasksOfDriver.length,
      completed, ongoing, cancelled,
      total_weight: tasksOfDriver.reduce((s, t) => s + (Number(t.weight) || 0), 0).toFixed(1),
      total_trip_mileage: tasksOfDriver.reduce((s, t) => s + (Number(t.trip_mileage) || 0), 0),
      violations: violations.length,
    },
    maintenance: maintenanceInfo(d),
    tasks: tasksOfDriver,
    tasksMonth: { list: monthTasks, year, month, total: monthTasks.length },
    violations,
    attendance: { list: attendanceList, stats: attendStats, year, month },
  });
});

module.exports = router;
