// 通知 路由
const express = require('express');
const router = express.Router();
const { MOCK_NOTIFS, authRequired } = require('../db');

// 拉取我的通知(按角色)；db 中用 read 字段，前端用 unread，这里统一映射
function toView(n) {
  return { ...n, unread: !n.read };
}

router.get('/', authRequired(), (req, res) => {
  try {
    const role = req.user.role;
    const list = MOCK_NOTIFS
      .filter(n => n.to_role === 'all' || n.to_role === role || n.to_user_id === req.user.id)
      .map(toView);
    res.json({ list, unread: list.filter(n => n.unread).length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// 标记全部已读
router.post('/read-all', authRequired(), (req, res) => {
  const role = req.user.role;
  for (const n of MOCK_NOTIFS) {
    if (n.to_role === 'all' || n.to_role === role || n.to_user_id === req.user.id) n.read = true;
  }
  res.json({ ok: true });
});

// 单条已读
router.post('/:id/read', authRequired(), (req, res) => {
  const id = Number(req.params.id);
  const n = MOCK_NOTIFS.find(x => x.id === id);
  if (n) n.read = true;
  res.json({ ok: true });
});

module.exports = router;
