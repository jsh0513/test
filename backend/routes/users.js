// 用户/登录 路由
const express = require('express');
const router = express.Router();
const db = require('../db');
const {
  MOCK_USERS, generateToken, removeToken,
  authRequired, pushAccountLog,
} = db;

// 登录(公开接口)
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = MOCK_USERS.find(x => x.username === username && x.password === password);
  if (!u) return res.status(401).json({ message: '账号或密码错误' });
  const token = generateToken(u.id);
  const { password: _pw, ...safeUser } = u;
  res.json({ token, user: safeUser });
});

// 登出
router.post('/logout', authRequired(), (req, res) => {
  removeToken(req.token);
  res.json({ ok: true });
});

// 当前用户信息
router.get('/me', authRequired(), (req, res) => {
  const { password: _pw, ...safeUser } = req.user;
  res.json(safeUser);
});

// 调度员每日登录提醒：未发车任务数（待派发无人接 + 自己派发但尚未发车的）
router.get('/me/pending-tasks', authRequired(), (req, res) => {
  const { MOCK_TASKS } = db;
  const count = MOCK_TASKS.filter(t =>
    t.published !== false &&
    !['已完成', '已取消'].includes(t.status) &&
    !t.departure_time &&
    (t.status === '待派发' || t.dispatcher_id === req.user.id)
  ).length;
  res.json({ count });
});

// 修改密码(自己改自己)
router.put('/me/password', authRequired(), (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (req.user.password !== oldPassword) return res.status(400).json({ message: '原密码错误' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: '新密码至少 6 位' });
  req.user.password = newPassword;
  pushAccountLog({
    action: 'change_password', operator_id: req.user.id, operator_name: req.user.name,
    target_id: req.user.id, target_username: req.user.username, target_name: req.user.name,
    detail: '修改自己的登录密码',
  });
  res.json({ ok: true });
});

// ---------- 账号管理(仅管理员)----------

// 账号列表
router.get('/', authRequired(['admin']), (req, res) => {
  const list = MOCK_USERS.map(u => { const { password, ...x } = u; return x; });
  res.json({ list, total: list.length });
});

// 账号操作记录（仅管理员）：创建账号、修改密码等操作留痕
router.get('/account-logs', authRequired(['admin']), (req, res) => {
  const { MOCK_ACCOUNT_LOGS } = db;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 10));
  const total = MOCK_ACCOUNT_LOGS.length;
  const start = (page - 1) * pageSize;
  const list = MOCK_ACCOUNT_LOGS.slice(start, start + pageSize);
  res.json({ list, total, page, pageSize });
});

// 新增账号
router.post('/', authRequired(['admin']), (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name || !role) return res.status(400).json({ message: '参数不完整' });
  if (!['admin','dispatcher'].includes(role)) return res.status(400).json({ message: '角色不合法' });
  const isSuperAdmin = req.user.username === 'admin' || req.user.id === 1;
  // 仅超级管理员可创建管理员账号
  if (role === 'admin' && !isSuperAdmin) return res.status(403).json({ message: '仅超级管理员可创建管理员账号' });
  if (MOCK_USERS.find(u => u.username === username)) return res.status(400).json({ message: '用户名已存在' });
  const u = {
    id: db.userSeq,
    username, password, name, role,
    avatar: name.charAt(0),
    created_at: new Date().toISOString().slice(0,10),
  };
  db.userSeq++;
  MOCK_USERS.push(u);
  pushAccountLog({
    action: 'create', operator_id: req.user.id, operator_name: req.user.name,
    target_id: u.id, target_username: u.username, target_name: u.name,
    detail: `创建账号（角色：${role === 'admin' ? '管理员' : '调度员'}）`,
  });
  const { password: _pw, ...safe } = u;
  res.json(safe);
});

// 修改账号(密码/姓名/角色)
// 权限：超级管理员(admin 账号/id=1) 可修改任意账号（含角色）；
//       普通管理员只能修改非管理员（调度员）账号的信息，不能改角色、不能动其他管理员
router.put('/:id', authRequired(['admin']), (req, res) => {
  const id = Number(req.params.id);
  const u = MOCK_USERS.find(x => x.id === id);
  if (!u) return res.status(404).json({ message: '账号不存在' });
  const isSuperAdmin = req.user.username === 'admin' || req.user.id === 1;
  const body = req.body || {};
  if (!isSuperAdmin) {
    // 普通管理员：不能修改管理员账号
    if (u.role === 'admin') {
      return res.status(403).json({ message: '仅超级管理员可修改管理员账号' });
    }
    // 普通管理员：不能调整角色
    if (body.role && body.role !== u.role) {
      return res.status(403).json({ message: '仅超级管理员可调整账号角色' });
    }
  }
  // 记录变更前的关键字段，用于操作留痕
  const oldRole = u.role;
  const oldName = u.name || '';
  const oldPhone = u.phone || '';
  const oldGender = u.gender || '';
  const roleLabel = (r) => (r === 'admin' ? '管理员' : '调度员');
  if (body.password) {
    u.password = body.password;
    pushAccountLog({
      action: 'change_password', operator_id: req.user.id, operator_name: req.user.name,
      target_id: u.id, target_username: u.username, target_name: u.name,
      detail: `管理员重置「${u.name}」的登录密码`,
    });
  }
  if (body.name)     u.name = body.name;
  if (body.avatar)   u.avatar = body.avatar;
  if (body.phone !== undefined)  u.phone = body.phone;
  if (body.gender !== undefined) u.gender = body.gender;
  if (body.role && ['admin','dispatcher'].includes(body.role)) u.role = body.role;

  // 对别的账号进行的操作全部留痕：角色调整单独成类，其余资料变更记信息修改
  if (u.role !== oldRole) {
    pushAccountLog({
      action: 'role_change', operator_id: req.user.id, operator_name: req.user.name,
      target_id: u.id, target_username: u.username, target_name: u.name,
      detail: `将「${u.name}（${u.username}）」的角色由「${roleLabel(oldRole)}」调整为「${roleLabel(u.role)}」`,
    });
  }
  const infoChanges = [];
  if (u.name !== oldName) infoChanges.push(`姓名：${oldName || '空'} → ${u.name}`);
  if ((u.phone || '') !== oldPhone) infoChanges.push(`手机号：${oldPhone || '空'} → ${u.phone || '空'}`);
  if ((u.gender || '') !== oldGender) infoChanges.push(`性别：${oldGender || '空'} → ${u.gender || '空'}`);
  if (infoChanges.length) {
    pushAccountLog({
      action: 'edit_info', operator_id: req.user.id, operator_name: req.user.name,
      target_id: u.id, target_username: u.username, target_name: u.name,
      detail: `修改账号信息（${infoChanges.join('；')}）`,
    });
  }
  const { password: _pw, ...safe } = u;
  res.json(safe);
});

// 删除账号（仅超级管理员可删除管理员账号；普通管理员只能删调度员）
router.delete('/:id', authRequired(['admin']), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ message: '不能删除当前登录账号' });
  const u = MOCK_USERS.find(x => x.id === id);
  if (!u) return res.status(404).json({ message: '账号不存在' });
  const isSuperAdmin = req.user.username === 'admin' || req.user.id === 1;
  if (u.role === 'admin' && !isSuperAdmin) {
    return res.status(403).json({ message: '仅超级管理员可删除管理员账号' });
  }
  const idx = MOCK_USERS.findIndex(x => x.id === id);
  // 删除前留痕（splice 后目标信息就没了）
  pushAccountLog({
    action: 'delete', operator_id: req.user.id, operator_name: req.user.name,
    target_id: u.id, target_username: u.username, target_name: u.name,
    detail: `删除账号「${u.name}（${u.username}），角色：${u.role === 'admin' ? '管理员' : '调度员'}」`,
  });
  MOCK_USERS.splice(idx, 1);
  res.json({ ok: true });
});

module.exports = router;
