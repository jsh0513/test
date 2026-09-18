import axios from 'axios'
import { ElMessage } from 'element-plus'
import { useUserStore } from '../stores/user'

const request = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

request.interceptors.request.use(
  (config) => {
    const store = useUserStore()
    if (store.token) config.headers['x-token'] = store.token
    return config
  }
)

request.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const status = err?.response?.status
    const msg = err?.response?.data?.message || err.message || '请求失败'
    // R9: silent 请求（轮询/后台刷新）不弹 ElMessage，避免"总有错误提示"
    const silent = err?.config?.silent === true
    if (status === 401) {
      if (!silent) {
        const store = useUserStore()
        store.logout()
        const path = location.pathname || ''
        if (path !== '/login' && !path.startsWith('/login')) {
          location.href = '/login'
        }
      }
    } else if (!silent && status !== 404) {
      if (status === 403) ElMessage.error('无权限执行该操作')
      else ElMessage.error(msg)
    }
    return Promise.reject(err)
  }
)

// ============ Auth ============
export const login    = (data: { username: string; password: string }) => request.post('/users/login', data) as any
export const logout   = () => request.post('/users/logout') as any
export const getMe    = () => request.get('/users/me') as any
export const updateMe = (d: any) => request.put('/users/me', d) as any
export const updateMyPassword = (d: any) => request.put('/users/me/password', d) as any
// 调度员登录提醒：未发车待处理任务数
export const getPendingTaskCount = () => request.get('/users/me/pending-tasks') as any

// ============ Users (管理员) ============
export const getUsers   = ()                 => request.get('/users') as any
export const createUser = (d: any)           => request.post('/users', d) as any
export const updateUser = (id: number, d: any) => request.put(`/users/${id}`, d) as any
export const deleteUser = (id: number)       => request.delete(`/users/${id}`) as any

// 人员变动-账号管理日志（创建/信息修改/密码修改/删除）
export const getAccountLogs = (p: any = {}) => request.get('/users/account-logs', { params: p }) as any

// ============ Drivers ============
export const getDrivers   = (p: any)           => request.get('/drivers', { params: p }) as any
export const createDriver = (d: any)           => request.post('/drivers', d) as any
export const updateDriver = (id: number, d: any) => request.put(`/drivers/${id}`, d) as any
export const deleteDriver = (id: number)       => request.delete(`/drivers/${id}`) as any
export const auditDriver  = (id: number, pass: boolean, reason = '') => request.post(`/drivers/${id}/audit`, { pass, reason }) as any
export const getDriverDetail = (id: number)    => request.get(`/drivers/${id}/detail`) as any
export const getAvailableDrivers = ()          => request.get('/drivers/list/available') as any
// R5/R6: 停用/启用（调度员也可停用空闲人员，但不能启用停用的）
export const toggleDriverDisable = (id: number) => request.post(`/drivers/${id}/toggle-disable`) as any
// 司机 出勤/接单/违章/保修 按月查询
export const getDriverAttendance = (id: number, year: number, month: number) =>
  request.get(`/drivers/${id}/attendance`, { params: { year, month } }) as any
export const getDriverMonthlyTasks = (id: number, year: number, month: number) =>
  request.get(`/drivers/${id}/tasks`, { params: { year, month } }) as any
export const getDriverMonthlyViolations = (id: number, year: number, month: number) =>
  request.get(`/drivers/${id}/violations`, { params: { year, month } }) as any
export const updateDriverMaintenance = (id: number, date?: string) =>
  request.post(`/drivers/${id}/maintenance`, { date }) as any

// 人员变动：待审核司机列表 + 司机变更日志
export const getPendingDrivers = (p: any = {}) => request.get('/drivers/pending/all', { params: p }) as any
export const getDriverChangeLogs = (p: any = {}) => request.get('/drivers/change-logs/all', { params: p }) as any

// ============ Tasks ============
export const getTasks       = (p: any)         => request.get('/tasks', { params: p }) as any
export const getHistoryTasks = (p: any)        => request.get('/tasks/history', { params: p }) as any
export const getUrgentTasks = ()               => request.get('/tasks/urgent') as any
export const getTaskDetail  = (id: string)     => request.get(`/tasks/${id}`) as any
export const createTask     = (d: any)         => request.post('/tasks', d) as any
export const updateTask     = (id: string, d: any) => request.put(`/tasks/${id}`, d) as any
export const dispatchTask   = (id: string, driverId: number) => request.post(`/tasks/${id}/dispatch`, { driverId }) as any
export const completeTask   = (id: string, body: any = {}) => request.post(`/tasks/${id}/complete`, body) as any
// 上报异常（进行中 → 异常；最多 3 张现场图片 + 异常原因）
export const reportTaskException = (id: string, body: { reason: string; images: string[] }) =>
  request.post(`/tasks/${id}/report-exception`, body) as any
export const cancelTask     = (id: string, reason: string) => request.post(`/tasks/${id}/cancel`, { reason }) as any
export const toggleTaskOverdue = (id: string) => request.post(`/tasks/${id}/toggle-overdue`) as any
// 三个新的 toggle 接口：发车超时 / 任务超时 / 加急标记
export const toggleDepartOverdue = (id: string) => request.post(`/tasks/${id}/toggle-depart-overdue`) as any
export const toggleTaskOverdueFlag = (id: string) => request.post(`/tasks/${id}/toggle-task-overdue`) as any
export const toggleUrgentFlag = (id: string) => request.post(`/tasks/${id}/toggle-urgent`) as any
// ---- 任务发布/草稿 (R1)：返回 unpublished + scheduled 两个分组 ----
export const getDraftTasks  = ()               => request.get('/tasks/drafts/list') as any
export const publishTask    = (id: string)     => request.post(`/tasks/${id}/publish`) as any
export const publishAllDrafts = ()             => request.post('/tasks/bulk/publish-all') as any
export const scheduleTask   = (id: string, scheduled_at: string) => request.post(`/tasks/${id}/schedule`, { scheduled_at }) as any
export const cancelScheduledTask = (id: string) => request.post(`/tasks/${id}/cancel-schedule`) as any
// 批量操作
export const bulkScheduleTasks = (ids: string[], scheduled_at: string) => request.post('/tasks/bulk/schedule', { ids, scheduled_at }) as any
export const bulkDeleteDrafts   = (ids: string[]) => request.post('/tasks/bulk/delete', { ids }) as any
export const bulkCreateTasks    = (d: any) => request.post('/tasks/bulk/create', d) as any
// OCR 图片识别：后端 tesseract.js 识别 + parseFields 解析
export const ocrRecognize = (fd: FormData) => request.post('/ocr', fd, { headers: { 'Content-Type': 'multipart/form-data' } }) as any
// ---- 发车 (Q2) ----
export const departTask     = (id: string)     => request.post(`/tasks/${id}/depart`) as any

// ============ Stats ============
export const getOverview     = () => request.get('/stats/overview') as any
export const getTaskStatus   = () => request.get('/stats/task-status') as any
export const getDriverStatus = () => request.get('/stats/driver-status') as any
export const getTrend        = (days: number | string = 7) => request.get('/stats/trend', { params: { days } }) as any

// ============ Notifications ============
export const getNotifications = () => request.get('/notifications') as any
export const markAllRead       = () => request.post('/notifications/read-all') as any
export const markOneRead       = (id: number) => request.post(`/notifications/${id}/read`) as any

// ============ Excel 导出（R7 修复：用 Blob 下载，响应拦截器放行二进制） ============
function withToken(params: any = {}) {
  const store = useUserStore()
  const usp = new URLSearchParams(params as any)
  usp.set('token', store.token)
  return usp.toString()
}

async function downloadBlob(url: string, filename: string) {
  try {
    const store = useUserStore()
    // R7 修复：URL已含完整 /api/... 前缀，不要再叠加 baseURL（否则部分axios版本会生成 /api/api/... 404）
    const res = await axios.get(url, {
      responseType: 'blob',
      timeout: 60000,
      headers: store.token ? { 'x-token': store.token } : {},
    })
    const blob = new Blob([res.data])
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    return true
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '下载失败'
    ElMessage.error(msg)
    return false
  }
}

export async function exportTasksExcel(params: any = {}, ids: string[] = []) {
  const p: any = { ...params }
  if (ids && ids.length) p.ids = ids.join(',')
  const qs = withToken(p)
  const ok = await downloadBlob(`/api/exports/tasks/xlsx?${qs}`, `任务记录_${Date.now()}.xlsx`)
  if (ok) ElMessage.success('任务记录 Excel 已开始下载')
  return ok
}

export async function exportAttendanceExcel(params: any = {}, ids: number[] = []) {
  const p: any = { ...params }
  if (ids && ids.length) p.ids = ids.join(',')
  const qs = withToken(p)
  const ok = await downloadBlob(`/api/exports/drivers/attendance/xlsx?${qs}`, `员工出勤记录_${p.year||'year'}-${String(p.month||'month').padStart(2,'0')}_${Date.now()}.xlsx`)
  if (ok) ElMessage.success('员工出勤记录 Excel 已开始下载')
  return ok
}

export async function exportReconciliationExcel(params: any = {}, ids: string[] = []) {
  const p: any = { ...params }
  if (ids && ids.length) p.ids = ids.join(',')
  const qs = withToken(p)
  const ok = await downloadBlob(`/api/exports/reconciliation/xlsx?${qs}`, `订单运单对账表_${Date.now()}.xlsx`)
  if (ok) ElMessage.success('订单/运单对账表 Excel 已开始下载')
  return ok
}

export const getReportSummary = () => request.get('/exports/report/summary') as any

export default request
