<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useUserStore } from '../stores/user'
import {
  Search, Edit, View, RefreshRight, CloseBold, Plus, Warning,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile, UploadFiles } from 'element-plus'
import {
  getTasks, getTaskDetail, updateTask, dispatchTask as apiDispatchTask,
  completeTask, cancelTask, departTask, getDrivers, reportTaskException,
} from '../api'
import { makeThumbnails } from '../utils/imageThumb'

const userStore = useUserStore()
const loading = ref(false)
const tableData = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const search = reactive({ keyword: '', status: '' })

const statusOptions = ['待派发', '待发车', '进行中', '已超时', '异常']

// 实时倒计时：每秒 tick，format 函数直接用 Date.now() 算
const nowTick = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null

async function fetch() {
  loading.value = true
  try {
    const r = await getTasks({ page: page.value, pageSize: pageSize.value, ...search })
    tableData.value = r.list || []
    total.value = r.total || 0
  } finally { loading.value = false }
}
onMounted(() => {
  fetch()
  tickTimer = setInterval(() => {
    // 性能：任一弹窗打开期间暂停 1s 级全表倒计时刷新。
    // nowTick 变化会触发整张表格（倒计时单元格 + 统计 chips）每秒重渲染，
    // 与 el-dialog 打开动画抢占主线程帧，是弹窗掉帧的隐性来源之一；
    // 弹窗覆盖表格期间冻结倒计时无业务影响，关闭后自动恢复。
    if (detailVisible.value || dispatchVisible.value || editVisible.value || completeVisible.value || exceptionVisible.value) return
    nowTick.value++
  }, 1000)
})
onUnmounted(() => { if (tickTimer) clearInterval(tickTimer) })
function onSearch() { page.value = 1; fetch() }

function displayStatus(row: any) { return row.effective_status || row.status }
function statusTag(row: any) {
  const s = displayStatus(row)
  if (s === '已超时') return { type: 'danger', text: s }
  if (s === '异常') return { type: 'danger', text: s, effect: 'dark' }
  if (s === '待派发') return { type: 'info', text: s }
  if (s === '待发车') return { type: 'warning', text: s }
  if (s === '进行中') return { type: 'primary', text: s }
  if (s === '已完成') return { type: 'success', text: s }
  if (s === '已取消') return { type: 'info', text: s }
  return { type: 'info', text: s }
}
function tableRowClass({ row }: { row: any }) {
  if (row?.effective_status === '已超时') return 'row-danger'
  return ''
}

// 格式化秒数为 "X时Y分" 或 "已超时 X时Y分"
function fmtSec(sec: number) {
  const abs = Math.abs(sec)
  const d = Math.floor(abs / 86400); let r = abs - d * 86400
  const h = Math.floor(r / 3600); r -= h * 3600
  const m = Math.floor(r / 60)
  const s = d > 0 ? `${d}天${h}时${m}分` : h > 0 ? `${h}时${m}分` : `${m}分`
  return sec < 0 ? `已超时 ${s}` : s
}

// 实时计算某个时间点距离现在的秒数
function secondsUntil(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null
  const ms = new Date(String(timeStr).replace(' ', 'T')).getTime()
  if (Number.isNaN(ms)) return null
  return Math.floor((ms - Date.now()) / 1000)
}

// 最迟发车倒计时：从 latest_departure_time 算
// 显示规则：待派发/待发车→显示剩余秒数；进行中及以后→"已发车"；已完成/已取消→"—"
function getDepartureDisplay(row: any): string {
  void nowTick.value // 触发响应式刷新
  const st = displayStatus(row)
  if (['已完成', '已取消'].includes(row.status)) return '—'
  if (st === '进行中' || st === '已超时') return '已发车'
  // 待派发 / 待发车：从 latest_departure_time 算
  const sec = secondsUntil(row.latest_departure_time)
  if (sec === null) return '—'
  return fmtSec(sec)
}

// 任务倒计时：从 dispatch_time + sla_hours 算
// 显示规则：待派发→"—"；待发车→"等待发车"；进行中/已超时→显示剩余；已完成/已取消→"—"
function getTaskCountdownDisplay(row: any): string {
  void nowTick.value
  const st = displayStatus(row)
  if (['已完成', '已取消'].includes(row.status)) return '—'
  if (st === '待派发') return '—'
  if (st === '待发车') return '等待发车'
  // 进行中 / 已超时：从 dispatch_time + sla_hours 算
  if (!row.dispatch_time) return '—'
  const ddlMs = new Date(String(row.dispatch_time).replace(' ', 'T')).getTime() + Number(row.sla_hours || 8) * 3600 * 1000
  if (Number.isNaN(ddlMs)) return '—'
  const sec = Math.floor((ddlMs - Date.now()) / 1000)
  return fmtSec(sec)
}

// 判断最迟发车是否不足1小时
function isDepartureSoon(row: any): boolean {
  const st = displayStatus(row)
  if (['进行中', '已超时', '已完成', '已取消'].includes(row.status)) return false
  const sec = secondsUntil(row.latest_departure_time)
  return sec !== null && sec >= 0 && sec < 3600
}
// 判断任务倒计时是否不足1小时
function isTaskSoon(row: any): boolean {
  const st = displayStatus(row)
  if (['待派发', '待发车', '已完成', '已取消'].includes(row.status)) return false
  if (!row.dispatch_time) return false
  const ddlMs = new Date(String(row.dispatch_time).replace(' ', 'T')).getTime() + Number(row.sla_hours || 8) * 3600 * 1000
  if (Number.isNaN(ddlMs)) return false
  const sec = Math.floor((ddlMs - Date.now()) / 1000)
  return sec >= 0 && sec < 3600
}

// 操作列末尾的三角警告：始终占位（隐藏也占区域），仅警示时可见
function warnInfo(row: any) {
  if (isDepartureSoon(row)) return { active: true, content: '⚠ 最迟发车不足1小时，请尽快发车！' }
  if (isTaskSoon(row)) return { active: true, content: '⚠ 任务截止不足1小时，将很快超时！' }
  return { active: false, content: '' }
}

// 状态方块统计（基于当前表格数据，不是全量数据）
const statusStats = computed(() => {
  void nowTick.value
  let pending = 0, waiting = 0, running = 0, overdue = 0, exception = 0
  for (const t of tableData.value) {
    const s = displayStatus(t)
    if (s === '待派发') pending++
    else if (s === '待发车') waiting++
    else if (s === '进行中') running++
    else if (s === '已超时') overdue++
    else if (s === '异常') exception++
  }
  return { pending, waiting, running, overdue, exception }
})

// ========= 状态列点击入口：待派发→派发 / 待发车→发车 =========
function handleStatusClick(row: any) {
  const s = displayStatus(row)
  if (s === '待派发') return openDispatch(row)
  if (s === '待发车') return doDepart(row)
}
function isStatusClickable(row: any) {
  const s = displayStatus(row)
  return s === '待派发' || s === '待发车'
}

// ========= 发车（待发车 → 进行中） =========
async function doDepart(row: any) {
  try {
    await ElMessageBox.confirm('确认发车？', '确认发车', {
      type: 'warning', confirmButtonText: '已发车', cancelButtonText: '取消',
    })
    const r = await departTask(row.id)
    // 本地先响应式更新该行，再拉取最新列表兜底，确保状态立即刷新
    row.status = '进行中'
    row.effective_status = '进行中'
    if (r?.departure_time) row.departure_time = r.departure_time
    ElMessage.success('发车成功，状态变为进行中')
    fetch()
  } catch (_) { }
}

// ========= 4 小时内发车警告 —— 仅对"待发车"任务显示 =========
function getDepartureWarn(row: any) {
  if (displayStatus(row) !== '待发车') return null   // 关键修复：进行中/已超时不再 warn
  if (!row.latest_departure_time) return null
  const ld = new Date(row.latest_departure_time.replace(' ', 'T')).getTime() / 1000
  if (Number.isNaN(ld)) return null
  const now = Math.floor(Date.now() / 1000)
  const remain = ld - now
  if (remain >= 0 && remain < 14400) return remain
  return null
}
function formatDepartureWarn(sec: number) {
  const h = Math.floor(sec / 3600); const m = Math.floor((sec - h * 3600) / 60)
  return `请尽快发车！距离最迟发车仅剩 ${h} 小时 ${m} 分钟`
}

// ========= 确认完成：两步弹窗（里程 + 最多 3 张运输照片） =========
const completeVisible = ref(false)
const completeTaskInfo = ref<any>(null)
const completeForm = reactive<{ trip_mileage: number; images: string[] }>({ trip_mileage: 0, images: [] })
// 受控文件列表：每次打开弹窗必须重置为空，否则 el-upload 内部列表会残留上一个任务的照片
const completeFileList = ref<UploadFile[]>([])
const completeUploadRef = ref<any>(null)
const completing = ref(false)
// 性能：表单 + el-upload 组件实例化较重，等 opened 动画结束再渲染（弹窗本身不加 v-if）
const completeReady = ref(false)

// 压缩图片：最长边 ≤1280px、JPEG 质量 0.72，控制 base64 体积，避免多图提交超过后端 body 限制
async function compressImage(file: Blob): Promise<string> {
  const readAsDataURL = (blob: Blob) => new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = (e: any) => resolve(e.target?.result || '')
    reader.onerror = () => resolve('')
    reader.readAsDataURL(blob)
  })
  try {
    const dataUrl = await readAsDataURL(file)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('img load fail'))
      im.src = dataUrl
    })
    const maxSide = 1280
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
    // 尺寸与体积都无需处理时保留原图
    if (scale >= 1 && dataUrl.length <= 900 * 1024) return dataUrl
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.fillStyle = '#fff' // PNG 透明区域转 JPEG 时铺白底，避免变黑
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.72)
  } catch (_) {
    // 压缩失败兜底：返回原图 base64
    return await readAsDataURL(file)
  }
}

function readFilesAsBase64(files: UploadFile[]): Promise<string[]> {
  const jobs = files.filter(f => f.raw).map(f => compressImage(f.raw as Blob))
  return Promise.all(jobs).then(arr => arr.filter(Boolean))
}
async function syncCompleteImages(fileList: UploadFiles) {
  completeForm.images = await readFilesAsBase64(fileList)
}
function onCompleteExceed() {
  ElMessage.warning('运输照片最多上传 3 张')
}

async function openComplete(row: any) {
  if (!row.departure_time) {
    return ElMessage.warning('该任务尚未发车，请先点击状态列确认发车')
  }
  completeTaskInfo.value = row
  completeForm.trip_mileage = 0
  completeForm.images = []
  // 关键：先清空受控数组，再清空 upload 组件内部状态，杜绝上个任务照片残留
  completeFileList.value = []
  completeReady.value = false   // 性能：重置懒渲染标记，骨架屏先行
  completeVisible.value = true
  await nextTick()
  completeUploadRef.value?.clearFiles?.()
}
// 弹窗关闭后再兜底清一次（destroy-on-close 也会重建组件）
function onCompleteDialogClosed() {
  completeForm.images = []
  completeFileList.value = []
  completeReady.value = false
  completeUploadRef.value?.clearFiles?.()
}
async function submitComplete() {
  if (!completeTaskInfo.value || completing.value) return
  if (!completeForm.trip_mileage || Number(completeForm.trip_mileage) <= 0) {
    return ElMessage.warning('请填写有效的 TRIP 小计里程')
  }
  completing.value = true
  try {
    await completeTask(completeTaskInfo.value.id, {
      trip_mileage: Number(completeForm.trip_mileage),
      attachments: completeForm.images.slice(0, 3),
      // 向后兼容旧后端字段
      attachment: completeForm.images[0] || null,
    })
    ElMessage.success('已完成，状态已更新')
    completeVisible.value = false
    // 立即从本地列表移除已完成任务，避免短暂停留（fetch 在后台同步）
    const doneId = completeTaskInfo.value.id
    tableData.value = tableData.value.filter(t => t.id !== doneId)
    fetch()
  } catch (_) { } finally {
    completing.value = false
  }
}

// ========= 取消 =========
function doCancel(row: any) {
  ElMessageBox.prompt(`请输入取消任务 ${row.id} 的原因`, '取消任务', {
    confirmButtonText: '确定取消', cancelButtonText: '返回', type: 'warning',
    inputPattern: /\S{2,}/, inputErrorMessage: '原因至少两个字',
  }).then(async ({ value }: any) => {
    await cancelTask(row.id, value)
    ElMessage.success('已取消任务')
    fetch()
  }).catch(() => { })
}

// ========= 上报异常（进行中 → 异常：原因标签 + 说明 + 最多 3 张现场图片） =========
const EXCEPTION_REASONS = ['交通事故', '车辆故障', '货物异常', '客户改约', '其他']
const exceptionVisible = ref(false)
const exceptionTaskInfo = ref<any>(null)
const exceptionForm = reactive<{ reason: string; remark: string; images: string[] }>({ reason: '', remark: '', images: [] })
const exceptionFileList = ref<UploadFile[]>([])
const exceptionUploadRef = ref<any>(null)
const exceptionSubmitting = ref(false)
// 性能：同 complete 弹窗，opened 动画结束后再渲染表单内容
const exceptionReady = ref(false)

// 仅发车后、尚未结束、未上报过异常的任务可点（进行中 / 已超时）
function canReportException(row: any) {
  const s = displayStatus(row)
  return row.departure_time && ['进行中', '已超时', '已延误'].includes(s) && row.status !== '异常' && !row.complete_time
}

async function openException(row: any) {
  exceptionTaskInfo.value = row
  exceptionForm.reason = ''
  exceptionForm.remark = ''
  exceptionForm.images = []
  exceptionFileList.value = []
  exceptionReady.value = false  // 性能：重置懒渲染标记，骨架屏先行
  exceptionVisible.value = true
  await nextTick()
  exceptionUploadRef.value?.clearFiles?.()
}
async function syncExceptionImages(fileList: UploadFiles) {
  exceptionForm.images = await readFilesAsBase64(fileList)
}
function onExceptionExceed() {
  ElMessage.warning('现场照片最多上传 3 张')
}
function onExceptionDialogClosed() {
  exceptionForm.reason = ''
  exceptionForm.remark = ''
  exceptionForm.images = []
  exceptionFileList.value = []
  exceptionReady.value = false
  exceptionUploadRef.value?.clearFiles?.()
}
async function submitException() {
  if (!exceptionTaskInfo.value || exceptionSubmitting.value) return
  if (!exceptionForm.reason) return ElMessage.warning('请选择异常原因')
  exceptionSubmitting.value = true
  try {
    const fullReason = exceptionForm.remark.trim()
      ? `${exceptionForm.reason}：${exceptionForm.remark.trim()}`
      : exceptionForm.reason
    await reportTaskException(exceptionTaskInfo.value.id, {
      reason: fullReason,
      images: exceptionForm.images.slice(0, 3),
    })
    ElMessage.success('异常已上报，任务状态变为「异常」')
    exceptionVisible.value = false
    fetch()
  } catch (_) { } finally {
    exceptionSubmitting.value = false
  }
}

// ========= 详细弹窗 =========
const detailVisible = ref(false)
const detail: any = ref({ task: null, logs: [] })
// 性能：详情内容（descriptions + 大 base64 照片）异步就绪后才渲染，
// 打开瞬间只渲染骨架屏 —— 动画帧与数据加载/组件渲染彻底分离（el-dialog 本身不加 v-if）
const detailLoading = ref(false)
// 缩略图缓存：列表展示用小图避免主线程解码大 base64 图，点击预览仍用原图
const detailExThumbs = ref<string[]>([])
const detailAtThumbs = ref<string[]>([])

async function openDetail(row: any) {
  // 先开窗展示骨架屏，数据在后台获取：点击响应不被网络阻塞，动画不被渲染阻塞
  detailVisible.value = true
  detailLoading.value = true
  detail.value = { task: null, logs: [] }
  // 性能修复：必须等一帧让骨架屏真正挂载到 DOM，否则接口返回快时
  // detailLoading=true/false 会被 Vue 批量合并，骨架屏从未渲染，用户看到空白弹窗等待
  await nextTick()
  try {
    const r = await getTaskDetail(row.id)
    const task = r.task || {}
    // 性能：照片缩略图用 createImageBitmap 后台线程解码生成（见 utils/imageThumb.ts），
    // 消除打开详情时主线程同步解码 ~1MB base64 图的长任务
    const exUrls: string[] = task.exception_images || []
    const atUrls: string[] = task.attachments || []
    const [exThumbs, atThumbs] = await Promise.all([
      makeThumbnails(exUrls), makeThumbnails(atUrls),
    ])
    detailExThumbs.value = exThumbs
    detailAtThumbs.value = atThumbs
    detail.value = r
  } finally {
    detailLoading.value = false
  }
}

// ========= 修改弹窗 =========
const editVisible = ref(false)
const editTask: any = ref(null)
// 性能：表单含 el-date-picker/el-select/el-input-number 等重组件，动画期间先出骨架屏
const editReady = ref(false)
const editForm = reactive({
  origin: '', destination: '', cargo: '', weight: 1, sla_hours: 8,
  recommended_vehicle_type: '',
  remarks: '', extra_remarks: '', is_urgent: false, latest_departure_time: '', freight: 0,
})
const cargoOptions = ['普通货物', '电子产品', '服装', '生鲜', '家具', '药品', '食品', '冷链物资', '建材', '其他']
const vehicleOptions = ['厢式货车', '平板车', '冷链车', '半挂']

async function openEdit(row: any) {
  editTask.value = { ...row }
  Object.assign(editForm, {
    origin: row.origin, destination: row.destination,
    cargo: row.cargo, weight: Number(row.weight) || 0,
    sla_hours: Number(row.sla_hours) || 8,
    recommended_vehicle_type: row.recommended_vehicle_type || '厢式货车',
    remarks: row.remarks || '',
    extra_remarks: row.extra_remarks || '',
    is_urgent: Boolean(row.is_urgent),
    latest_departure_time: row.latest_departure_time || '',
    freight: Number(row.freight) || 0,
  })
  editReady.value = false   // 性能：重置懒渲染标记
  editVisible.value = true
  await nextTick()          // 性能：等一帧让骨架屏挂载，再触发 opened 渲染表单
}
async function saveEdit() {
  if (!editTask.value) return
  // 最迟发车时间若被修改，必须晚于当前时间
  const origLd = editTask.value.latest_departure_time || ''
  if (editForm.latest_departure_time && editForm.latest_departure_time !== origLd) {
    const ms = new Date(String(editForm.latest_departure_time).replace(' ', 'T')).getTime()
    if (Number.isNaN(ms) || ms <= Date.now()) {
      return ElMessage.error('最迟发车时间不能早于或等于当前时间，请选择未来的时间')
    }
  }
  const payload: any = { ...editForm }
  await updateTask(editTask.value.id, payload)
  ElMessage.success('修改成功，操作日志已记录')
  editVisible.value = false
  fetch()
}

// ========= 派发弹窗 =========
const dispatchVisible = ref(false)
const dispatchTaskInfo = ref<any>(null)
const dispatchDrivers = ref<any[]>([])
const dispatchLoading = ref(false)
const dispatchSearch = reactive({ vehicle_type: '', city: '' })

// 主要城市经纬度（用于"司机所在地 → 任务目的地"直线距离推荐）
const CITY_COORDS: Record<string, [number, number]> = {
  北京: [116.40, 39.90], 上海: [121.47, 31.23], 广州: [113.26, 23.13], 深圳: [114.06, 22.55],
  成都: [104.07, 30.67], 重庆: [106.55, 29.56], 长沙: [112.94, 28.23], 济南: [117.00, 36.65],
  天津: [117.20, 39.08], 杭州: [120.15, 30.28], 武汉: [114.30, 30.59], 西安: [108.94, 34.34],
  南京: [118.80, 32.06], 郑州: [113.62, 34.75], 青岛: [120.38, 36.07], 苏州: [120.58, 31.30],
  合肥: [117.23, 31.82], 福州: [119.30, 26.08], 厦门: [118.09, 24.48], 昆明: [102.83, 24.88],
  贵阳: [106.71, 26.57], 南宁: [108.37, 22.82], 海口: [110.33, 20.03], 沈阳: [123.43, 41.80],
  大连: [121.62, 38.92], 哈尔滨: [126.64, 45.76], 长春: [125.32, 43.82], 石家庄: [114.51, 38.04],
  太原: [112.55, 37.87], 南昌: [115.86, 28.68], 兰州: [103.83, 36.06], 乌鲁木齐: [87.62, 43.83],
  拉萨: [91.13, 29.65], 呼和浩特: [111.75, 40.84], 银川: [106.23, 38.49], 西宁: [101.78, 36.62],
}
// 从"广州仓/深圳站/上海集散中心"这类字符串里提取城市名
function extractCity(text: string | undefined | null): string {
  const s = String(text || '').trim()
  for (const name of Object.keys(CITY_COORDS)) {
    if (s.includes(name)) return name
  }
  return s.replace(/(仓|站|集散中心|分公司|港区|机场|火车站|南站|北站|东站|西站)$/g, '').trim()
}
// 两城市直线距离（km）；查不到坐标时返回 null
function cityDistanceKm(a: string, b: string): number | null {
  const ca = CITY_COORDS[a]; const cb = CITY_COORDS[b]
  if (!ca || !cb) return null
  if (a === b) return 0
  const rad = (x: number) => (x * Math.PI) / 180
  const R = 6371
  const dLat = rad(cb[1] - ca[1]); const dLon = rad(cb[0] - ca[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(ca[1])) * Math.cos(rad(cb[1])) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

async function fetchAllDrivers() {
  dispatchLoading.value = true
  try {
    const r = await getDrivers({ page: 1, pageSize: 100 })
    // 展示全部审核通过的司机（含任务中/请假/休假），非"空闲"一律置灰不可派发
    dispatchDrivers.value = (r.list || []).filter((d: any) => d.audit_status === 'approved')
  } catch (_) {
    dispatchDrivers.value = []
  } finally { dispatchLoading.value = false }
}

const sortedDispatchDrivers = computed(() => {
  const task = dispatchTaskInfo.value
  if (!task) return dispatchDrivers.value
  const recType = task.recommended_vehicle_type || '厢式货车'
  const destCity = extractCity(task.destination)
  // 先算距离
  const withDist = dispatchDrivers.value.map((d: any) => {
    const driverCity = extractCity(d.city)
    const dist = cityDistanceKm(driverCity, destCity)
    return { ...d, _dist: dist, _distText: dist === null ? '' : (dist === 0 ? '目的地同城' : `距目的地约 ${dist} km`) }
  })
  const free = withDist.filter((d: any) => d.status === '空闲')
  const busy = withDist.filter((d: any) => d.status !== '空闲')
  // 可派发组：车型匹配优先；同车型按"所在地→目的地"距离由近到远；无距离数据排最后
  const freeMatched = free.filter((d: any) => d.vehicle_type === recType)
  const freeOther = free.filter((d: any) => d.vehicle_type !== recType)
  const byDist = (a: any, b: any) => {
    if (a._dist === null && b._dist === null) return 0
    if (a._dist === null) return 1
    if (b._dist === null) return -1
    return a._dist - b._dist
  }
  freeMatched.sort(byDist)
  freeOther.sort(byDist)
  // 车型匹配且距离最近的空闲司机为系统推荐（置顶 + ⭐）
  const recommendId = freeMatched.length ? freeMatched[0].id : null
  const scored = [...freeMatched, ...freeOther, ...busy].map((d: any) => ({
    ...d, _recommend: d.id === recommendId,
  }))
  return scored
})
const filteredDispatchDrivers = computed(() => {
  const list = sortedDispatchDrivers.value
  return list.filter((d: any) => {
    if (dispatchSearch.vehicle_type && d.vehicle_type !== dispatchSearch.vehicle_type) return false
    if (dispatchSearch.city && !String(d.city || '').includes(dispatchSearch.city)) return false
    return true
  })
})

// 性能：司机卡片列表较重（每张含头像/标签/按钮），等弹窗 opened 动画结束后再渲染，
// 打开瞬间只出骨架屏，避免与动画抢占同一帧
const dispatchReady = ref(false)

async function openDispatch(row: any) {
  dispatchTaskInfo.value = row
  dispatchSearch.vehicle_type = ''
  dispatchSearch.city = ''
  // 性能：先开窗（骨架屏 + 动画），司机列表等 @opened 动画结束后再加载 ——
  // 网络请求 + computed 排序过滤不与弹窗动画同帧，消除长任务
  dispatchVisible.value = true
}
// 性能：弹窗动画结束后才加载司机数据，避免数据响应式更新与动画抢主线程
function onDispatchOpened() {
  dispatchReady.value = true
  void fetchAllDrivers()
}
function onDispatchClosed() {
  dispatchReady.value = false
}
async function confirmDispatchOne(driver: any) {
  if (!dispatchTaskInfo.value) return
  // 只有空闲司机可派发，防止一人多单（后端还有死校验兜底）
  if (driver.status !== '空闲') return ElMessage.warning(`司机当前状态为「${driver.status}」，只有空闲司机才能被派发`)
  try {
    await ElMessageBox.confirm(
      `确认将任务 ${dispatchTaskInfo.value.id} 派发给司机「${driver.name} (${driver.plate})」？`,
      '确认派发', { type: 'warning' }
    )
    await apiDispatchTask(dispatchTaskInfo.value.id, Number(driver.id))
    ElMessage.success(`派发成功：已指派给 ${driver.name}，请提醒发车`)
    dispatchVisible.value = false
    fetch()
  } catch (_) { }
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>任务派发与跟踪</h2>
        <p>点击状态列推进任务生命周期：待派发→选司机、待发车→确认发车。操作列：详细 / 修改 / 确认完成 / 取消。</p>
      </div>
      <div>
        <el-button :icon="RefreshRight" @click="fetch">刷新</el-button>
      </div>
    </div>

    <el-card style="margin-bottom: 16px">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字"><el-input v-model="search.keyword" placeholder="任务编号/起点/终点" :prefix-icon="Search" clearable /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="search.status" placeholder="全部" clearable style="width:150px">
            <el-option v-for="s in statusOptions" :key="s" :value="s" :label="s" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="onSearch">查询</el-button>
          <el-button @click="search.keyword = search.status = ''; onSearch()">重置</el-button>
        </el-form-item>
        <!-- 搜索栏右边：四个状态统计方块 -->
        <el-form-item style="margin-left:auto">
          <div class="status-chips">
            <span class="status-chip chip-pending">待派发 {{ statusStats.pending }}</span>
            <span class="status-chip chip-waiting">待发车 {{ statusStats.waiting }}</span>
            <span class="status-chip chip-running">进行中 {{ statusStats.running }}</span>
            <span class="status-chip chip-overdue">已超时 {{ statusStats.overdue }}</span>
            <span class="status-chip chip-exception">异常 {{ statusStats.exception }}</span>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table :data="tableData" v-loading="loading" stripe :row-class-name="tableRowClass" style="width:100%">
        <el-table-column prop="id" label="任务编号" width="126" />
        <el-table-column label="起 - 终" width="140">
          <template #default="{row}">
            <div style="line-height:1.4;font-size:13px">
              <div><span class="muted-txt">起</span> {{ row.origin }}</div>
              <div><span class="muted-txt">终</span> {{ row.destination }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="cargo" label="货物" width="78" />
        <el-table-column prop="weight" label="吨" width="52" />
        <el-table-column label="司机" width="74">
          <template #default="{row}">
            <el-tag v-if="row.driver_id && row.driver_name" type="primary" effect="plain" size="small">{{ row.driver_name }}</el-tag>
            <span v-else class="muted-txt" style="font-size:12px">未分配</span>
          </template>
        </el-table-column>
        <!-- 最迟发车倒计时：实时计算 + 状态流转显示 -->
        <el-table-column label="最迟发车倒计时" width="140">
          <template #default="{row}">
            <span
              :class="{ 'countdown-overdue': (() => { void nowTick; const s = secondsUntil(row.latest_departure_time); return s !== null && s < 0; })() }"
              style="font-size:12px;font-weight:500"
            >{{ getDepartureDisplay(row) }}</span>
          </template>
        </el-table-column>
        <!-- 任务倒计时：状态流转显示 -->
        <el-table-column label="任务倒计时" width="140">
          <template #default="{row}">
            <span
              :class="{ 'timely-overdue': (() => { void nowTick; const st = displayStatus(row); if (['待派发','待发车','已完成','已取消'].includes(st)) return false; if (!row.dispatch_time) return false; const sec = Math.floor((new Date(String(row.dispatch_time).replace(' ', 'T')).getTime() + Number(row.sla_hours||8)*3600*1000 - Date.now())/1000); return sec < 0 })() }"
              style="font-size:13px;font-weight:600"
            >{{ getTaskCountdownDisplay(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="86">
          <template #default="{row}">
            <el-tag
              v-if="isStatusClickable(row)"
              :type="statusTag(row).type"
              size="small"
              effect="light"
              class="status-clickable"
              @click="handleStatusClick(row)"
            >{{ statusTag(row).text }}</el-tag>
            <el-tag v-else :type="statusTag(row).type" size="small">{{ statusTag(row).text }}</el-tag>
          </template>
        </el-table-column>
        <!-- 操作列：详细/修改/确认完成/上报异常/取消 + 三角警告（固定占位在最末尾，隐藏也占区域） -->
        <el-table-column label="操作" width="400">
          <template #default="{row}">
            <div class="op-row">
              <el-button size="small" type="primary" link :icon="View" @click="openDetail(row)">详细</el-button>
              <el-button size="small" type="primary" link :icon="Edit" @click="openEdit(row)">修改</el-button>
              <el-button
                size="small" type="success" link
                :disabled="!['进行中','已超时','已延误','异常'].includes(row.status) || !row.departure_time || row.complete_time"
                @click="openComplete(row)"
              >确认完成</el-button>
              <el-button
                size="small" type="warning" link :icon="Warning"
                :disabled="!canReportException(row)"
                @click="openException(row)"
              >上报异常</el-button>
              <el-button
                v-if="!['已完成','已取消'].includes(row.status) && !row.complete_time"
                size="small" type="danger" link :icon="CloseBold" @click="doCancel(row)"
              >取消</el-button>
              <!-- 三角警告：始终渲染占位，固定在最末尾，仅警示时可见 -->
              <el-tooltip
                :disabled="!warnInfo(row).active"
                :content="warnInfo(row).content"
                placement="top"
              >
                <span class="soon-warn" :class="{ 'warn-active': warnInfo(row).active }">❗</span>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-if="total" background style="margin-top:16px"
        layout="prev, pager, next, jumper, total"
        :page-sizes="[10]" :pager-count="7"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total" @current-change="fetch" />
    </el-card>

    <!-- 详情弹窗 -->
    <el-dialog v-model="detailVisible" title="任务详细信息" width="760px">
      <!-- 性能：数据与缩略图就绪前只渲染骨架屏，打开动画与重内容渲染分帧进行（弹窗本身常驻，不加 v-if） -->
      <el-skeleton v-if="detailLoading" :rows="8" animated />
      <template v-else-if="detail.task">
        <el-descriptions :column="2" border size="default">
          <el-descriptions-item label="任务编号" :span="2"><b>{{ detail.task.id }}</b></el-descriptions-item>
          <el-descriptions-item label="装货地点">{{ detail.task.origin }}</el-descriptions-item>
          <el-descriptions-item label="卸货地点">{{ detail.task.destination }}</el-descriptions-item>
          <el-descriptions-item label="货物类型">{{ detail.task.cargo }}</el-descriptions-item>
          <el-descriptions-item label="重量">{{ detail.task.weight }} 吨</el-descriptions-item>
          <el-descriptions-item label="完成期限">{{ detail.task.sla_hours }} 小时</el-descriptions-item>
          <el-descriptions-item label="推荐车辆类型">
            <el-tag type="primary" effect="light">{{ detail.task.recommended_vehicle_type || '厢式货车' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTag(detail.task).type">{{ statusTag(detail.task).text }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="指派司机">
            <span v-if="detail.task.driver_id">{{ detail.task.driver_name }} (ID {{ detail.task.driver_id }})</span>
            <span v-else class="muted-txt">未分配</span>
          </el-descriptions-item>
          <el-descriptions-item label="是否加急">
            <el-tag v-if="detail.task.is_urgent" type="danger" effect="light">加急</el-tag>
            <span v-else>普通</span>
          </el-descriptions-item>
          <el-descriptions-item label="运费">¥ {{ detail.task.freight || 0 }} 元</el-descriptions-item>

          <el-descriptions-item label="最迟发车">
            {{ detail.task.latest_departure_time || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="出车时间">
            {{ detail.task.departure_time || '（未发车）' }}
          </el-descriptions-item>

          <el-descriptions-item label="任务发布人">
            {{ detail.task.creator || '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="调度员">
            {{ detail.task.dispatcher_name || '（未派发）' }}
          </el-descriptions-item>
          <el-descriptions-item label="发布时间">
            {{ detail.task.publish_time || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="派发时间">
            {{ detail.task.dispatch_time || '（未派发）' }}
          </el-descriptions-item>
          <el-descriptions-item label="完成时间">
            {{ detail.task.complete_time || '（未完成）' }}
          </el-descriptions-item>
          <el-descriptions-item label="截止时间">
            <b>{{ detail.task.deadline || '—' }}</b>
          </el-descriptions-item>
          <el-descriptions-item label="备注信息" :span="2">
            <el-tag v-if="detail.task.remarks" type="info" effect="plain" style="max-width:100%">{{ detail.task.remarks }}</el-tag>
            <span v-else class="muted-txt">无</span>
          </el-descriptions-item>
          <el-descriptions-item label="附加备注" :span="2">
            <el-tag v-if="detail.task.extra_remarks" type="warning" effect="plain" style="max-width:100%">{{ detail.task.extra_remarks }}</el-tag>
            <span v-else class="muted-txt">无</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.task.cancel_reason" label="取消原因" :span="2">
            <el-tag type="danger" effect="plain">{{ detail.task.cancel_reason }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.task.exception_reason" label="异常原因" :span="2">
            <el-tag type="danger" effect="dark">{{ detail.task.exception_reason }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.task.exception_time" label="异常上报时间">
            {{ detail.task.exception_time }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.task.exception_by_name" label="异常上报人">
            {{ detail.task.exception_by_name }}
          </el-descriptions-item>
          <el-descriptions-item v-if="(detail.task.exception_images || []).length" label="异常现场照片" :span="2">
            <el-image
              v-for="(img, i) in (detail.task.exception_images || [])" :key="'ex'+i"
              :src="detailExThumbs[i] || img" :preview-src-list="detail.task.exception_images"
              :initial-index="i" preview-teleported fit="cover"
              style="width:72px;height:72px;border-radius:6px;margin-right:8px;object-fit:cover"
            />
          </el-descriptions-item>
          <el-descriptions-item v-if="(detail.task.attachments || []).length" label="运输照片" :span="2">
            <el-image
              v-for="(img, i) in (detail.task.attachments || [])" :key="'at'+i"
              :src="detailAtThumbs[i] || img" :preview-src-list="detail.task.attachments"
              :initial-index="i" preview-teleported fit="cover"
              style="width:72px;height:72px;border-radius:6px;margin-right:8px;object-fit:cover"
            />
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </el-dialog>

    <!-- 修改弹窗 -->
    <el-dialog v-model="editVisible" title="修改任务信息" width="700px" @opened="editReady = true" @closed="editReady = false">
      <!-- 性能：动画期间只出骨架屏，el-form（含 date-picker/select/input-number）在 opened 后实例化 -->
      <el-skeleton v-if="!editReady" :rows="6" animated />
      <el-form v-else label-width="120px" :model="editForm">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="装货地点"><el-input v-model="editForm.origin" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="卸货地点"><el-input v-model="editForm.destination" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="货物类型">
              <el-select v-model="editForm.cargo" style="width:100%">
                <el-option v-for="o in cargoOptions" :key="o" :label="o" :value="o" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="推荐车辆类型">
              <el-select v-model="editForm.recommended_vehicle_type" style="width:100%">
                <el-option v-for="v in vehicleOptions" :key="v" :label="v" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="重量(吨)"><el-input-number v-model="editForm.weight" :min="0" :precision="2" style="width:100%" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="完成期限(小时)"><el-input-number v-model="editForm.sla_hours" :min="1" :max="96" style="width:100%" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="最迟发车">
              <el-date-picker v-model="editForm.latest_departure_time" type="datetime" value-format="YYYY-MM-DD HH:mm" style="width:100%" :disabled-date="(d: Date) => d.getTime() < new Date().setHours(0,0,0,0)" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="运费(元)"><el-input-number v-model="editForm.freight" :min="0" style="width:100%" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="是否加急">
              <el-switch v-model="editForm.is_urgent" active-text="加急" inactive-text="普通" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="附加备注">
          <el-input v-model="editForm.extra_remarks" type="textarea" :rows="2" maxlength="200" show-word-limit
            placeholder="调度/管理员追加的附加备注（不覆盖发布时的原始备注）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible=false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存（自动记操作日志）</el-button>
      </template>
    </el-dialog>

    <!-- 派发弹窗 -->
    <el-dialog
      v-model="dispatchVisible" title="派发任务 - 选择司机" width="1000px" top="4vh" :close-on-click-modal="false"
      @opened="onDispatchOpened" @closed="onDispatchClosed"
    >
      <!-- 性能：动画期间只渲染骨架屏，司机卡片列表在 opened 后一帧再挂载 -->
      <el-skeleton v-if="!dispatchReady" :rows="10" animated />
      <div v-else-if="dispatchTaskInfo" class="dispatch-body">
        <div class="dispatch-left">
          <div class="dispatch-left-title">📋 任务信息（固定）</div>
          <div class="task-snippet-card">
            <div class="task-snippet-row"><span class="lab">任务编号</span><b>{{ dispatchTaskInfo.id }}</b></div>
            <div class="task-snippet-row"><span class="lab">起点</span>{{ dispatchTaskInfo.origin }}</div>
            <div class="task-snippet-row"><span class="lab">终点</span>{{ dispatchTaskInfo.destination }}</div>
            <div class="task-snippet-row"><span class="lab">货物类型</span>{{ dispatchTaskInfo.cargo }}</div>
            <div class="task-snippet-row"><span class="lab">重量</span>{{ dispatchTaskInfo.weight }} 吨</div>
            <div class="task-snippet-row"><span class="lab">推荐车辆</span>
              <el-tag type="primary" effect="light">{{ dispatchTaskInfo.recommended_vehicle_type || '厢式货车' }}</el-tag>
            </div>
            <div class="task-snippet-row"><span class="lab">最迟发车</span>{{ dispatchTaskInfo.latest_departure_time || '—' }}</div>
            <div class="task-snippet-row"><span class="lab">运费</span><b style="color:#E6A23C">¥ {{ dispatchTaskInfo.freight || 0 }}</b></div>
          </div>
          <div class="muted-txt" style="margin-top:12px;line-height:1.7">
            提示：只有<span style="color:#67c23a;font-weight:600">空闲</span>司机才能被派发，任务中/请假/休假的司机已置灰，避免一人多单。<br />
            推荐规则：车型匹配优先，同车型按「司机所在地 → 任务目的地」直线距离由近到远排序，置顶带 ⭐ 的为系统推荐的最佳人选。
          </div>
        </div>

        <div class="dispatch-right">
          <el-card shadow="never" style="margin-bottom:10px;padding:0">
            <el-form :inline="true" label-width="72px" style="margin:0">
              <el-form-item label="车型">
                <el-select v-model="dispatchSearch.vehicle_type" placeholder="不限" clearable style="width:160px">
                  <el-option v-for="v in vehicleOptions" :key="v" :label="v" :value="v" />
                </el-select>
              </el-form-item>
              <el-form-item label="所在地">
                <el-input v-model="dispatchSearch.city" placeholder="如：北京 / 上海" clearable style="width:160px" />
              </el-form-item>
              <el-form-item>
                <el-tag type="warning" effect="light" size="small">💡 推荐司机已置顶</el-tag>
              </el-form-item>
            </el-form>
          </el-card>

          <div class="driver-cards-wrap" v-loading="dispatchLoading">
            <el-empty v-if="!dispatchLoading && !filteredDispatchDrivers.length" description="没有符合条件的司机" :image-size="100" />
            <el-row v-else :gutter="10">
              <el-col :span="12" v-for="d in filteredDispatchDrivers" :key="d.id" style="margin-bottom:10px">
                <div class="driver-card" :class="{ recommended: d._recommend, busy: d.status!=='空闲' }">
                  <div class="driver-card-head">
                    <div class="driver-avatar">{{ d.name?.charAt?.(0) || '司' }}</div>
                    <div style="flex:1">
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                        <b>{{ d.name }}</b>
                        <el-tag v-if="d._recommend" type="warning" effect="dark" size="small">⭐ 推荐</el-tag>
                        <el-tag :type="d.status==='空闲'?'success':(d.status==='任务中'?'danger':'info')" effect="plain" size="small">{{ d.status }}</el-tag>
                      </div>
                      <div class="muted-txt" style="font-size:12px;margin-top:2px">
                        {{ d.plate }} · {{ d.vehicle_type }}
                      </div>
                    </div>
                  </div>
                  <div class="driver-card-body">
                    <div><span class="lab">所在城市</span>{{ d.city || '—' }}</div>
                    <div><span class="lab">入职日期</span>{{ d.join_date || '—' }}</div>
                    <div><span class="lab">手机号</span>{{ d.phone || '—' }}</div>
                    <div v-if="d._distText" class="dist-txt">📍 {{ d._distText }}</div>
                  </div>
                  <div class="driver-card-foot">
                    <el-button
                      size="small" type="primary" plain
                      :disabled="d.status!=='空闲'"
                      @click="confirmDispatchOne(d)"
                    >
                      {{ d.status==='空闲' ? '✓ 确定派发给他' : `${d.status}，不可派发` }}
                    </el-button>
                  </div>
                </div>
              </el-col>
            </el-row>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="dispatchVisible=false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 确认完成弹窗 -->
    <el-dialog
      v-model="completeVisible" title="确认完成任务 - 填写运输信息" width="520px"
      :close-on-click-modal="false" destroy-on-close @closed="onCompleteDialogClosed"
      @opened="completeReady = true"
    >
      <!-- 性能：opened 动画结束后再实例化表单 + el-upload，动画帧不被组件创建阻塞 -->
      <el-skeleton v-if="!completeReady" :rows="4" animated />
      <el-form v-else label-width="140px" :model="completeForm">
        <el-form-item label="TRIP 小计里程 (km)">
          <el-input-number v-model="completeForm.trip_mileage" :min="0" :precision="2" :step="0.5" style="width:100%" />
        </el-form-item>
        <el-form-item label="运输照片（最多3张）">
          <el-upload
            ref="completeUploadRef"
            v-model:file-list="completeFileList"
            action="#"
            :auto-upload="false"
            :limit="3"
            multiple
            accept="image/*"
            list-type="picture-card"
            :on-change="(_f: any, fl: UploadFiles) => syncCompleteImages(fl)"
            :on-remove="(_f: any, fl: UploadFiles) => syncCompleteImages(fl)"
            :on-exceed="onCompleteExceed"
          >
            <el-icon><Plus /></el-icon>
          </el-upload>
          <div class="muted-txt" style="font-size:12px;margin-top:4px">
            已上传 {{ completeForm.images.length }} / 3 张运输照片
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="completeVisible=false">取消</el-button>
        <el-button type="primary" :loading="completing" @click="submitComplete">确定提交</el-button>
      </template>
    </el-dialog>

    <!-- 上报异常弹窗 -->
    <el-dialog
      v-model="exceptionVisible" title="上报任务异常" width="560px"
      :close-on-click-modal="false" destroy-on-close @closed="onExceptionDialogClosed"
      @opened="exceptionReady = true"
    >
      <!-- 性能：同完成弹窗，opened 后再挂载表单内容 -->
      <el-skeleton v-if="!exceptionReady" :rows="4" animated />
      <el-form v-else label-width="92px" :model="exceptionForm">
        <el-form-item label="异常原因" required>
          <el-check-tag
            v-for="r in EXCEPTION_REASONS" :key="r"
            :checked="exceptionForm.reason === r"
            class="reason-tag"
            @change="exceptionForm.reason = (exceptionForm.reason === r ? '' : r)"
          >{{ r }}</el-check-tag>
        </el-form-item>
        <el-form-item label="补充说明">
          <el-input
            v-model="exceptionForm.remark" type="textarea" :rows="3"
            maxlength="200" show-word-limit
            placeholder="请补充异常具体情况（选填）"
          />
        </el-form-item>
        <el-form-item label="现场照片（最多3张）">
          <el-upload
            ref="exceptionUploadRef"
            v-model:file-list="exceptionFileList"
            action="#"
            :auto-upload="false"
            :limit="3"
            multiple
            accept="image/*"
            list-type="picture-card"
            :on-change="(_f: any, fl: UploadFiles) => syncExceptionImages(fl)"
            :on-remove="(_f: any, fl: UploadFiles) => syncExceptionImages(fl)"
            :on-exceed="onExceptionExceed"
          >
            <el-icon><Plus /></el-icon>
          </el-upload>
          <div class="muted-txt" style="font-size:12px;margin-top:4px">
            已上传 {{ exceptionForm.images.length }} / 3 张现场照片。提交后任务状态将变为「异常」，仍需点击「确认完成」结束任务。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="exceptionVisible=false">取消</el-button>
        <el-button type="danger" :loading="exceptionSubmitting" @click="submitException">确认上报</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: 16px; display:flex; justify-content:space-between; align-items:flex-end; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.page-header p  { margin: 0; color: var(--color-muted, #909399); font-size: 13px; }

.muted-txt { color: var(--color-muted, #909399); }
/* 操作列：按钮按固定顺序左对齐，位置固定上下整齐；警告图标固定在最末尾 */
.op-row { display:flex; align-items:center; flex-wrap:nowrap; white-space:nowrap; gap: 8px; }
.op-row :deep(.el-button + .el-button) { margin-left: 0; }

.status-clickable { cursor: pointer; user-select: none; transition: transform .12s; }
.status-clickable:hover { transform: scale(1.06); filter: brightness(1.05); }

.countdown-overdue { color: #F56C6C; font-weight: 600; }

.depart-warn {
  display:inline-flex; align-items:center; justify-content:center;
  width: 18px; height: 18px; border-radius: 50%;
  background: #F56C6C; color:#fff; font-size: 11px; line-height: 1;
  margin-left: 2px; cursor: help;
  animation: blink-warn 1.2s infinite;
}
@keyframes blink-warn {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.row-danger :deep(.el-table__cell) { background-color: rgba(245,108,108,0.08) !important; }
.timely-overdue { color: #F56C6C; }

/* 搜索栏右边的状态统计方块 */
.status-chips {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
}
.chip-pending { background: var(--table-stripe, #f4f4f5); color: var(--color-text, #606266); border-color: var(--border-color, #dcdfe6); }
.chip-waiting { background: rgba(230,162,60,.12); color: #e6a23c; border-color: rgba(230,162,60,.35); }
.chip-running { background: rgba(64,158,255,.12); color: #409eff; border-color: rgba(64,158,255,.35); }
.chip-overdue { background: rgba(245,108,108,.12); color: #f56c6c; border-color: rgba(245,108,108,.35); }
.chip-exception { background: rgba(144,47,237,.14); color: #a563e0; border-color: rgba(144,47,237,.4); }

/* 上报异常原因标签 */
.reason-tag {
  height: 28px;
  padding: 0 14px;
  margin: 0 8px 8px 0;
  border-radius: 14px;
  font-size: 13px;
  cursor: pointer;
}

/* 司机卡片：距目的地距离 */
.dist-txt { grid-column: 1 / -1; color: #e6a23c; font-weight: 600; }

/* 三角警告：固定占位在最末尾；隐藏时仅不可见，仍占据区域 */
.op-row .soon-warn {
  margin-left: auto;          /* 固定推到行末尾 */
  flex-shrink: 0;
  visibility: hidden;         /* 隐藏但保留占位 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px; height: 18px;
  border-radius: 50%;
  background: #f56c6c;
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: help;
  animation: blink-warn 1.2s infinite;
}
.op-row .soon-warn.warn-active { visibility: visible; }

.dispatch-body { display:flex; gap: 16px; align-items:flex-start; }
.dispatch-left { width: 280px; flex-shrink:0; }
.dispatch-right { flex:1; min-width:0; }
.dispatch-left-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }

.task-snippet-card {
  background: var(--bg-card, linear-gradient(180deg,#f5f9ff,#fff));
  border: 1px solid var(--border-color, #e0e9ff);
  border-radius: 8px;
  padding: 14px 16px;
  position: sticky;
  top: 0;
}
.task-snippet-row {
  display:flex; justify-content:space-between; align-items:center;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border-color, #eaeff7);
  font-size: 13px;
}
.task-snippet-row:last-child { border-bottom: none; }
.task-snippet-row .lab { color: var(--color-muted, #909399); }

.driver-cards-wrap { max-height: 60vh; overflow-y:auto; padding-right:4px; }
.driver-card {
  border: 1px solid var(--border-color, #ebeef5);
  border-radius: 8px;
  background: var(--bg-card, #fff);
  padding: 10px 12px;
  display:flex; flex-direction:column; gap: 8px;
  transition: .15s;
  min-height: 140px;
}
.driver-card:hover { border-color: var(--border-color, #c0c4cc); box-shadow: 0 3px 10px rgba(0,0,0,.05); }
.driver-card.recommended {
  border-color: #E6A23C;
  background: rgba(230,162,60,.08);
}
.driver-card.busy {
  opacity: .6;
  background: var(--table-stripe, #f4f4f5);
}
.driver-card-head { display:flex; align-items:center; gap: 10px; }
.driver-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  background:#409EFF; color:#fff;
  display:flex; align-items:center; justify-content:center;
  font-weight:600;
}
.driver-card-body {
  display:grid; grid-template-columns: 1fr 1fr; gap: 4px 10px;
  font-size: 12px; color: var(--color-text, #606266);
}
.driver-card-body .lab { color:var(--color-muted, #909399); margin-right:4px; }
.driver-card-foot { margin-top:auto; text-align:right; }
</style>
