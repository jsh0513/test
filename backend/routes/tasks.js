const express = require('express');
const router = express.Router();
const {
  MOCK_TASKS, MOCK_TASK_LOGS, MOCK_DRIVERS, authRequired,
  pushLog, notifyDispatchers, notifyAdmins, nowFmt, getTaskTimelyFlag, recommendVehicleByCargo, getTaskDeadlineMs, parseD,
} = require('../db');

function recalcDriversStatus() {
  for (const d of MOCK_DRIVERS) {
    // R3: 请假、休假、已停用、待审核：都不能被动摇
    if (['已停用','待审核','请假','休假'].includes(d.status)) continue;
    // 只要存在未结束的在途任务（待发车/进行中/已超时/未完成的异常）即占用司机，避免一人多单
    const hasRunning = MOCK_TASKS.some(t => t.driver_id === d.id &&
      !['已完成', '已取消'].includes(t.status) && !(t.status === '异常' && t.complete_time));
    d.status = hasRunning ? '任务中' : '空闲';
  }
}

// R2/Q3: 截止时间严格 = 派发时间 + SLA（本地时区格式化）。未派发则 deadline = null，绝不按 create_time 估算。
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDeadlineLocal(ms) {
  // 强制防御：0/null/undefined → 一律返回 null。确保前端显示 "—"
  if (!ms || ms <= 0) return null;
  const d = new Date(Number(ms));
  // 使用本地时区（对应 UTC+8 场景），避免 toISOString 的 UTC 偏差
  const yyyy = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  // 防御：不合理的年份（如 1970）也返回 null
  if (yyyy < 2000 || yyyy > 2100) return null;
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}`;
}
function decorate(t) {
  const tf = getTaskTimelyFlag(t);
  // ===== R2 关键强制执行：派发时间不存在或为空字符串 → deadline 强制为 null =====
  // 任何未派发任务（dispatch_time = null / '' / undefined）一律不展示截止时间
  let deadlineRaw = 0;
  let deadlineStr = null;
  if (t && t.dispatch_time && String(t.dispatch_time).trim() !== '') {
    deadlineRaw = Number(getTaskDeadlineMs(t)) || 0;
    if (deadlineRaw > 0) {
      deadlineStr = fmtDeadlineLocal(deadlineRaw);
    }
  }
  // 状态兜底：status 缺失时按流程字段推导，避免前端出现空白状态
  let effStatus = t.status || (t.dispatch_time ? (t.departure_time ? '进行中' : '待发车') : '待派发');
  // 只有派发后且发车后，才会进入超时判定
  if ((effStatus === '进行中' || effStatus === '已延误') && tf.overtime && t.departure_time) {
    effStatus = '已超时';
  }
  return {
    ...t,
    timely: tf.flag,
    deadline: deadlineStr,
    deadline_ms: deadlineRaw,
    countdown: tf.countdown,
    overtime: tf.overtime,
    effective_status: effStatus,
    dispatched: Boolean(t.dispatch_time),
    departed: Boolean(t.departure_time),
    publish_time: t.publish_time || null,
    latest_departure_countdown: (() => {
      if (!t.latest_departure_time) return null;
      const ms = new Date(String(t.latest_departure_time).replace(' ', 'T')).getTime();
      if (Number.isNaN(ms)) return null;
      return Math.floor((ms - Date.now()) / 1000);
    })(),
    // 新字段：发车是否超时 / 任务是否超时 / 管理员手动加急
    depart_overdue: Boolean(t.depart_overdue),
    task_overdue: Boolean(t.task_overdue),
    urgent_manual: Boolean(t.urgent_manual),
  };
}

// ------------------ GET 任务列表（派发中心）--------------------
router.get('/', authRequired(), (req, res) => {
  const { page = 1, pageSize = 10, keyword = '', status = '', driverId = '' } = req.query;
  // 已确认完成的异常任务（有完成时间）归入历史，不在派发跟踪列表
  let list = MOCK_TASKS.filter(t =>
    t.published !== false &&
    !['已完成','已取消'].includes(t.status) &&
    !(t.status === '异常' && t.complete_time)
  );

  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(t =>
      t.id.toLowerCase().includes(kw) ||
      t.origin.toLowerCase().includes(kw) ||
      t.destination.toLowerCase().includes(kw)
    );
  }
  if (status) list = list.filter(t => decorate(t).effective_status === status);
  if (driverId) list = list.filter(t => String(t.driver_id) === String(driverId));

  list = list.map(decorate).sort((a,b) => (b.create_time || '').localeCompare(a.create_time || ''));

  const total = list.length;
  const offset = (Number(page) - 1) * Number(pageSize);
  res.json({ list: list.slice(offset, offset + Number(pageSize)), total });
});

// ------------------ GET 草稿任务列表（任务发布页面） ------------------
// 返回：未发布（左列加急置顶）和 定时发布（右列按发布时间升序）
router.get('/drafts/list', authRequired(['admin']), (req, res) => {
  const all = MOCK_TASKS.filter(t => t.published === false);
  // 左：未发布且未设置定时发布（加急置顶）。设置了定时发布的移到右栏，不再重复显示
  const unpublished = all
    .filter(t => !t.scheduled_at)
    .slice()
    .sort((a,b) => {
      if (Boolean(a.is_urgent) !== Boolean(b.is_urgent)) return a.is_urgent ? -1 : 1;
      return (b.create_time || '').localeCompare(a.create_time || '');
    })
    .map(decorate);
  // 右：已设置 scheduled_at 的定时任务；按发布时间从早到晚(接近现在时间的排最上面)
  const scheduled = all
    .filter(t => t.scheduled_at)
    .sort((a,b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''))
    .map(decorate);
  res.json({ unpublished, scheduled, total: all.length });
});

// ------------------ GET 历史任务 ------------------
router.get('/history', authRequired(), (req, res) => {
  const { page = 1, pageSize = 10, keyword = '', start_date = '', end_date = '', status = '' } = req.query;
  // 历史归档：已完成、已取消、已确认完成的异常任务（异常任务完成后状态标签保留「异常」）
  let list = MOCK_TASKS.filter(t => t.published !== false &&
    (t.status === '已完成' || t.status === '已取消' || (t.status === '异常' && t.complete_time)));
  if (status) list = list.filter(t => t.status === status);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(t =>
      t.id.toLowerCase().includes(kw) || t.origin.toLowerCase().includes(kw) || t.destination.toLowerCase().includes(kw)
    );
  }
  if (start_date) list = list.filter(t => (t.publish_time || t.create_time || '').slice(0,10) >= start_date);
  if (end_date)   list = list.filter(t => (t.publish_time || t.create_time || '').slice(0,10) <= end_date);
  // 按完成时间倒序：新完成的任务在最上面；已取消（无完成时间）排在已完成之后，组内按发布时间倒序
  list = list.map(decorate).sort((a, b) => {
    const ta = a.complete_time || '';
    const tb = b.complete_time || '';
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return (b.publish_time || b.create_time || '').localeCompare(a.publish_time || a.create_time || '');
  });
  const total = list.length;
  const offset = (Number(page) - 1) * Number(pageSize);
  res.json({ list: list.slice(offset, offset + Number(pageSize)), total });
});

// ------------------ GET 紧急任务 ------------------
router.get('/urgent', authRequired(), (req, res) => {
  const list = MOCK_TASKS
    // 预警只针对在途任务（待派发/进行中/已超时）；已完成、已取消、草稿不再预警
    .filter(t => t.published !== false && !['已完成', '已取消'].includes(t.status))
    .map(decorate)
    .filter(t => t.timely === 'overdue' || t.timely === 'soon')
    .sort((a,b) => (a.timely === 'overdue' ? -1 : 1));
  res.json({ list });
});

// ------------------ GET 单条详情 ------------------
router.get('/:id', authRequired(), (req, res) => {
  const t = MOCK_TASKS.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  const logs = MOCK_TASK_LOGS.filter(l => l.task_id === t.id).sort((a,b) => a.id - b.id);
  res.json({ task: decorate(t), logs });
});

// ------------------ POST 新建任务（草稿）--------------------
router.post('/', authRequired(['admin']), (req, res) => {
  const body = req.body || {};
  if (!body.origin || !body.destination) return res.status(400).json({ message: '请填写装货地点与卸货地点' });
  // 校验：最迟发车时间必须晚于当前时间
  if (body.latest_departure_time) {
    const latestMs = parseD(body.latest_departure_time);
    if (!latestMs) return res.status(400).json({ message: '最迟发车时间格式不正确' });
    if (latestMs <= Date.now()) {
      return res.status(400).json({ message: '最迟发车时间不能早于当前时间，无法创建任务' });
    }
  }
  // 校验：定时发布时间必须晚于当前时间（有值时直接进入定时发布栏）
  let scheduled_at = null;
  if (body.scheduled_at) {
    const schedMs = parseD(body.scheduled_at);
    if (!schedMs) return res.status(400).json({ message: '定时发布时间格式不正确' });
    if (schedMs <= Date.now()) return res.status(400).json({ message: '定时发布时间不能早于或等于当前时间' });
    scheduled_at = String(body.scheduled_at);
  }
  const id = `T-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(MOCK_TASKS.length+1).padStart(3,'0')}`;
  const cargo = String(body.cargo || '普通货物');
  const recommended_vehicle_type = String(body.recommended_vehicle_type || recommendVehicleByCargo(cargo));
  const t = {
    id,
    driver_id: null, driver_name: '未分配',
    status: '待派发',
    create_time: nowFmt(), publish_time: null,
    dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
    cancel_reason: '', delayed: false,
    creator: req.user.name, creator_id: req.user.id,
    dispatcher_name: '', dispatcher_id: null,
    sla_hours: Number(body.sla_hours) || 8,
    cargo, weight: Number(body.weight) || 1,
    origin: body.origin, destination: body.destination,
    recommended_vehicle_type,
    remarks: String(body.remarks || ''),
    is_urgent: Boolean(body.is_urgent),
    latest_departure_time: body.latest_departure_time || null,
    freight: Number(body.freight) || 0,
    published: false, scheduled_at,
  };
  MOCK_TASKS.unshift(t);
  pushLog({ task_id: id, type: 'create', user_id: req.user.id, user_name: req.user.name,
    detail: `创建任务(${t.origin} → ${t.destination}，货物：${t.cargo}，重量：${t.weight}吨，SLA：${t.sla_hours}小时，推荐车型：${t.recommended_vehicle_type}${t.is_urgent?'，加急':''})` });
  res.json({ ok: true, id });
});

// ------------------ POST 发布单条 ------------------
router.post('/:id/publish', authRequired(['admin']), (req, res) => {
  const id = req.params.id;
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (t.published) return res.status(400).json({ message: '该任务已发布过' });
  t.published = true;
  t.scheduled_at = null;
  t.status = '待派发';
  t.publish_time = nowFmt();   // 新增：记录真正的发布时间
  pushLog({ task_id: id, type: 'edit', user_id: req.user.id, user_name: req.user.name, detail: '发布任务（从草稿进入派发中心）' });
  // 白名单：普通发布不推送；加急任务发布 → 调度员核心预警
  if (t.is_urgent || t.urgent_manual) {
    notifyDispatchers({
      from: req.user.name,
      title: `新加急任务 ${id} 已发布：${t.origin} → ${t.destination}，请优先派发`,
      type: 'warning', core: true, link: '/tasks',
    });
  }
  res.json({ ok: true });
});

// ------------------ POST 一键发布全部草稿 ------------------
router.post('/bulk/publish-all', authRequired(['admin']), (req, res) => {
  let count = 0;
  let urgentCount = 0;
  for (const t of MOCK_TASKS) {
    if (t.published === false) {
      const isUrgent = Boolean(t.is_urgent || t.urgent_manual);
      t.published = true; t.scheduled_at = null; t.status = '待派发';
      t.publish_time = nowFmt();   // 新增：记录真正的发布时间
      pushLog({ task_id: t.id, type: 'edit', user_id: req.user.id, user_name: req.user.name, detail: '一键发布：从草稿进入派发中心' });
      if (isUrgent) urgentCount++;
      count++;
    }
  }
  // 白名单：一键发布中含加急任务 → 汇总一条核心预警给调度员
  if (urgentCount > 0) {
    notifyDispatchers({
      from: req.user.name,
      title: `${urgentCount} 条加急任务已随一键发布进入派发中心，请优先派发`,
      type: 'warning', core: true, link: '/tasks',
    });
  }
  res.json({ ok: true, count });
});

// ------------------ POST 批量定时发布（给勾选的草稿统一设置定时发布时间） ------------------
router.post('/bulk/schedule', authRequired(['admin']), (req, res) => {
  const { ids = [], scheduled_at } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: '请选择需要定时发布的任务' });
  if (!scheduled_at) return res.status(400).json({ message: '请选择统一的定时发布时间' });
  const scheduledMs = parseD(scheduled_at);
  if (!scheduledMs) return res.status(400).json({ message: '定时发布时间格式不正确' });
  if (scheduledMs <= Date.now()) {
    return res.status(400).json({ message: '定时发布时间不能早于或等于当前时间，请选择未来的时间' });
  }
  let count = 0;
  for (const id of ids) {
    const t = MOCK_TASKS.find(x => x.id === id);
    if (!t) continue;
    if (t.published !== false || t.scheduled_at) continue;
    t.scheduled_at = String(scheduled_at);
    pushLog({ task_id: id, type: 'edit', user_id: req.user.id, user_name: req.user.name, detail: `批量设置定时发布：${scheduled_at}` });
    count++;
  }
  res.json({ ok: true, count, scheduled_at });
});

// ------------------ POST 批量删除草稿 ------------------
router.post('/bulk/delete', authRequired(['admin']), (req, res) => {
  const { ids = [] } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: '请选择需要删除的任务' });
  let count = 0;
  for (const id of ids) {
    const idx = MOCK_TASKS.findIndex(x => x.id === id);
    if (idx < 0) continue;
    const t = MOCK_TASKS[idx];
    if (t.published !== false) continue;
    pushLog({ task_id: id, type: 'cancel', user_id: req.user.id, user_name: req.user.name, detail: `删除草稿任务` });
    MOCK_TASKS.splice(idx, 1);
    count++;
  }
  res.json({ ok: true, count });
});

// ------------------ POST 批量创建任务（存草稿，除任务编号外内容一致） ------------------
router.post('/bulk/create', authRequired(['admin']), (req, res) => {
  const body = req.body || {};
  if (!body.origin || !body.destination) return res.status(400).json({ message: '请填写装货地点与卸货地点' });
  const count = Math.max(1, Math.min(50, Number(body.count) || 1));
  if (body.latest_departure_time) {
    const latestMs = parseD(body.latest_departure_time);
    if (!latestMs) return res.status(400).json({ message: '最迟发车时间格式不正确' });
    if (latestMs <= Date.now()) return res.status(400).json({ message: '最迟发车时间不能早于当前时间，无法创建任务' });
  }
  let scheduled_at = null;
  if (body.scheduled_at) {
    const schedMs = parseD(body.scheduled_at);
    if (!schedMs) return res.status(400).json({ message: '定时发布时间格式不正确' });
    if (schedMs <= Date.now()) return res.status(400).json({ message: '定时发布时间不能早于或等于当前时间' });
    scheduled_at = String(body.scheduled_at);
  }
  const created = [];
  for (let i = 0; i < count; i++) {
    const id = `T-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(MOCK_TASKS.length+1).padStart(3,'0')}`;
    const cargo = String(body.cargo || '普通货物');
    const recommended_vehicle_type = String(body.recommended_vehicle_type || recommendVehicleByCargo(cargo));
    const t = {
      id, driver_id: null, driver_name: '未分配', status: '待派发',
      create_time: nowFmt(), publish_time: null,
      dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
      cancel_reason: '', delayed: false,
      creator: req.user.name, creator_id: req.user.id,
      dispatcher_name: '', dispatcher_id: null,
      sla_hours: Number(body.sla_hours) || 8,
      cargo, weight: Number(body.weight) || 1,
      origin: body.origin, destination: body.destination,
      recommended_vehicle_type,
      remarks: String(body.remarks || ''),
      is_urgent: Boolean(body.is_urgent),
      latest_departure_time: body.latest_departure_time || null,
      freight: Number(body.freight) || 0,
      published: false, scheduled_at,
    };
    MOCK_TASKS.unshift(t);
    pushLog({ task_id: id, type: 'create', user_id: req.user.id, user_name: req.user.name,
      detail: `批量创建任务(第${i+1}条，共${count}条：${t.origin} → ${t.destination}，${t.cargo}，${t.weight}吨)` });
    created.push(id);
  }
  res.json({ ok: true, count: created.length, ids: created });
});

// ------------------ POST 取消定时发布（回到草稿） ------------------
router.post('/:id/cancel-schedule', authRequired(['admin']), (req, res) => {
  const id = req.params.id;
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (!t.scheduled_at) return res.status(400).json({ message: '该任务未设置定时发布' });
  if (t.published !== false) return res.status(400).json({ message: '该任务已发布，无法取消定时' });
  const prev = t.scheduled_at;
  t.scheduled_at = null;
  pushLog({ task_id: id, type: 'edit', user_id: req.user.id, user_name: req.user.name,
    detail: `取消定时发布（原定：${prev}），任务回到草稿待发布栏` });
  res.json({ ok: true });
});

// ------------------ POST 定时发布 ------------------
router.post('/:id/schedule', authRequired(['admin']), (req, res) => {
  const id = req.params.id;
  const { scheduled_at } = req.body || {};
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (!scheduled_at) return res.status(400).json({ message: '请选择定时发布的时间' });
  // 校验：定时发布时间必须晚于当前时间
  const scheduledMs = parseD(scheduled_at);
  if (!scheduledMs) return res.status(400).json({ message: '定时发布时间格式不正确' });
  if (scheduledMs <= Date.now()) {
    return res.status(400).json({ message: '定时发布时间不能早于或等于当前时间，请选择未来的时间' });
  }
  t.scheduled_at = String(scheduled_at);
  pushLog({ task_id: id, type: 'edit', user_id: req.user.id, user_name: req.user.name, detail: `设置定时发布：${scheduled_at}` });
  res.json({ ok: true, scheduled_at: t.scheduled_at });
});

// ------------------ PUT 修改任务 ------------------
router.put('/:id', authRequired(), (req, res) => {
  const id = req.params.id;
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  const body = req.body || {};
  const changes = [];
  const modKeys = ['driver_id','driver_name','origin','destination','cargo','weight','sla_hours','status','cancel_reason','recommended_vehicle_type',
                   'remarks','extra_remarks','is_urgent','latest_departure_time','freight'];
  const labelMap = {
    driver_name: '指派司机', origin: '装货地点(起点)', destination: '卸货地点(终点)',
    cargo: '货物类型', weight: '重量(吨)', sla_hours: '完成期限(小时)', status: '状态',
    cancel_reason: '取消原因', recommended_vehicle_type: '推荐车辆类型',
    remarks: '备注', extra_remarks: '附加备注', is_urgent: '是否加急', latest_departure_time: '最迟发车时间', freight: '运费(元)',
  };
  for (const k of modKeys) {
    // 关键修复：只处理请求体中携带的字段。此前未传的 status 被当成 '' 写回，
    // 导致修改附加备注后任务状态被清空、状态按钮丢失
    if (!(k in body)) continue;
    const nv = body[k] === null ? '' : body[k];
    const ov = t[k] === undefined || t[k] === null ? '' : t[k];
    if (nv === ov) continue;
    // 最迟发车时间：若被修改，必须晚于当前时间（防止把时间改到过去）
    if (k === 'latest_departure_time' && nv) {
      const ldMs = parseD(nv);
      if (!ldMs) return res.status(400).json({ message: '最迟发车时间格式不正确' });
      if (ldMs <= Date.now()) {
        return res.status(400).json({ message: '最迟发车时间不能早于或等于当前时间，请选择未来的时间' });
      }
    }
    if (k === 'extra_remarks') {
      // 附加信息的变更日志只标注修改人与动作，不显示具体内容
      changes.push('修改了附加信息');
    } else {
      changes.push(`${labelMap[k] || k}：${JSON.stringify(ov)} → ${JSON.stringify(nv)}`);
    }
    t[k] = body[k];
  }
  if (changes.length) {
    pushLog({ task_id: id, type: 'edit', user_id: req.user.id, user_name: req.user.name, detail: '修改任务：' + changes.join('；') });
    // 白名单：调度员接收「任务信息已更新」
    if (t.published !== false) {
      notifyDispatchers({ from: req.user.name, title: `任务 ${id} 信息已更新（${t.origin} → ${t.destination}）`, type: 'info', link: '/tasks' });
    }
  }
  recalcDriversStatus();
  res.json({ ok: true });
});

// ------------------ POST 派发任务（R2：派发时间确定，截止时间=派发时间+SLA） ------------------
router.post('/:id/dispatch', authRequired(), (req, res) => {
  const id = req.params.id;
  const { driverId } = req.body || {};
  const driver = MOCK_DRIVERS.find(d => d.id === Number(driverId));
  if (!driver) return res.status(400).json({ message: '司机不存在' });
  if (driver.audit_status !== 'approved') return res.status(400).json({ message: '该司机未通过审核，不能接单' });
  // 硬规则：只有"空闲"司机才能被派发，请假/休假/任务中/已停用一律拒绝，避免一人多单
  if (driver.status !== '空闲') return res.status(400).json({ message: `司机当前状态为「${driver.status}」，只有空闲司机才能被派发` });

  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (t.status !== '待派发') return res.status(400).json({ message: '只有待派发的任务才能派发' });
  if (t.published === false) return res.status(400).json({ message: '草稿任务无法派发，请先发布' });

  t.driver_id = driver.id;
  t.driver_name = driver.name;
  t.status = '待发车';   // 派发后的状态是"待发车"（用户要求：待派发→派发→待发车→确认发车→进行中）
  t.dispatch_time = nowFmt();  // R2: 派发时间从确定派发司机的瞬间开始
  t.departure_time = null;
  t.dispatcher_name = req.user.name;
  t.dispatcher_id = req.user.id;

  pushLog({ task_id: id, type: 'dispatch', user_id: req.user.id, user_name: req.user.name, detail: `派发给司机「${driver.name}(${driver.plate})」` });
  // 白名单：派发不推送通知

  recalcDriversStatus();
  res.json({ ok: true, dispatch_time: t.dispatch_time });
});

// ------------------ POST 发车（待发车 → 进行中） ------------------
router.post('/:id/depart', authRequired(), (req, res) => {
  const id = req.params.id;
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (!t.dispatch_time) return res.status(400).json({ message: '任务尚未派发，不能发车' });
  if (t.departure_time) return res.status(400).json({ message: '任务已经发车' });
  // 用户要求：派发后的状态是"待发车"，点击确认发车→变成"进行中"
  if (!['待发车', '进行中', '已超时', '已延误'].includes(t.status)) return res.status(400).json({ message: '该任务状态不允许发车' });

  t.status = '进行中';
  t.departure_time = nowFmt();
  // 自动判断：发车时是否已经超过 latest_departure_time
  if (t.latest_departure_time) {
    const latestMs = parseD(t.latest_departure_time);
    const departMs = parseD(t.departure_time);
    if (latestMs && departMs && departMs > latestMs) t.depart_overdue = true;
  }
  pushLog({ task_id: id, type: 'depart', user_id: req.user.id, user_name: req.user.name, detail: `已发车，出车时间：${t.departure_time}${t.depart_overdue ? '（已超过最迟发车时间，发车超时）' : ''}` });
  // 白名单：任务发车 → 通知调度员（非核心，铃铛列表留痕）
  notifyDispatchers({
    from: req.user.name,
    title: `任务 ${id} 已发车：司机「${t.driver_name}」执行（${t.origin} → ${t.destination}）`,
    type: 'success',
    link: '/tasks',
  });
  res.json({ ok: true, departure_time: t.departure_time });
});

// ------------------ POST 确认完成（R2：确认框点确定后，写 complete_time 才算完成；
// Q2/R3：同时收 trip_mileage 和 attachment；司机city同步） ------------------
router.post('/:id/complete', authRequired(), (req, res) => {
  const id = req.params.id;
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(400).json({ message: '任务不存在' });
  if (t.status === '已完成') return res.status(400).json({ message: '该任务已完成，请勿重复确认完成' });
  if (t.status === '已取消') return res.status(400).json({ message: '该任务已取消，不能确认完成' });
  if (t.complete_time) return res.status(400).json({ message: '该任务已完成，请勿重复确认完成' });
  // 业务规则：点击「发车」之后才允许确认完成（进行中/已超时/已延误/异常等发车后状态均可）
  if (!t.departure_time) return res.status(400).json({ message: '任务未发车，不能确认完成（请先确认发车）' });

  const body = req.body || {};
  const hadException = t.status === '异常';
  // 异常任务完成后进入历史，状态标签仍保留「异常」；普通任务为「已完成」
  t.status = hadException ? '异常' : '已完成';
  t.complete_time = nowFmt();
  t.trip_mileage = Number(body.trip_mileage) || null;
  // 运输照片最多 3 张：兼容旧版单张 attachment 字段
  const imgs = Array.isArray(body.attachments)
    ? body.attachments.filter(Boolean).slice(0, 3)
    : (body.attachment ? [body.attachment] : []);
  t.attachments = imgs;
  t.attachment = imgs[0] || null;
  // 自动判断：完成时是否已超过 deadline（dispatch_time + sla_hours）
  if (t.dispatch_time) {
    const ddlMs = parseD(t.dispatch_time) + Number(t.sla_hours || 8) * 3600 * 1000;
    const completeMs = parseD(t.complete_time);
    if (ddlMs && completeMs && completeMs > ddlMs) t.task_overdue = true;
  }
  pushLog({ task_id: id, type: 'complete', user_id: req.user.id, user_name: req.user.name,
    detail: `确认完成运输${t.trip_mileage ? ' · TRIP ' + t.trip_mileage + ' km' : ''}${imgs.length ? ' · 运输照片 ' + imgs.length + ' 张' : ''}${t.exception_reason ? ' · 任务曾上报异常' : ''}${t.task_overdue ? '（已超过任务截止时间，任务超时）' : ''}` });

  // R3: 司机的所在城市与任务的目的地同步
  const rawDest = String(t.destination || '').trim();
  if (rawDest && t.driver_id) {
    const d = MOCK_DRIVERS.find(x => x.id === Number(t.driver_id));
    if (d) {
      const cityName = rawDest.replace(/(仓|站|集散中心|分公司|港区|机场|火车站|南站|北站|东站|西站)$/g, '').trim();
      if (cityName && d.city !== cityName) {
        // R4/Q4: 任务完成同步城市不算作"司机变更日志"（系统自动操作），不再 pushDriverChangeLog
        d.city = cityName;
      }
    }
  }

  // 白名单：完成不推送通知
  recalcDriversStatus();
  res.json({ ok: true, complete_time: t.complete_time, trip_mileage: t.trip_mileage, attachment: t.attachment });
});

// ------------------ POST 上报异常（进行中 → 异常；调度员/管理员均可） ------------------
router.post('/:id/report-exception', authRequired(), (req, res) => {
  const id = req.params.id;
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (['已完成', '已取消'].includes(t.status) || t.complete_time) {
    return res.status(400).json({ message: '任务已结束，不能上报异常' });
  }
  if (t.status === '异常') return res.status(400).json({ message: '该任务已上报过异常，请勿重复提交' });
  if (!t.departure_time) return res.status(400).json({ message: '任务未发车，不能上报异常' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ message: '请选择或填写异常原因' });
  const images = Array.isArray(req.body.images) ? req.body.images.filter(Boolean).slice(0, 3) : [];
  t.status = '异常';
  t.exception_reason = reason;
  t.exception_images = images;
  t.exception_time = nowFmt();
  t.exception_by_id = req.user.id;
  t.exception_by_name = req.user.name;
  pushLog({ task_id: id, type: 'exception', user_id: req.user.id, user_name: req.user.name,
    detail: `上报任务异常：${reason}${images.length ? '（现场照片 ' + images.length + ' 张）' : ''}` });
  // 异常未完成前司机保持「任务中」，避免再被派发
  recalcDriversStatus();
  res.json({ ok: true, status: t.status, exception_time: t.exception_time });
});

// ------------------ POST 管理员手动切换三个可点击tag（历史任务里用） ------------------
function makeToggle(field, label) {
  return (req, res) => {
    const t = MOCK_TASKS.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ message: '任务不存在' });
    t[field] = !t[field];
    pushLog({ task_id: t.id, type: 'edit', user_id: req.user.id, user_name: req.user.name,
      detail: `管理员手动标记${label} → ${t[field] ? '亮起' : '取消'}` });
    res.json({ ok: true, [field]: t[field] });
  };
}
router.post('/:id/toggle-depart-overdue', authRequired(['admin']), makeToggle('depart_overdue', '发车是否超时'));
router.post('/:id/toggle-task-overdue',   authRequired(['admin']), makeToggle('task_overdue',  '任务是否超时'));
// 加急标记：显示状态 = is_urgent || urgent_manual，必须按"有效状态"整体切换，
// 否则 is_urgent=true 的任务永远无法从「加急」切回「普通」
router.post('/:id/toggle-urgent', authRequired(['admin']), (req, res) => {
  const t = MOCK_TASKS.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  const effective = Boolean(t.is_urgent || t.urgent_manual);
  if (effective) {
    t.is_urgent = false;
    t.urgent_manual = false;
  } else {
    t.is_urgent = true;
  }
  pushLog({ task_id: t.id, type: 'edit', user_id: req.user.id, user_name: req.user.name,
    detail: `管理员手动切换加急标记 → ${effective ? '普通' : '加急'}` });
  // 白名单：手动切为加急 → 调度员核心预警；切回普通不推送
  if (!effective && t.published !== false) {
    notifyDispatchers({
      from: req.user.name,
      title: `任务 ${t.id} 被管理员标记为加急：${t.origin} → ${t.destination}，请优先派发`,
      type: 'warning', core: true, link: '/tasks',
    });
  }
  res.json({ ok: true, is_urgent: t.is_urgent, urgent_manual: t.urgent_manual });
});
// 保留旧接口兼容（改名为切换任务超时）
router.post('/:id/toggle-overdue', authRequired(['admin']), makeToggle('task_overdue', '任务是否超时'));

// ------------------ POST 取消任务 ------------------
router.post('/:id/cancel', authRequired(), (req, res) => {
  const id = req.params.id;
  const { reason = '' } = req.body || {};
  if (!reason) return res.status(400).json({ message: '请填写取消原因' });
  const t = MOCK_TASKS.find(x => x.id === id);
  if (!t) return res.status(404).json({ message: '任务不存在' });
  if (t.status === '已完成' || t.complete_time) return res.status(400).json({ message: '已完成任务不可取消' });
  t.status = '已取消';
  t.cancel_reason = reason;
  pushLog({ task_id: id, type: 'cancel', user_id: req.user.id, user_name: req.user.name, detail: `取消任务，原因：${reason}` });
  // 白名单：调度员接收「任务被取消」
  notifyDispatchers({ from: req.user.name, title: `任务 ${id} 已被取消：${reason}`, type: 'warning', link: '/tasks' });
  // 白名单：管理员同样接收「运单被取消」
  notifyAdmins({ from: req.user.name, title: `运单 ${id} 已被取消：${reason}（${t.origin} → ${t.destination}）`, type: 'warning', link: '/history' });
  recalcDriversStatus();
  res.json({ ok: true });
});

module.exports = router;
