const express = require('express');
const router = express.Router();
const {
  MOCK_TASKS, MOCK_DRIVERS, authRequired, getTaskTimelyFlag,
} = require('../db');

router.get('/overview', authRequired(), (req, res) => {
  // 本月口径：create_time 在当前年月；只统计已发布的任务（草稿不含）
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthTasks = MOCK_TASKS.filter(t => t.published !== false && String(t.create_time || '').startsWith(ym));

  const unassigned = monthTasks.filter(t => t.status === '待派发').length;
  const running    = monthTasks.filter(t => t.status === '进行中').length;
  const done       = monthTasks.filter(t => t.status === '已完成').length;
  const overdue    = monthTasks.filter(t => getTaskTimelyFlag(t).flag === 'overdue').length;
  const soon       = monthTasks.filter(t => getTaskTimelyFlag(t).flag === 'soon').length;
  // 本月新入职司机数（代替注册司机总数显示在卡片底部的需求已去除，这里直接不用该字段）
  const monthNewDrivers = MOCK_DRIVERS.filter(d => String(d.join_date || '').startsWith(ym)).length;

  res.json({
    unassigned_tasks: unassigned,
    running_tasks:    running,
    completed_tasks:  done,
    overdue_tasks:    overdue,
    soon_tasks:       soon,
    month_new_drivers: monthNewDrivers,
  });
});

router.get('/task-status', authRequired(), (req, res) => {
  const map = { '待派发': 0, '进行中': 0, '已完成': 0, '已取消': 0, '已超时': 0 };
  for (const t of MOCK_TASKS) {
    if (t.published === false) continue;
    let s = t.status;
    if ((s === '进行中' || s === '已延误') && getTaskTimelyFlag(t).overtime) s = '已超时';
    if (map[s] === undefined) map[s] = 0;
    map[s]++;
  }
  res.json(map);
});

// 司机状态占比：R3 改名：请假(原休息)、空闲(原在职)、任务中、已停用、休假、待审核
router.get('/driver-status', authRequired(), (req, res) => {
  // ⚠️ 绝对不能直接修改 MOCK_DRIVERS 里的原对象，否则污染其他接口！
  const map = { 请假: 0, 空闲: 0, 任务中: 0, 已停用: 0, 休假: 0, 待审核: 0 };
  for (const orig of MOCK_DRIVERS) {
    let s = orig.status;
    // 防止历史污染：旧名 "在职/休息" 映射为新名
    if (s === '在职') s = '空闲';
    if (s === '休息') s = '请假';
    if (!['已停用', '待审核', '请假', '休假'].includes(s)) {
      const hasRunning = MOCK_TASKS.some(t => t.driver_id === orig.id && (t.status === '进行中' || t.status === '已超时'));
      s = hasRunning ? '任务中' : '空闲';
    }
    if (map[s] === undefined) map[s] = 0;
    map[s]++;
  }
  res.json(map);
});

// N日任务趋势（Statistics 页面还在用）
router.get('/trend', authRequired(), (req, res) => {
  const days = Math.max(1, Number(req.query.days) || 7);
  const list = [];
  const base = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const count = MOCK_TASKS.filter(t => String(t.create_time || '').startsWith(dateStr)).length;
    list.push({ date: dateStr, count });
  }
  res.json(list);
});

module.exports = router;
