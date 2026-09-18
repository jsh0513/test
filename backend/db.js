// 内存 Mock 数据中心(v5 - CJS)
// 包含：用户(账号)、司机、司机变更日志、任务、操作日志、通知、违章记录、出勤记录、Token 池

let pool = null;
let mysqlAvailable = false;

// ---------- 用户 ----------
// 账号身份显示统一为「名字 ID:x」；前三个 id 固定为管理员
const MOCK_USERS = [
  { id: 1, username: 'admin',  password: '123456', name: '超级管理员', role: 'admin',      avatar: '管', phone: '13800000001', gender: '男', created_at: '2024-01-01' },
  { id: 2, username: 'admin2', password: '123456', name: '管理员 小张', role: 'admin',     avatar: '张', phone: '13800000002', gender: '男', created_at: '2024-02-15' },
  { id: 3, username: 'admin3', password: '123456', name: '管理员 小刘', role: 'admin',     avatar: '刘', phone: '13800000003', gender: '女', created_at: '2024-02-15' },
  { id: 4, username: 'disp1',  password: '123456', name: '调度员 小李', role: 'dispatcher', avatar: '李', phone: '13800000004', gender: '男', created_at: '2024-03-11' },
  { id: 5, username: 'disp2',  password: '123456', name: '调度员 小王', role: 'dispatcher', avatar: '王', phone: '13800000005', gender: '男', created_at: '2024-05-06' },
];
let userSeq = MOCK_USERS.length + 1;

// ---------- 账号操作日志（人员变动-账号管理：创建/信息修改/密码修改/删除） ----------
const ACCOUNT_LOG_ACTIONS = ['create', 'edit_info', 'change_password', 'delete', 'role_change'];
const ACCOUNT_ACTION_LABEL = {
  create: '创建账号', edit_info: '信息修改', change_password: '密码修改', delete: '删除账号',
  role_change: '角色调整',
};
const MOCK_ACCOUNT_LOGS = [
  {
    id: 1, action: 'create', action_label: ACCOUNT_ACTION_LABEL.create, operator_id: 1, operator_name: '超级管理员',
    target_id: 4, target_username: 'disp1', target_name: '调度员 小李',
    detail: '创建账号（角色：调度员）', time: fmtLocal(Date.now() - 60 * 24 * 20 * 60 * 1000),
  },
];
let accountLogSeq = MOCK_ACCOUNT_LOGS.length + 1;
function pushAccountLog({ action, operator_id, operator_name, target_id, target_username, target_name, detail, time }) {
  if (!ACCOUNT_LOG_ACTIONS.includes(action)) return;
  MOCK_ACCOUNT_LOGS.unshift({
    id: accountLogSeq++,
    action, action_label: ACCOUNT_ACTION_LABEL[action],
    operator_id, operator_name,
    target_id: target_id ?? null, target_username: target_username || '', target_name: target_name || '',
    detail: detail || '',
    time: time || nowFmt(),
  });
}

// token -> userId
const TOKEN_POOL = new Map();

// ---------- Token 生成与移除 ----------
function generateToken(userId) {
  const rnd = (bytes = 12) => {
    let s = '';
    for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    return s;
  };
  const token = 'tk_' + Date.now().toString(36) + '_' + rnd(8);
  TOKEN_POOL.set(token, Number(userId));
  return token;
}
function removeToken(token) {
  if (token) TOKEN_POOL.delete(token);
}

// ---------- 工具函数 ----------
// ⚠️ R2修复：所有Mock时间格式化 严格使用本地时区（中国UTC+8场景）。彻底禁止toISOString()，因为它输出UTC会偏差8小时
const nowStamp = new Date().getTime();
function pad2(n) { return String(n).padStart(2, '0'); }
// 将 Date 对象或毫秒数格式化为 "YYYY-MM-DD HH:mm"（本地时区）
function fmtLocal(v) {
  const d = (v instanceof Date) ? v : new Date(Number(v || 0));
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function timeAgo(minutes) {
  return fmtLocal(new Date(nowStamp - minutes * 60 * 1000));
}
function future(minutes) {
  return fmtLocal(new Date(nowStamp + minutes * 60 * 1000));
}
function nowFmt() { return fmtLocal(new Date()); }
function fmtDate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
}
function parseDate(s) { return new Date(String(s).replace(' ','T') + ':00'); }
function parseD(s) {
  if (!s) return 0;
  try { return new Date(String(s).replace(' ','T') + ':00').getTime(); }
  catch(_){ return 0; }
}

// 根据身份证估算年龄
function calcAgeByIdCard(id) {
  if (!id || id.length < 10) return 30;
  const y = parseInt(id.slice(6,10), 10);
  const m = parseInt(id.slice(10,12), 10);
  if (!y || !m) return 30;
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m) a--;
  return a > 18 && a < 70 ? a : 30;
}

// 根据身份证第 17 位推导性别：奇数男、偶数女
function calcGenderByIdCard(id) {
  if (!id || id.length < 17) return '男';
  const digit = parseInt(id.charAt(16), 10);
  if (Number.isNaN(digit)) return '男';
  return digit % 2 === 1 ? '男' : '女';
}

// ---------- 司机 ----------
function addDriverMeta(d) {
  if (d.age === undefined) d.age = calcAgeByIdCard(d.id_card);
  if (!d.gender) d.gender = calcGenderByIdCard(d.id_card);
  if (!d.last_maintenance) {
    const monthsAgo = 12 + ((d.id * 3) % 9);
    const base = new Date(nowStamp);
    base.setMonth(base.getMonth() - monthsAgo);
    d.last_maintenance = fmtDate(base);
  }
  return d;
}

// R3: 状态重命名：在职→空闲, 休息→请假
const MOCK_DRIVERS = [
  { id: 1,  name: '张伟',  phone: '13800138000', plate: '京A-12345', city: '北京', status: '空闲',   audit_status: 'approved', join_date: '2024-03-12', vehicle_type: '厢式货车', rating: 4.8, id_card: '110101199003121234' },
  { id: 2,  name: '李强',  phone: '13900139001', plate: '沪B-67890', city: '上海', status: '请假',   audit_status: 'approved', join_date: '2024-05-20', vehicle_type: '平板车',   rating: 4.6, id_card: '310101199105202345' },
  { id: 3,  name: '王芳',  phone: '13700137002', plate: '粤A-11111', city: '广州', status: '待审核', audit_status: 'pending',  join_date: '2025-01-08', vehicle_type: '冷链车',   rating: 4.5, id_card: '440101199201083456', creator_id: 4, creator_name: '调度员 小李' },
  { id: 4,  name: '陈明',  phone: '13600136003', plate: '粤B-22222', city: '深圳', status: '任务中', audit_status: 'approved', join_date: '2023-11-30', vehicle_type: '厢式货车', rating: 4.9, id_card: '440301199011304567' },
  { id: 5,  name: '赵磊',  phone: '13500135004', plate: '京C-33333', city: '北京', status: '已停用', audit_status: 'rejected', join_date: '2022-09-15', vehicle_type: '平板车',   rating: 4.2, id_card: '110101198809155678' },
  { id: 6,  name: '刘洋',  phone: '13300133005', plate: '沪D-44444', city: '上海', status: '空闲',   audit_status: 'approved', join_date: '2024-07-22', vehicle_type: '厢式货车', rating: 4.7, id_card: '310101199107226789' },
  { id: 7,  name: '孙勇',  phone: '13200132006', plate: '川A-55555', city: '成都', status: '空闲',   audit_status: 'approved', join_date: '2023-04-11', vehicle_type: '厢式货车', rating: 4.8, id_card: '510101199004117890' },
  { id: 8,  name: '周杰',  phone: '13100131007', plate: '湘A-66666', city: '长沙', status: '任务中', audit_status: 'approved', join_date: '2024-10-05', vehicle_type: '冷链车',   rating: 4.6, id_card: '430101199110058901' },
  { id: 9,  name: '吴敏',  phone: '13000130008', plate: '津A-77777', city: '天津', status: '休假',   audit_status: 'approved', join_date: '2025-02-14', vehicle_type: '平板车',   rating: 4.5, id_card: '120101199202149012' },
  { id: 10, name: '郑海',  phone: '15800158009', plate: '浙A-88888', city: '杭州', status: '任务中', audit_status: 'approved', join_date: '2023-08-19', vehicle_type: '厢式货车', rating: 4.9, id_card: '330101199108190123' },
  { id: 11, name: '黄磊',  phone: '15900159010', plate: '鲁A-99999', city: '济南', status: '待审核', audit_status: 'pending',  join_date: '2025-06-01', vehicle_type: '厢式货车', rating: 4.4, id_card: '370101199206011234', creator_id: 5, creator_name: '调度员 小王' },
  { id: 12, name: '罗文',  phone: '16000160011', plate: '渝A-10101', city: '重庆', status: '空闲',   audit_status: 'approved', join_date: '2024-01-22', vehicle_type: '冷链车',   rating: 4.7, id_card: '500101199001222345' },
].map(addDriverMeta);
let driverSeq = MOCK_DRIVERS.length + 1;

// R6: 司机变更日志(编辑/停用/启用/删除，前后信息+操作人+时间)
const MOCK_DRIVER_CHANGE_LOGS = [
  // 示例日志
  {
    id: 1, driver_id: 1, driver_name: '张伟', driver_id_card: '110101199003121234',
    action: 'edit', action_label: '编辑信息',
    before: { city: '北京', phone: '13800138000' },
    after: { city: '北京', phone: '13800138000' },
    user_id: 1, user_name: '超级管理员',
    time: timeAgo(6 * 24 * 60),
  },
  {
    id: 2, driver_id: 5, driver_name: '赵磊', driver_id_card: '110101198809155678',
    action: 'disable', action_label: '状态变更(停用)',
    before: { status: '空闲' }, after: { status: '已停用' },
    user_id: 1, user_name: '超级管理员',
    time: timeAgo(30 * 24 * 60),
  },
];
let driverChangeLogSeq = MOCK_DRIVER_CHANGE_LOGS.length + 1;

// R4/Q4: 只保留真正变动的字段（before/after 都只列有差异的 key）
function diffObj(before, after) {
  const b = before || {}, a = after || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const outB = {}, outA = {};
  for (const k of keys) {
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      outB[k] = b[k]; outA[k] = a[k];
    }
  }
  return { before: outB, after: outA, changedKeys: Object.keys(outB) };
}

// R4/Q4: 允许的 action 类型（前端只显示这些）
const ALLOWED_LOG_ACTIONS = ['edit', 'audit_pass', 'disable', 'enable', 'delete', 'maintenance', 'status_change'];

// 把内部 action 映射成前端中文标签
const ACTION_LABEL = {
  edit: '编辑信息', audit_pass: '审核通过', audit_reject: '审核驳回',
  disable: '状态变更(停用)', enable: '状态变更(启用)', delete: '删除司机',
  auto_city: '同步城市', maintenance: '保修信息', status_change: '状态变更',
};

function pushDriverChangeLog({ driver, action, before, after, user_id, user_name }) {
  const d = driver || {};
  // 只保留差异字段
  const { before: dB, after: dA, changedKeys } = diffObj(before, after);
  // before/after 都为空就不写
  if (changedKeys.length === 0 && action !== 'delete' && action !== 'maintenance') return;
  MOCK_DRIVER_CHANGE_LOGS.unshift({
    id: driverChangeLogSeq++,
    driver_id: d.id ?? null, driver_name: d.name ?? '', driver_id_card: d.id_card ?? '',
    action, action_label: ACTION_LABEL[action] || action,
    before: dB, after: dA, changed_keys: changedKeys,
    user_id, user_name, time: nowFmt(),
    allowed: ALLOWED_LOG_ACTIONS.includes(action), // 前端据此过滤
  });
}

// ---------- 任务 ----------
function recommendVehicleByCargo(cargo) {
  const map = {
    '生鲜': '冷链车', '冷链物资': '冷链车', '食品': '冷链车', '药品': '冷链车',
    '家具': '平板车', '建材': '平板车',
    '电子产品': '厢式货车', '服装': '厢式货车', '普通货物': '厢式货车', '其他': '厢式货车',
  };
  return map[cargo] || '厢式货车';
}

// R2/Q3: 截止时间严格 = 派发时间 + 完成期限。未派发则没有截止时间（返回 0/null）。
function getTaskDeadlineMs(t) {
  if (!t || !t.dispatch_time) return 0;  // 派发前不估算
  const baseMs = parseD(t.dispatch_time);
  if (!baseMs) return 0;
  return baseMs + Number(t.sla_hours || 8) * 60 * 60 * 1000;
}

// 任务的 timely 标志：只在已发车后才开始倒计时。R2 规定：确认完成的点按钮确认框点确定后才算完成时间。
function getTaskTimelyFlag(t) {
  const base = parseD(t.departure_time) || 0;  // 发车后才开始算剩余
  const deadline = getTaskDeadlineMs(t);
  if (!deadline) return { flag: 'none', countdown: null, overtime: false, deadline: 0 };
  const now = Date.now();
  const remain = Math.floor((deadline - now) / 1000);
  if (!base && t.departure_time) {
    // 已发车
  }
  // 未发车时不显示剩余，也不判超时
  if (!t.departure_time) return { flag: 'waiting', countdown: null, overtime: false, deadline };
  if (remain < 0) return { flag: 'overdue', countdown: remain, overtime: true, deadline };
  if (remain < 60 * 60) return { flag: 'soon', countdown: remain, overtime: false, deadline };
  return { flag: 'ok', countdown: remain, overtime: false, deadline };
}

const MOCK_TASKS = [
  // 001 已完成（派发 + 已发车 + 完成）
  { id: 'T-20250828-001', driver_id: 1, driver_name: '张伟', origin: '上海仓', destination: '杭州站', status: '已完成',
    create_time: timeAgo(9*60), dispatch_time: timeAgo(9*60-10), start_time: null, departure_time: timeAgo(9*60-20), complete_time: timeAgo(1*60),
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小李', dispatcher_id: 2,
    cargo: '电子产品', weight: 2.5, sla_hours: 8, recommended_vehicle_type: '厢式货车',
    remarks: '电子产品需轻拿轻放，防潮', is_urgent: false,
    latest_departure_time: timeAgo(8*60-40), freight: 860,
    published: true, scheduled_at: null,
    trip_mileage: 186, attachment: '/uploads/T-001.jpg', overdue_manual: false,
  },
  // 002 进行中 + 已发车（有departure_time，倒计时开始）
  { id: 'T-20250828-002', driver_id: 4, driver_name: '陈明', origin: '北京仓', destination: '天津站', status: '进行中',
    create_time: timeAgo(5*60+30), dispatch_time: timeAgo(5*60+15), start_time: null, departure_time: timeAgo(5*60), complete_time: null,
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小王', dispatcher_id: 3,
    cargo: '服装', weight: 1.8, sla_hours: 8, recommended_vehicle_type: '厢式货车',
    remarks: '客户要求下午送达', is_urgent: false,
    latest_departure_time: timeAgo(4*60), freight: 480,
    published: true, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 003 待派发（已发布）
  { id: 'T-20250828-003', driver_id: null, driver_name: '未分配', origin: '广州仓', destination: '深圳站', status: '待派发',
    create_time: timeAgo(8*60), dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '', dispatcher_id: null,
    cargo: '生鲜', weight: 3.2, sla_hours: 6, recommended_vehicle_type: '冷链车',
    remarks: '需要冷链车全程-18℃', is_urgent: true,
    latest_departure_time: future(30), freight: 720,
    published: true, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 004 已完成
  { id: 'T-20250828-004', driver_id: 7, driver_name: '孙勇', origin: '成都仓', destination: '重庆站', status: '已完成',
    create_time: timeAgo(7*60+10), dispatch_time: timeAgo(7*60), start_time: null, departure_time: timeAgo(6*60+50), complete_time: timeAgo(3*60+30),
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小王', dispatcher_id: 3,
    cargo: '家具', weight: 5.0, sla_hours: 8, recommended_vehicle_type: '平板车',
    remarks: '大件家具需两人搬运', is_urgent: false,
    latest_departure_time: timeAgo(6*60), freight: 1100,
    published: true, scheduled_at: null,
    trip_mileage: 342, attachment: '/uploads/T-004.jpg', overdue_manual: false,
  },
  // 005 进行中+已发车，已超时（SLA=10h）
  { id: 'T-20250828-005', driver_id: 8, driver_name: '周杰', origin: '武汉仓', destination: '长沙站', status: '进行中',
    create_time: timeAgo(36*60), dispatch_time: timeAgo(11*60+50), start_time: null, departure_time: timeAgo(11*60+40), complete_time: null,
    cancel_reason: '', delayed: true, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小李', dispatcher_id: 2,
    cargo: '药品', weight: 0.8, sla_hours: 10, recommended_vehicle_type: '冷链车',
    remarks: '冷链药品，需2-8℃保存', is_urgent: true,
    latest_departure_time: timeAgo(11*60+30), freight: 640,
    published: true, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 006 进行中+已发车（不超时，SLA=8h）
  { id: 'T-20250828-006', driver_id: 10, driver_name: '郑海', origin: '杭州仓', destination: '上海站', status: '进行中',
    create_time: timeAgo(5*60), dispatch_time: timeAgo(4*60+50), start_time: null, departure_time: timeAgo(4*60+40), complete_time: null,
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小李', dispatcher_id: 2,
    cargo: '电子产品', weight: 2.0, sla_hours: 8, recommended_vehicle_type: '厢式货车',
    remarks: '易碎，有保险', is_urgent: false,
    latest_departure_time: timeAgo(4*60), freight: 580,
    published: true, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 007 待派发（已发布）
  { id: 'T-20250828-007', driver_id: null, driver_name: '未分配', origin: '深圳仓', destination: '广州站', status: '待派发',
    create_time: timeAgo(4*60+10), dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '', dispatcher_id: null,
    cargo: '服装', weight: 1.5, sla_hours: 6, recommended_vehicle_type: '厢式货车',
    remarks: '', is_urgent: false,
    latest_departure_time: future(120), freight: 540,
    published: true, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 008 已完成，目的地成都 → 司机罗文(重庆) 的城市同步为重庆站 → 重庆
  { id: 'T-20250828-008', driver_id: 12, driver_name: '罗文', origin: '重庆仓', destination: '成都站', status: '已完成',
    create_time: timeAgo(3*60+30), dispatch_time: timeAgo(3*60+20), start_time: null, departure_time: timeAgo(3*60+10), complete_time: timeAgo(30),
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小王', dispatcher_id: 3,
    cargo: '食品', weight: 2.8, sla_hours: 8, recommended_vehicle_type: '冷链车',
    remarks: '', is_urgent: false,
    latest_departure_time: timeAgo(3*60), freight: 470,
    published: true, scheduled_at: null,
    trip_mileage: 268, attachment: '/uploads/T-008.jpg', overdue_manual: false,
  },
  // 009 已完成
  { id: 'T-20250828-009', driver_id: 1, driver_name: '张伟', origin: '北京仓', destination: '济南站', status: '已完成',
    create_time: timeAgo(2*60+40), dispatch_time: timeAgo(2*60+30), start_time: null, departure_time: timeAgo(2*60+20), complete_time: timeAgo(10),
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '调度员 小李', dispatcher_id: 2,
    cargo: '电子产品', weight: 1.2, sla_hours: 10, recommended_vehicle_type: '厢式货车',
    remarks: '', is_urgent: false,
    latest_departure_time: timeAgo(2*60+10), freight: 890,
    published: true, scheduled_at: null,
    trip_mileage: 324, attachment: null, overdue_manual: false,
  },
  // 010 已取消
  { id: 'T-20250828-010', driver_id: null, driver_name: '未分配', origin: '天津仓', destination: '北京站', status: '已取消',
    create_time: timeAgo(80), dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
    cancel_reason: '客户撤单', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '', dispatcher_id: null,
    cargo: '家具', weight: 4.5, sla_hours: 8, recommended_vehicle_type: '平板车',
    remarks: '', is_urgent: false,
    latest_departure_time: future(60), freight: 780,
    published: true, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 011 草稿(published=false) 堆积在任务发布模块下方
  { id: 'T-20250828-011', driver_id: null, driver_name: '未分配', origin: '北京仓', destination: '上海仓', status: '待派发',
    create_time: timeAgo(40), dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '', dispatcher_id: null,
    cargo: '建材', weight: 4.0, sla_hours: 24, recommended_vehicle_type: '平板车',
    remarks: '建材，注意防潮', is_urgent: false,
    latest_departure_time: future(8*60), freight: 2400,
    published: false, scheduled_at: null,
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
  // 012 草稿(published=false) — 加急，右上角没有加急标签，加急样式在右下角边块标记
  { id: 'T-20250828-012', driver_id: null, driver_name: '未分配', origin: '上海仓', destination: '杭州站', status: '待派发',
    create_time: timeAgo(15), dispatch_time: null, start_time: null, departure_time: null, complete_time: null,
    cancel_reason: '', delayed: false, creator: '超级管理员', creator_id: 1, dispatcher_name: '', dispatcher_id: null,
    cargo: '生鲜', weight: 2.0, sla_hours: 8, recommended_vehicle_type: '冷链车',
    remarks: '加急，需优先派发', is_urgent: true,
    latest_departure_time: future(2*60), freight: 600,
    published: false, scheduled_at: future(60),
    trip_mileage: null, attachment: null, overdue_manual: false,
  },
];

// ========== MOCK_TASKS 启动后一次性补齐 ==========
(function initMockTasksFixup() {
  // 1. publish_time 补齐：凡是 published=true 的任务，publish_time ≈ create_time
  for (const t of MOCK_TASKS) {
    if (t.published === true && !t.publish_time) {
      t.publish_time = t.create_time || null;
    }
    if (t.published === false && !('publish_time' in t)) {
      t.publish_time = null;
    }
  }
  // 2. /uploads/*.jpg 路径改为内联 SVG 彩色占位图（保证 el-image 能显示）
  function svgAttach(id, color, label) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='260'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0%25' stop-color='${color}'/><stop offset='100%25' stop-color='#2c3e50'/>
      </linearGradient></defs>
      <rect width='400' height='260' fill='url(%23g)'/>
      <rect x='20' y='20' width='360' height='220' rx='10' fill='none' stroke='%23ffffff33' stroke-dasharray='8 6'/>
      <text x='200' y='110' text-anchor='middle' fill='white' font-size='34' font-family='Arial' font-weight='bold'>📦 ${id}</text>
      <text x='200' y='160' text-anchor='middle' fill='white' font-size='20' font-family='Arial'>${label}</text>
      <text x='200' y='210' text-anchor='middle' fill='%23ffffffaa' font-size='14' font-family='Arial'>货运司机任务系统 · 运输凭证</text>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + svg.replace(/\s+/g, ' ').replace(/#/g, '%23');
  }
  for (const t of MOCK_TASKS) {
    if (typeof t.attachment === 'string' && t.attachment.startsWith('/uploads/')) {
      const n = t.id.split('-').pop();
      const palette = [
        ['#e74c3c', '生鲜冷链 · 运输签收'],
        ['#3498db', '长途货运 · 电子签收'],
        ['#27ae60', '城际快运 · 到达确认'],
        ['#f39c12', '大件家具 · 卸货签收'],
        ['#9b59b6', '普通物资 · 客户签收'],
      ];
      const pick = palette[n % palette.length];
      t.attachment = svgAttach('T-' + n, pick[0], pick[1]);
    }
  }
  // 3. 给历史任务 T-001 / T-004 / T-008 (已完成，有 mileage) 手动加 SVG 凭证（之前已设成null的）
  const withTrip = MOCK_TASKS.filter(t => t.status === '已完成' && t.trip_mileage && !t.attachment);
  const palette2 = ['#e74c3c', '#27ae60', '#f39c12', '#9b59b6'];
  withTrip.forEach((t, i) => {
    const n = t.id.split('-').pop();
    const col = palette2[i % palette2.length];
    t.attachment = svgAttach('T-' + n, col, 'TRIP ' + t.trip_mileage + ' km 签收');
  });

  // 4. 补全新字段：depart_overdue（发车是否超时）、task_overdue（任务deadline是否超时）、urgent_manual（管理员手动加急标记）
  for (const t of MOCK_TASKS) {
    if (!('depart_overdue' in t)) t.depart_overdue = false;
    if (!('task_overdue' in t))  t.task_overdue  = false;
    if (!('urgent_manual' in t)) t.urgent_manual = false;
    // 已发车或已完成的任务：自动判断发车时是否已经超过了 latest_departure_time
    if (t.departure_time && t.latest_departure_time) {
      const departMs = parseD(t.departure_time);
      const latestMs = parseD(t.latest_departure_time);
      if (departMs && latestMs && departMs > latestMs) t.depart_overdue = true;
    }
    // 已完成的任务：自动判断完成时是否已经超过了 deadline（dispatch_time+sla_hours）
    if (t.complete_time && t.dispatch_time) {
      const ddlMs = parseD(t.dispatch_time) + Number(t.sla_hours || 8) * 3600 * 1000;
      const completeMs = parseD(t.complete_time);
      if (completeMs && ddlMs && completeMs > ddlMs) t.task_overdue = true;
    }
  }
})();

// ---------- 操作日志 ----------
const MOCK_TASK_LOGS = [
  // 历史任务 001
  { id: 101, task_id: 'T-20250828-001', time: timeAgo(9*60),    type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(上海仓 → 杭州站)' },
  { id: 102, task_id: 'T-20250828-001', time: timeAgo(9*60-10), type: 'dispatch', user_id: 2, user_name: '调度员 小李', detail: '派发给司机「张伟(京A-12345)」' },
  { id: 103, task_id: 'T-20250828-001', time: timeAgo(9*60-20), type: 'depart',   user_id: 2, user_name: '调度员 小李', detail: '已发车，出车时间：'+timeAgo(9*60-20) },
  { id: 104, task_id: 'T-20250828-001', time: timeAgo(1*60),    type: 'complete', user_id: 1, user_name: '超级管理员',   detail: '确认完成运输' },
  // 002
  { id: 201, task_id: 'T-20250828-002', time: timeAgo(5*60+30), type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(北京仓 → 天津站)' },
  { id: 202, task_id: 'T-20250828-002', time: timeAgo(5*60+15), type: 'dispatch', user_id: 3, user_name: '调度员 小王', detail: '派发给司机「陈明(粤B-22222)」' },
  { id: 203, task_id: 'T-20250828-002', time: timeAgo(5*60),    type: 'depart',   user_id: 3, user_name: '调度员 小王', detail: '已发车' },
  // 005
  { id: 501, task_id: 'T-20250828-005', time: timeAgo(36*60),      type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(武汉仓 → 长沙站)' },
  { id: 502, task_id: 'T-20250828-005', time: timeAgo(11*60+50),   type: 'dispatch', user_id: 2, user_name: '调度员 小李', detail: '派发给司机「周杰(湘A-66666)」' },
  { id: 503, task_id: 'T-20250828-005', time: timeAgo(11*60+40),   type: 'depart',   user_id: 2, user_name: '调度员 小李', detail: '已发车，出车时间：'+timeAgo(11*60+40) },
  // 004 (历史任务-已完成) —— R4: 补齐 depart(发车) 操作日志，追溯谁确认的发车
  { id: 401, task_id: 'T-20250828-004', time: timeAgo(7*60+10),    type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(成都仓 → 重庆站)' },
  { id: 402, task_id: 'T-20250828-004', time: timeAgo(7*60),       type: 'dispatch', user_id: 3, user_name: '调度员 小王', detail: '派发给司机「孙勇(川A-55555)」' },
  { id: 403, task_id: 'T-20250828-004', time: timeAgo(6*60+50),    type: 'depart',   user_id: 3, user_name: '调度员 小王', detail: '已发车，出车时间：'+timeAgo(6*60+50) },
  { id: 404, task_id: 'T-20250828-004', time: timeAgo(3*60+30),    type: 'complete', user_id: 1, user_name: '超级管理员',   detail: '确认完成运输' },
  // 006 (进行中) —— 补齐 create/dispatch/depart 日志
  { id: 601, task_id: 'T-20250828-006', time: timeAgo(5*60),        type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(杭州仓 → 上海站)' },
  { id: 602, task_id: 'T-20250828-006', time: timeAgo(4*60+50),     type: 'dispatch', user_id: 2, user_name: '调度员 小李', detail: '派发给司机「郑海(浙A-88888)」' },
  { id: 603, task_id: 'T-20250828-006', time: timeAgo(4*60+40),     type: 'depart',   user_id: 2, user_name: '调度员 小李', detail: '已发车，出车时间：'+timeAgo(4*60+40) },
  // 008 (历史任务) —— R4: 补齐 depart + 所有操作日志
  { id: 801, task_id: 'T-20250828-008', time: timeAgo(3*60+30),    type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(重庆仓 → 成都站)' },
  { id: 802, task_id: 'T-20250828-008', time: timeAgo(3*60+20),    type: 'dispatch', user_id: 3, user_name: '调度员 小王', detail: '派发给司机「罗文(渝A-10101)」' },
  { id: 803, task_id: 'T-20250828-008', time: timeAgo(3*60+10),    type: 'depart',   user_id: 3, user_name: '调度员 小王', detail: '已发车，出车时间：'+timeAgo(3*60+10) },
  { id: 804, task_id: 'T-20250828-008', time: timeAgo(30),         type: 'complete', user_id: 1, user_name: '超级管理员',   detail: '确认完成运输' },
  // 009 (历史任务) —— 补齐 depart + 日志
  { id: 901, task_id: 'T-20250828-009', time: timeAgo(2*60+40),    type: 'create',   user_id: 1, user_name: '超级管理员',   detail: '创建任务(北京仓 → 济南站)' },
  { id: 902, task_id: 'T-20250828-009', time: timeAgo(2*60+30),    type: 'dispatch', user_id: 2, user_name: '调度员 小李', detail: '派发给司机「张伟(京A-12345)」' },
  { id: 903, task_id: 'T-20250828-009', time: timeAgo(2*60+20),    type: 'depart',   user_id: 2, user_name: '调度员 小李', detail: '已发车，出车时间：'+timeAgo(2*60+20) },
  { id: 904, task_id: 'T-20250828-009', time: timeAgo(10),         type: 'complete', user_id: 1, user_name: '超级管理员',   detail: '确认完成运输' },
];
let logSeq = 10000;
function pushLog({ task_id, type, user_id, user_name, detail }) {
  MOCK_TASK_LOGS.push({
    id: logSeq++, task_id, type, user_id, user_name, detail,
    time: nowFmt(),
  });
}

// ---------- 通知 ----------
// R9: 消息白名单 —— 管理员：司机审核结果、司机禁用/启用；调度员：超时/加急预警(core)、任务取消、任务信息更新
const MOCK_NOTIFS = [
];
let notifSeq = 1000;
function pushNotif({ to_role='all', to_user_id=null, from='系统', title, type='info', time, core=false, link='' }) {
  MOCK_NOTIFS.unshift({
    id: notifSeq++, from, to_role, to_user_id, title, type,
    core: Boolean(core),   // 核心消息：前端右上角弹窗提醒 + 跳转按钮
    link: link || '',      // 点击跳转的前端路由
    read: false,
    time: time || nowFmt(),
    created_at: time || nowFmt(),
  });
}

// ===== 消息白名单（用户规定）=====
// 管理员：① 司机审核通过/驳回结果 ② 司机账号禁用/启用
// 调度员：① 任务超时预警/加急任务异常（core 核心） ② 任务被取消 ③ 任务信息已更新
function notifyAdmins({ from = '系统', title, type = 'info', core = false, link = '' }) {
  pushNotif({ to_role: 'admin', from, title, type, core, link });
}
function notifyDispatchers({ from = '系统', title, type = 'info', core = false, link = '' }) {
  pushNotif({ to_role: 'dispatcher', from, title, type, core, link });
}
function broadcastToAdminsAndDispatchers({ from, title, type = 'info' }) {
  pushNotif({ to_role: 'all', from, title, type });
}

// ---------- 违章记录 ----------
const MOCK_VIOLATIONS = [
  { id: 1, driver_id: 1, time: timeAgo(60*24*5), type: '超速', fine: 200, points: 3 },
  { id: 2, driver_id: 4, time: timeAgo(60*24*30), type: '违停', fine: 100, points: 0 },
  { id: 3, driver_id: 8, time: timeAgo(60*24*10), type: '闯红灯', fine: 200, points: 6 },
  { id: 4, driver_id: 1, time: timeAgo(60*24*60), type: '超载', fine: 500, points: 3 },
];

// ---------- 出勤生成 ----------
function buildAttendance(driverId, year, month) {
  const driver = MOCK_DRIVERS.find(d => d.id === driverId) || { join_date: '2024-01-01' };
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const lastDay = new Date(year, month, 0).getDate();
  const arr = [];
  const joinY = Number((driver.join_date || '2024-01-01').slice(0,4));
  const joinM = Number((driver.join_date || '2024-01-01').slice(5,7));
  const today = new Date();
  const current = today.getFullYear() * 12 + today.getMonth() + 1;
  for (let i = 1; i <= lastDay; i++) {
    const date = `${ym}-${String(i).padStart(2,'0')}`;
    const ymIdx = year * 12 + month;
    const joinIdx = joinY * 12 + joinM;
    // 入职前的月份：不显示出勤(跳过)；入职当月之前不生成。
    if (ymIdx < joinIdx) { arr.push({ date, status: '未入职' }); continue; }
    // 未来日期：不显示出勤(空)
    if (ymIdx > current || (ymIdx === current && i > today.getDate())) {
      arr.push({ date, status: '—' }); continue;
    }
    // 用 driverId+date 生成伪随机（稳定）
    const seed = (driverId * 31 + i * 17 + year * 13 + month * 7) % 100;
    let s = '出勤';
    if (seed < 4) s = '请假';
    else if (seed < 7) s = '缺勤';
    else if (seed < 11) s = '休假';
    // 司机任务中：当天出勤
    arr.push({ date, status: s });
  }
  return arr;
}

// ---------- 保修 ----------
function maintenanceInfo(d) {
  const last = new Date(String(d.last_maintenance || '2024-01-01').replace(' ','T'));
  const next = new Date(last.getTime() + 2 * 365 * 24 * 3600 * 1000);
  const diff = next.getTime() - Date.now();
  const days = Math.ceil(diff / (24*3600*1000));
  return {
    last_maintenance: fmtDate(last),
    next_maintenance: fmtDate(next),
    days_left: days,
    overdue: days < 0,
    urgent: days < 30,
  };
}

// ---------- 鉴权 ----------
function authRequired(roles = []) {
  return (req, res, next) => {
    const token = req.headers['x-token'] || req.query.token;
    const userId = TOKEN_POOL.get(token);
    if (!userId) return res.status(401).json({ message: '未登录或登录已过期' });
    const u = MOCK_USERS.find(x => x.id === userId);
    if (!u) return res.status(401).json({ message: '账号不存在' });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ message: '无权限：仅 ' + roles.join('/') + ' 可访问' });
    req.user = u;
    next();
  };
}

// ---------- DB 连接（MySQL 不可用时自动回退内存 Mock） ----------

// R3: Mock启动时，遍历所有「已完成」任务，提取最近一条完成记录，将对应司机的city同步为任务destination
// （去掉 仓/站/集散中心/分公司 等后缀，只留纯城市名）
(function syncMockDriverCities() {
  // 对每个司机，找到他最近一次已完成的任务，用该任务的destination更新city
  /** @param {string | undefined} raw */
  const pureCity = (raw) => {
    if (!raw) return '';
    // 最长匹配优先：先去多字词缀，再去单字词缀；刻意去掉"南/北/东/西+站"的拆分，避免"济南站→济"这种误切
    return String(raw).replace(/(集散中心|分公司|火车站|港区|机场|仓|站)$/, '').trim();
  };
  const byDriver = new Map(); // driverId -> 最近已完成任务
  for (const t of MOCK_TASKS) {
    if (t.status !== '已完成' || !t.driver_id || !t.complete_time) continue;
    const prev = byDriver.get(Number(t.driver_id));
    if (!prev || (t.complete_time || '') > (prev.complete_time || '')) {
      byDriver.set(Number(t.driver_id), t);
    }
  }
  for (const d of MOCK_DRIVERS) {
    const t = byDriver.get(Number(d.id));
    if (t) {
      const city = pureCity(t.destination);
      if (city) d.city = city;
    }
  }
})();

async function connectDB() {
  // 本版本默认使用内存 Mock，保证开箱即用。MySQL 失败不影响。
  mysqlAvailable = false;
  return false;
}
function getDBStatus() {
  return { mysql: mysqlAvailable ? 'ok' : 'mock', pool: pool ? 'connected' : 'n/a' };
}

module.exports = {
  MOCK_USERS, MOCK_DRIVERS, driverSeq, MOCK_TASKS, MOCK_TASK_LOGS,
  MOCK_NOTIFS, MOCK_VIOLATIONS,
  MOCK_DRIVER_CHANGE_LOGS, pushDriverChangeLog,
  MOCK_ACCOUNT_LOGS, pushAccountLog,
  addDriverMeta, buildAttendance, authRequired, pushLog, pushNotif, broadcastToAdminsAndDispatchers,
  notifyAdmins, notifyDispatchers,
  maintenanceInfo, nowFmt,
  recommendVehicleByCargo, getTaskDeadlineMs, getTaskTimelyFlag,
  parseD,
  TOKEN_POOL, userSeq, generateToken, removeToken,
  connectDB, getDBStatus,
};
