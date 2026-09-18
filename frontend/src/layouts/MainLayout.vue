<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '../stores/user'
import {
  getNotifications, markAllRead, markOneRead, logout as apiLogout,
  updateMyPassword as apiUpdateMyPassword, updateMe as apiUpdateMe,
  getPendingTaskCount,
} from '../api'
import { ElMessage, ElNotification } from 'element-plus'
import {
  Van, DataLine, Histogram, UserFilled, Van as Van2, FolderDelete, User, TrendCharts, Setting, Bell, Moon, Sunny, Promotion,
  SwitchButton, Postcard, Lock, ArrowRight,
} from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const menus = computed(() => {
  const base = [
    { name: '数据概览',   path: '/dashboard',   icon: DataLine },
    { name: '任务发布',   path: '/tasks/new',   icon: Promotion, adminOnly: true }, // 仅管理员
    { name: '任务派发与跟踪', path: '/tasks',   icon: Histogram },
    { name: '历史任务',   path: '/history',     icon: FolderDelete },
    { name: '司机管理',   path: '/drivers',     icon: Van2 },
    { name: '人员变动',   path: '/personnel',   icon: User }, // 超级管理员+调度员共用：前者审核、后者录入新司机申请
    { name: '数据查询统计', path: '/statistics', icon: TrendCharts },
    { name: '账号管理',   path: '/users',       icon: Setting, adminOnly: true }, // 仅管理员
  ]
  return base.filter(m => !m.adminOnly || userStore.isAdmin)
})

function menuActive(path: string) {
  // 司机详情/drivers/xx => 高亮司机管理
  if (path === '/drivers' && route.path.startsWith('/drivers/')) return true
  return route.path === path
}

function goMenu(m: any) {
  router.push(m.path)
}

// 通知
const notifList = ref<any[]>([])
const unreadCount = computed(() => notifList.value.filter(n => n.unread).length)
const notifPopperVisible = ref(false)
let timer: any = null

// 已弹过的核心消息 id（防重复弹窗）
const poppedCoreIds = new Set<number>()

async function fetchNotifs() {
  try {
    const r = await getNotifications()
    notifList.value = (r.list || []).slice(0, 50)
    // 核心消息（任务超时预警/加急任务异常）→ 右上角弹窗提醒 + 跳转按钮
    for (const n of notifList.value) {
      if (n.core && n.unread && !poppedCoreIds.has(n.id)) {
        poppedCoreIds.add(n.id)
        ElNotification({
          title: '核心提醒',
          message: n.title,
          type: n.type === 'error' ? 'error' : 'warning',
          duration: 3000,
          showClose: true,
          onClick: () => goNotifLink(n),
        })
      }
    }
  } catch (_) { /* noop */ }
}
function goNotifLink(n: any) {
  if (n.link) router.push(n.link)
  if (!n.unread) return
  markOneRead(n.id).then(() => { n.unread = false }).catch(() => {})
}
function notifTypeIcon(t: string) {
  if (t === 'error' || t === 'danger') return '🔴'
  if (t === 'warning' || t === 'warn')   return '🟠'
  if (t === 'success') return '🟢'
  return '🔵'
}
async function readOne(n: any) {
  if (!n.unread) return
  try { await markOneRead(n.id); n.unread = false } catch(_){}
}
async function readAll() {
  try { await markAllRead(); notifList.value.forEach(n => n.unread = false) } catch(_){}
}

// 调度员每日登录提醒：还有几个未发车任务待处理
function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
async function dailyPendingTip() {
  if (userStore.user?.role !== 'dispatcher') return
  const key = `pendingTip_${userStore.user?.id}_${todayKey()}`
  if (localStorage.getItem(key)) return
  try {
    const r = await getPendingTaskCount()
    localStorage.setItem(key, '1')
    const count = Number(r.count) || 0
    if (count > 0) {
      ElNotification({
        title: '待处理任务提醒',
        message: `您还有 ${count} 个未发车的任务待处理，请及时安排。`,
        type: 'warning',
        duration: 3000,
        showClose: true,
        onClick: () => router.push('/tasks'),
      })
    }
  } catch (_) { /* noop */ }
}

onMounted(() => {
  fetchNotifs()
  dailyPendingTip()
  timer = setInterval(fetchNotifs, 30000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

// 主题切换
function toggleTheme() {
  userStore.setTheme(userStore.theme === 'dark' ? 'light' : 'dark')
}

// ---------- 个人信息弹窗 ----------
const profileVisible = ref(false)
const profileForm = ref({ name: '', phone: '', gender: '男' })
function openProfile() {
  profileForm.value = {
    name: userStore.user?.name || '',
    phone: (userStore.user as any)?.phone || '',
    gender: (userStore.user as any)?.gender || '男',
  }
  profileVisible.value = true
}
async function saveProfile() {
  if (!profileForm.value.name.trim()) { ElMessage.warning('请填写姓名'); return }
  try {
    const u = await apiUpdateMe(profileForm.value)
    userStore.setUser(u)
    profileVisible.value = false
    ElMessage.success('个人信息已更新')
  } catch (_) {}
}

// ---------- 修改密码弹窗（旧密码 + 新密码 + 确认） ----------
const pwdVisible = ref(false)
const pwdForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' })
function openResetPwd() {
  pwdForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' }
  pwdVisible.value = true
}
async function savePassword() {
  const { oldPassword, newPassword, confirmPassword } = pwdForm.value
  if (!oldPassword) { ElMessage.warning('请填写旧密码'); return }
  if (!newPassword || newPassword.length < 6) { ElMessage.warning('新密码至少 6 位'); return }
  if (newPassword !== confirmPassword) { ElMessage.warning('两次输入的新密码不一致'); return }
  try {
    await apiUpdateMyPassword({ oldPassword, newPassword })
    pwdVisible.value = false
    ElMessage.success('密码修改成功，请牢记新密码')
  } catch (_) {}
}

async function handleLogout() {
  try {
    await apiLogout()
  } catch(_){}
  userStore.logout()
  router.push('/login')
}
</script>

<template>
  <el-container style="height: 100vh; width: 100vw">
    <!-- 侧边栏 -->
    <el-aside width="210px" style="border-right: 1px solid var(--border-color)">
      <div class="logo">
        <el-icon :size="22" color="#409EFF"><Van /></el-icon>
        <b>司机任务管理后台</b>
      </div>
      <el-menu :default-active="route.path" router class="side-menu" :collapse="false" background-color="transparent" text-color="inherit">
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path" @click="goMenu(m)" :class="{ 'active': menuActive(m.path) }">
          <el-icon style="margin-right:8px"><component :is="m.icon" /></el-icon>
          <span>{{ m.name }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 顶部 -->
      <el-header style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-color)">
        <div style="font-size:16px;font-weight:600">
          {{ menus.find(m => menuActive(m.path))?.name || '货运司机任务分派管理系统' }}
        </div>
        <div style="display:flex;align-items:center;gap:14px">
          <el-icon :size="18" style="cursor:pointer" @click="toggleTheme" :title="userStore.theme === 'dark' ? '切换为浅色模式' : '切换为夜间模式'">
            <Moon v-if="userStore.theme === 'light'" />
            <Sunny v-else />
          </el-icon>

          <el-popover placement="bottom-end" :width="360" trigger="click" v-model="notifPopperVisible" @show="fetchNotifs">
            <template #reference>
              <div style="position:relative;cursor:pointer;display:flex;align-items:center">
                <el-icon :size="18"><Bell /></el-icon>
                <span v-if="unreadCount" class="badge">{{ unreadCount }}</span>
              </div>
            </template>
            <div class="notif-header">
              <b>消息通知</b>
              <el-button size="small" link @click="readAll">全部已读</el-button>
            </div>
            <div class="notif-list">
              <div v-for="n in notifList.slice(0, 20)" :key="n.id" class="notif-item" :class="{ unread: n.unread }" @click="readOne(n)">
                <div class="t">
                  {{ notifTypeIcon(n.type) }} {{ n.title }}
                </div>
                <div class="m">
                  <span class="from">{{ n.from }}</span>
                  <span class="time">{{ n.time }}</span>
                  <el-button v-if="n.link" size="small" type="primary" link @click.stop="goNotifLink(n)">
                    前往处理 <el-icon><ArrowRight /></el-icon>
                  </el-button>
                </div>
              </div>
              <el-empty v-if="!notifList.length" description="暂无消息" />
            </div>
          </el-popover>

          <el-dropdown trigger="click" @command="(c:any) => { if (c==='profile') openProfile(); if (c==='pwd') openResetPwd(); if (c==='logout') handleLogout(); }">
            <div style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <el-avatar :size="28" style="background:#409EFF;color:#fff">
                {{ userStore.user?.avatar || userStore.user?.name?.charAt(0) || 'U' }}
              </el-avatar>
              <span style="font-size:13px">
                {{ userStore.displayName || '用户' }}
                <el-tag size="small" type="primary" v-if="userStore.isAdmin" effect="light" style="margin-left:4px">管理员</el-tag>
                <el-tag size="small" type="warning" v-else effect="light" style="margin-left:4px">调度员</el-tag>
              </span>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="theme" @click="toggleTheme">
                  <el-icon style="margin-right:6px"><component :is="userStore.theme === 'dark' ? Sunny : Moon" /></el-icon>
                  {{ userStore.theme === 'dark' ? '浅色模式' : '夜间模式' }}
                </el-dropdown-item>
                <el-dropdown-item command="profile">
                  <el-icon style="margin-right:6px"><Postcard /></el-icon>个人信息
                </el-dropdown-item>
                <el-dropdown-item command="pwd">
                  <el-icon style="margin-right:6px"><Lock /></el-icon>修改密码
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon style="margin-right:6px"><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 内容 -->
      <el-main style="background:var(--bg-page);overflow:auto">
        <RouterView />
      </el-main>
    </el-container>

    <!-- 个人信息弹窗 -->
    <el-dialog v-model="profileVisible" title="个人信息" width="440px" destroy-on-close>
      <el-form :model="profileForm" label-width="80px">
        <el-form-item label="账号">
          <el-input :model-value="userStore.user?.username" disabled />
        </el-form-item>
        <el-form-item label="角色">
          <el-input :model-value="userStore.isAdmin ? '管理员' : '调度员'" disabled />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="profileForm.name" placeholder="请输入姓名" maxlength="20" />
        </el-form-item>
        <el-form-item label="电话号码">
          <el-input v-model="profileForm.phone" placeholder="请输入电话号码" maxlength="11" />
        </el-form-item>
        <el-form-item label="性别">
          <el-radio-group v-model="profileForm.gender">
            <el-radio value="男">男</el-radio>
            <el-radio value="女">女</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="profileVisible = false">取消</el-button>
        <el-button type="primary" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>

    <!-- 修改密码弹窗（旧密码 + 新密码 + 确认新密码） -->
    <el-dialog v-model="pwdVisible" title="修改密码" width="440px" destroy-on-close>
      <el-form :model="pwdForm" label-width="90px">
        <el-form-item label="旧密码" required>
          <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="请输入当前密码" />
        </el-form-item>
        <el-form-item label="新密码" required>
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="确认新密码" required>
          <el-input v-model="pwdForm.confirmPassword" type="password" show-password placeholder="再次输入新密码" @keyup.enter="savePassword" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" @click="savePassword">确定修改</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.logo { display:flex;align-items:center;gap:6px;height:56px;padding:0 14px;border-bottom:1px solid var(--border-color);font-size:15px;color:inherit }
.side-menu { border-right:none !important; padding-top:8px }
.el-menu-item { border-radius:6px; margin:2px 6px }
.el-menu-item.active { background: #ecf5ff; color:#409EFF; font-weight:600 }
:deep(html[data-theme='dark'] .el-menu-item.active) { background: #1d4e89; }
.badge {
  position: absolute; top:-6px; right:-8px; min-width:16px; height:16px; padding:0 4px;
  background:#f56c6c; color:#fff; border-radius:8px; font-size:11px; display:flex;align-items:center;justify-content:center;
}
.notif-header { display:flex; justify-content:space-between; align-items:center; padding-bottom:8px; border-bottom:1px dashed var(--border-color) }
.notif-list { max-height:340px; overflow:auto; margin-top:6px }
.notif-item { padding:10px 6px; border-radius:6px; cursor:pointer }
.notif-item:hover { background:rgba(64,158,255,0.08) }
.notif-item.unread { background:rgba(64,158,255,0.06) }
.notif-item .t { font-size:13px; color:inherit }
.notif-item .m { margin-top:4px; display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:11px; color:var(--color-muted) }
</style>
