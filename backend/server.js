const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
// 确认完成/异常上报会把最多 3 张照片以 base64 放进 JSON，默认 100kb 会报 request entity too large
app.use(express.json({ limit: '25mb' }));

const { connectDB, getDBStatus } = require('./db');
connectDB().then(ok => {
  console.log('[DB]', ok ? 'MySQL 已连接' : '未连 MySQL，使用内存 Mock');
});

// 公开接口(登录 + 健康检查)
app.use('/api/users',   require('./routes/users'));        // /login, /logout, /me 公开/半公开
app.get('/api/health', (req, res) => res.json({ ok: true, ...getDBStatus() }));

// 业务路由(都走了 authRequired 守卫)
app.use('/api/drivers',       require('./routes/drivers'));
app.use('/api/tasks',         require('./routes/tasks'));
app.use('/api/stats',         require('./routes/stats'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/exports',       require('./routes/exports'));
app.use('/api/ocr',           require('./routes/ocr'));

// 统一错误
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || '服务器错误' });
});

const PORT = Number(process.env.PORT) || 3001;

// ———— 安全启动：遇到 EADDRINUSE 自动提示端口占⽤，并告诉你杀哪一个 PID ————
const { execSync } = require('child_process');

function startServer(port) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(64));
    console.log(`🚀 货运司机任务管理后端 v2 已启动：`);
    console.log(`   本机访问  : http://localhost:${port}`);
    console.log(`   前端地址  : http://localhost:5174`);
    console.log(`   默认账号  : admin / disp1 / disp2   密码均为 123456`);
    console.log('='.repeat(64) + '\n');
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口 ${port} 已被占用！`);
      try {
        // Windows 查占用 PID；兼容 PowerShell 输出
        const netstat = execSync('netstat -ano', { encoding: 'utf8' });
        const lines = String(netstat).split(/\r?\n/).filter(l => l.includes(`:${port} `) || l.includes(`:${port}\t`));
        if (lines.length) {
          console.error(`   占用详情：`);
          lines.slice(0, 5).forEach(l => console.error('   ' + l.trim()));
          const pids = Array.from(new Set(lines.map(l => (l.trim().match(/\d+\s*$/) || [])[0]).filter(Boolean)));
          if (pids.length) {
            console.error(`\n👉 解决办法（管理员 PowerShell / CMD 任一即可）：`);
            pids.forEach(pid => {
              console.error(`   taskkill /F /PID ${pid}`);
            });
          }
        } else {
          console.error(`   可以运行：netstat -ano | findstr :${port}`);
        }
      } catch (e) {
        // ignore
      }
      console.error(`\n👉 或改后端端口： set PORT=3002 && node server.js\n`);
      process.exit(1);
    } else {
      console.error('启动错误：', err);
      process.exit(1);
    }
  });

  // 处理 Ctrl+C 退出
  process.on('SIGINT', () => {
    console.log('\n收到 Ctrl+C, 正在关闭服务...');
    server.close(() => {
      console.log('服务已关闭，端口释放成功');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  return server;
}

startServer(PORT);

// ---------- 后台扫描器（每 30 秒） ----------
// 1) 定时任务到点自动发布（加急任务自动发布时给调度员发核心通知）
// 2) 已发车任务距完成期限 ≤1 小时或已超时 → 调度员核心预警
// 3) 发布超 60 分钟仍无人分派 → 管理员积压预警
// 同一任务同一类预警只推一次（内存 Set 去重，重启后重新判定）
const db2 = require('./db');
const alertedTimeout = new Set();
const alertedBacklog = new Set();

function runScheduler() {
  try {
    const now = Date.now();

    // 1. 定时发布：到点任务自动进入派发中心
    for (const t of db2.MOCK_TASKS) {
      if (t.published !== false || !t.scheduled_at) continue;
      const ms = db2.parseD(t.scheduled_at);
      if (!ms || ms > now) continue;
      t.published = true;
      t.scheduled_at = null;
      t.status = '待派发';
      t.publish_time = db2.nowFmt();
      db2.pushLog({ task_id: t.id, type: 'edit', user_id: 0, user_name: '系统', detail: '定时发布时间到达，系统自动发布任务' });
      if (t.is_urgent || t.urgent_manual) {
        db2.notifyDispatchers({
          from: '系统',
          title: `定时加急任务 ${t.id} 已自动发布：${t.origin} → ${t.destination}，请优先派发`,
          type: 'warning', core: true, link: '/tasks',
        });
      }
    }

    // 2. 调度员：完成即将超时 / 已超时（已发车、未完成的任务）
    for (const t of db2.MOCK_TASKS) {
      if (t.published === false) continue;
      if (['已完成', '已取消'].includes(t.status)) continue;
      // 异常任务（无论是否已确认完成）不再推送超时预警，避免干扰
      if (t.status === '异常' || t.complete_time) continue;
      if (!t.departure_time || !t.dispatch_time) continue;
      if (alertedTimeout.has(t.id)) continue;
      const ddl = db2.parseD(t.dispatch_time) + Number(t.sla_hours || 8) * 3600 * 1000;
      if (!ddl) continue;
      const remain = ddl - now;
      if (remain > 3600 * 1000) continue;
      alertedTimeout.add(t.id);
      db2.notifyDispatchers({
        from: '系统',
        title: remain < 0
          ? `任务 ${t.id} 已超过完成期限（${t.origin} → ${t.destination}，司机：${t.driver_name}），请立即跟进`
          : `任务 ${t.id} 距完成期限不足 1 小时（${t.origin} → ${t.destination}，司机：${t.driver_name}），请关注进度`,
        type: 'warning', core: true, link: '/tasks',
      });
    }

    // 3. 管理员：长时间无人分派的积压任务（发布超 60 分钟仍待派发）
    for (const t of db2.MOCK_TASKS) {
      if (t.published === false) continue;
      if (t.status !== '待派发' || t.driver_id) continue;
      if (alertedBacklog.has(t.id)) continue;
      const refMs = db2.parseD(t.publish_time || t.create_time);
      if (!refMs || now - refMs <= 3600 * 1000) continue;
      alertedBacklog.add(t.id);
      db2.notifyAdmins({
        from: '系统',
        title: `任务 ${t.id} 发布已超 1 小时仍无人分派（${t.origin} → ${t.destination}${t.is_urgent ? '，加急任务' : ''}），请及时处理积压`,
        type: 'warning', core: true, link: '/tasks',
      });
    }
  } catch (e) {
    console.error('[scheduler] 扫描异常：', e);
  }
}

runScheduler();
setInterval(runScheduler, 30 * 1000);
// taskkill /f /im node.exe 杀掉所有node.exe 进程,重新启动后端