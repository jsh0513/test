<script setup lang="ts">
import { reactive, ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { ElMessage, ElForm, ElMessageBox } from 'element-plus'
import {
  createTask, getDraftTasks, publishTask, publishAllDrafts, scheduleTask, updateTask, cancelScheduledTask,
  bulkScheduleTasks, bulkDeleteDrafts, bulkCreateTasks, ocrRecognize,
} from '../api'
import { View } from '@element-plus/icons-vue'

const formRef = ref<InstanceType<typeof ElForm>>()

const form = reactive({
  origin: '',
  destination: '',
  cargo: '普通货物',
  weight: 1,
  sla_hours: 8,
  recommended_vehicle_type: '厢式货车',
  remarks: '',
  is_urgent: false,
  latest_departure_time: '',
  freight: 200,
  scheduled_at: '',
  bulk_count: 1,
})

const cargoOptions = ['普通货物', '电子产品', '服装', '生鲜', '家具', '药品', '食品', '冷链物资', '建材', '其他']
const slaOptions = [
  { label: '4 小时（同城快运）', value: 4 },
  { label: '6 小时（市内配送）', value: 6 },
  { label: '8 小时（省内标准）', value: 8 },
  { label: '12 小时（邻省运输）', value: 12 },
  { label: '24 小时（跨省运输）', value: 24 },
  { label: '48 小时（长途）',   value: 48 },
  { label: '72 小时（超长途，3 天）', value: 72 },
  { label: '96 小时（上限，4 天）',   value: 96 },
]
const vehicleOptions = ['厢式货车', '平板车', '冷链车', '半挂']

const QUICK_REMARKS = ['加急派送', '全程冷链', '防潮包装', '易碎品', '需卸货工人', '签收回单', '优先派车', '周末不配送']

function pickDefaultVehicle(cargo: string) {
  const map: Record<string, string> = {
    '生鲜': '冷链车', '冷链物资': '冷链车', '食品': '冷链车', '药品': '冷链车',
    '家具': '平板车', '建材': '平板车',
  }
  return map[cargo] || '厢式货车'
}
watch(() => form.cargo, (nv) => { form.recommended_vehicle_type = pickDefaultVehicle(nv) })

// 校验：时间必须晚于当前时间（最迟发车 / 定时发布共用同一规则）
function isFutureTime(t: string): boolean {
  if (!t) return false
  const ms = new Date(String(t).replace(' ', 'T')).getTime()
  return !Number.isNaN(ms) && ms > Date.now()
}
function validateFutureTime(rule: any, value: string, cb: (e?: Error) => void) {
  if (!value) return cb() // 必填由 required 规则负责
  if (!isFutureTime(value)) return cb(new Error('时间不能早于当前时间，请重新选择'))
  cb()
}

const rules = {
  origin: [{ required: true, message: '请填写装货地点', trigger: 'blur' }],
  destination: [{ required: true, message: '请填写卸货地点', trigger: 'blur' }],
  cargo: [{ required: true, message: '请选择货物类型', trigger: 'change' }],
  weight: [{ required: true, type: 'number', min: 0.1, message: '请输入正确的重量', trigger: 'blur' }],
  sla_hours: [{ required: true, type: 'number', min: 1, max: 96, message: '完成期限需在 1~96 小时（最高 4 天）', trigger: 'change' }],
  recommended_vehicle_type: [{ required: true, message: '请选择推荐车辆类型', trigger: 'change' }],
  // 最迟发车为必填，且不能早于当前时间
  latest_departure_time: [
    { required: true, message: '请选择最迟发车时间', trigger: 'change' },
    { validator: validateFutureTime, trigger: 'change' },
  ],
  freight: [{ required: true, type: 'number', min: 0, message: '请输入运费', trigger: 'blur' }],
}

const submitting = ref(false)

function resetForm() {
  form.origin = ''; form.destination = ''; form.cargo = '普通货物'; form.weight = 1
  form.sla_hours = 8; form.recommended_vehicle_type = '厢式货车'
  form.remarks = ''; form.is_urgent = false
  form.latest_departure_time = ''; form.freight = 200
  form.scheduled_at = ''; form.bulk_count = 1
  formRef.value?.clearValidate()
}

// 构造任务载荷（单条/批量复用）
function buildPayload() {
  return {
    origin: form.origin, destination: form.destination,
    cargo: form.cargo, weight: form.weight, sla_hours: form.sla_hours,
    recommended_vehicle_type: form.recommended_vehicle_type,
    remarks: form.remarks, is_urgent: form.is_urgent,
    latest_departure_time: form.latest_departure_time || null,
    freight: Number(form.freight) || 0,
    scheduled_at: form.scheduled_at || null,
  }
}

async function submitCreate() {
  if (!formRef.value) return
  try { await formRef.value.validate() } catch (_) { return }
  try {
    submitting.value = true
    const r = await createTask(buildPayload())
    ElMessage.success(`任务创建成功（草稿）：${r.id}`)
    resetForm()
    loadDrafts()
  } finally {
    submitting.value = false
  }
}

// 批量创建任务（存草稿，除编号外内容一致）
async function submitBulkCreate() {
  if (!formRef.value) return
  try { await formRef.value.validate() } catch (_) { return }
  const count = Number(form.bulk_count) || 1
  if (count < 1 || count > 50) return ElMessage.warning('批量创建数量需在 1~50 之间')
  try {
    submitting.value = true
    const r = await bulkCreateTasks({ ...buildPayload(), count })
    ElMessage.success(`已批量创建 ${r.count} 条草稿任务${form.scheduled_at ? '（已设置定时发布）' : ''}`)
    resetForm()
    loadDrafts()
  } finally {
    submitting.value = false
  }
}

// ---------- OCR 图片识别（后端 tesseract.js + parseFields，直接回填表单） ----------
const ocrInput = ref<HTMLInputElement | null>(null)
const ocrDragging = ref(false)
const ocrLoading = ref(false)

function onOcrDrop(e: DragEvent) {
  ocrDragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) doOcr(file)
}
function onOcrFileSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) doOcr(file)
  target.value = ''
}

async function doOcr(file: File) {
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请上传图片文件')
    return
  }
  ocrLoading.value = true
  try {
    const fd = new FormData()
    fd.append('image', file)
    const r = await ocrRecognize(fd)
    const fields = r.fields || {}
    // 识别后直接回填任务基本信息（仅当字段有值时覆盖，空值不覆盖）
    if (fields.origin) form.origin = fields.origin
    if (fields.destination) form.destination = fields.destination
    if (fields.cargo && cargoOptions.includes(fields.cargo)) form.cargo = fields.cargo
    if (fields.weight && !isNaN(Number(fields.weight))) form.weight = Number(fields.weight)
    if (fields.sla_hours && !isNaN(Number(fields.sla_hours))) form.sla_hours = Number(fields.sla_hours)
    if (fields.freight && !isNaN(Number(fields.freight))) form.freight = Number(fields.freight)
    if (fields.remarks) form.remarks = fields.remarks
    if (fields.is_urgent) form.is_urgent = true
    // cargo 的 watcher 会联动车型，nextTick 后再按 OCR 识别结果覆盖一次
    if (fields.recommended_vehicle_type && vehicleOptions.includes(fields.recommended_vehicle_type)) {
      nextTick(() => { form.recommended_vehicle_type = fields.recommended_vehicle_type })
    }
    const filled = [fields.origin, fields.destination, fields.cargo, fields.weight, fields.freight].filter(Boolean).length
    ElMessage.success(filled > 0 ? 'OCR 识别完成，已自动回填表单，请校验后保存' : 'OCR 识别完成，未能解析出字段，请手动填写')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || 'OCR 识别失败，请重试')
  } finally {
    ocrLoading.value = false
  }
}

// ---------- 草稿列表 ----------
const unpublished = ref<any[]>([])
const scheduled = ref<any[]>([])
const totalCount = ref(0)
const loadingDrafts = ref(false)

async function loadDrafts() {
  loadingDrafts.value = true
  try {
    const r = await getDraftTasks()
    unpublished.value = r.unpublished || []
    scheduled.value = r.scheduled || []
    totalCount.value = r.total || 0
  } finally { loadingDrafts.value = false }
}
onMounted(loadDrafts)

// ---------- 定时轮询：草稿/定时发布列表每 5 秒自动刷新，无需手动刷新 ----------
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(() => { loadDrafts() }, 5000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function doPublish(row: any) {
  try {
    await ElMessageBox.confirm(`确认将草稿任务 ${row.id} 发布到派发中心？发布后调度员即可看到并派发。`, '确认发布', { type: 'success' })
    await publishTask(row.id)
    ElMessage.success('已发布，通知已推送给所有调度员')
    loadDrafts()
  } catch (_) {}
}

async function doPublishAll() {
  if (!unpublished.value.length) return ElMessage.warning('当前没有可发布的草稿任务')
  try {
    await ElMessageBox.confirm(`将当前 ${unpublished.value.length} 条草稿任务全部发布到派发中心？`, '一键发布确认', { type: 'warning' })
    const r = await publishAllDrafts()
    ElMessage.success(`已批量发布 ${r.count} 条任务`)
    loadDrafts()
  } catch (_) {}
}

// ---------- 草稿多选勾选 ----------
const selectedDraftIds = ref<Set<string>>(new Set())
function toggleSelectDraft(id: string) {
  if (selectedDraftIds.value.has(id)) selectedDraftIds.value.delete(id)
  else selectedDraftIds.value.add(id)
  selectedDraftIds.value = new Set(selectedDraftIds.value)
}
function toggleSelectAll() {
  if (selectedDraftIds.value.size === unpublished.value.length) {
    selectedDraftIds.value = new Set()
  } else {
    selectedDraftIds.value = new Set(unpublished.value.map(d => d.id))
  }
}
const allDraftsSelected = computed(() =>
  unpublished.value.length > 0 && selectedDraftIds.value.size === unpublished.value.length
)

// ---------- 批量发布已选 ----------
async function doPublishSelected() {
  if (!selectedDraftIds.value.size) return ElMessage.warning('请先勾选要发布的草稿任务')
  try {
    await ElMessageBox.confirm(
      `将勾选的 ${selectedDraftIds.value.size} 条草稿任务发布到派发中心？`,
      '批量发布确认', { type: 'warning' }
    )
    let ok = 0, fail = 0
    for (const id of selectedDraftIds.value) {
      try { await publishTask(id); ok++ } catch (_) { fail++ }
    }
    ElMessage.success(`成功发布 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`)
    selectedDraftIds.value = new Set()
    loadDrafts()
  } catch (_) {}
}

// ---------- 定时发布设置弹窗 ----------
const scheduleVisible = ref(false)
const scheduleRow = ref<any>(null)
const scheduleTime = ref('')
function openSchedule(row: any) {
  scheduleRow.value = row
  const d = new Date(Date.now() + 2 * 3600 * 1000)
  scheduleTime.value = d.toISOString().slice(0, 16).replace('T', ' ')
  scheduleVisible.value = true
}
// 校验：定时发布时间必须晚于当前时间（复用上方 isFutureTime）
async function submitSchedule() {
  if (!scheduleRow.value || !scheduleTime.value) return ElMessage.warning('请选择定时发布时间')
  if (!isFutureTime(scheduleTime.value)) {
    return ElMessage.error('定时发布时间不能早于或等于当前时间，请选择未来的时间')
  }
  try {
    await scheduleTask(scheduleRow.value.id, scheduleTime.value)
    ElMessage.success('定时发布已设置（该任务进入右侧定时发布列表）')
    scheduleVisible.value = false
    loadDrafts()
  } catch (_) {}
}

// ---------- 批量定时发布弹窗 ----------
const bulkScheduleVisible = ref(false)
const bulkScheduleTime = ref('')
function openBulkSchedule() {
  if (!selectedDraftIds.value.size) return ElMessage.warning('请先勾选要定时发布的草稿任务')
  const d = new Date(Date.now() + 2 * 3600 * 1000)
  bulkScheduleTime.value = d.toISOString().slice(0, 16).replace('T', ' ')
  bulkScheduleVisible.value = true
}
async function submitBulkSchedule() {
  if (!bulkScheduleTime.value) return ElMessage.warning('请选择统一的定时发布时间')
  if (!isFutureTime(bulkScheduleTime.value)) {
    return ElMessage.error('定时发布时间不能早于或等于当前时间，请选择未来的时间')
  }
  try {
    const ids = Array.from(selectedDraftIds.value)
    const r = await bulkScheduleTasks(ids, bulkScheduleTime.value)
    ElMessage.success(`已成功为 ${r.count} 条任务设置统一的定时发布时间`)
    bulkScheduleVisible.value = false
    selectedDraftIds.value = new Set()
    loadDrafts()
  } catch (_) {}
}

// ---------- 批量删除草稿 ----------
async function doBulkDelete() {
  if (!selectedDraftIds.value.size) return ElMessage.warning('请先勾选要删除的草稿任务')
  try {
    await ElMessageBox.confirm(
      `确认删除勾选的 ${selectedDraftIds.value.size} 条草稿任务？删除后不可恢复。`,
      '批量删除确认', { type: 'warning' }
    )
    const ids = Array.from(selectedDraftIds.value)
    const r = await bulkDeleteDrafts(ids)
    ElMessage.success(`已删除 ${r.count} 条草稿任务`)
    selectedDraftIds.value = new Set()
    loadDrafts()
  } catch (_) {}
}

// ---------- 取消定时发布 ----------
async function doCancelScheduled(row: any) {
  try {
    await ElMessageBox.confirm(
      `确认取消任务 ${row.id} 的定时发布？取消后该任务将回到草稿列表，待手动发布。`,
      '取消定时发布确认',
      { type: 'warning' }
    )
    await cancelScheduledTask(row.id)
    ElMessage.success('已取消定时发布，任务已返回草稿列表')
    loadDrafts()
  } catch (_) {}
}

// ---------- 定时发布分页（1页3条） ----------
const scheduledPage = ref(1)
const scheduledPageSize = 3
const scheduledTotalPages = computed(() => Math.max(1, Math.ceil(scheduled.value.length / scheduledPageSize)))
const scheduledPaged = computed(() => {
  const start = (scheduledPage.value - 1) * scheduledPageSize
  return scheduled.value.slice(start, start + scheduledPageSize)
})
watch(scheduledTotalPages, (np) => {
  if (scheduledPage.value > np) scheduledPage.value = np
})

// ---------- 下一个定时任务倒计时 ----------
const countdownTick = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  countdownTimer = setInterval(() => { countdownTick.value++ }, 1000)
})
onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})

function formatCountdown(ms: number): string {
  if (ms <= 0) return '即将发布'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}时`)
  if (mins > 0 || parts.length === 0) parts.push(`${mins}分`)
  return parts.join('')
}

const nextScheduledCountdown = computed(() => {
  void countdownTick.value
  if (!scheduled.value.length) return '—'
  let minTs = Infinity
  for (const d of scheduled.value) {
    if (!d.scheduled_at) continue
    const ts = new Date(String(d.scheduled_at).replace(' ', 'T')).getTime()
    if (!isNaN(ts) && ts < minTs) minTs = ts
  }
  if (minTs === Infinity) return '—'
  const diff = minTs - Date.now()
  return formatCountdown(diff)
})

// ---------- 查看/修改弹窗 ----------
const editVisible = ref(false)
const editRow = ref<any>(null)
const editForm = reactive({
  origin: '', destination: '', cargo: '', weight: 1, sla_hours: 8,
  recommended_vehicle_type: '厢式货车', remarks: '', is_urgent: false,
  latest_departure_time: '', freight: 0,
})
const editScheduledAt = ref('')
const editOrigScheduledAt = ref('')
const isScheduledTask = computed(() =>
  Boolean(editRow.value?.scheduled_at)
)

function openEdit(row: any) {
  editRow.value = row
  Object.assign(editForm, {
    origin: row.origin, destination: row.destination, cargo: row.cargo,
    weight: Number(row.weight), sla_hours: Number(row.sla_hours),
    recommended_vehicle_type: row.recommended_vehicle_type || '厢式货车',
    remarks: row.remarks || '', is_urgent: Boolean(row.is_urgent),
    latest_departure_time: row.latest_departure_time || '',
    freight: Number(row.freight) || 0,
  })
  const sa = row.scheduled_at ? String(row.scheduled_at) : ''
  editScheduledAt.value = sa
  editOrigScheduledAt.value = sa
  editVisible.value = true
}

async function saveEdit() {
  if (!editRow.value) return
  const orig = editRow.value
  // 最迟发车时间：若被修改，必须晚于当前时间
  if (editForm.latest_departure_time && editForm.latest_departure_time !== (orig.latest_departure_time || '')) {
    if (!isFutureTime(editForm.latest_departure_time)) {
      return ElMessage.error('最迟发车时间不能早于或等于当前时间，请选择未来的时间')
    }
  }
  // 定时发布时间：若被修改（含从无到有、从有到无、改时间），新值必须晚于当前时间
  if (editScheduledAt.value !== editOrigScheduledAt.value) {
    if (editScheduledAt.value && !isFutureTime(editScheduledAt.value)) {
      return ElMessage.error('定时发布时间不能早于或等于当前时间，请选择未来的时间')
    }
  }
  await updateTask(editRow.value.id, { ...editForm })
  if (editScheduledAt.value !== editOrigScheduledAt.value) {
    if (!editScheduledAt.value) {
      await cancelScheduledTask(editRow.value.id)
    } else {
      await scheduleTask(editRow.value.id, editScheduledAt.value)
    }
  }
  ElMessage.success('已保存修改')
  editVisible.value = false
  loadDrafts()
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>创建任务 <el-tag type="danger" size="small" effect="light" style="margin-left:8px">超级管理员专属</el-tag></h2>
        <p class="muted">创建新的运输任务（草稿）。新建任务先不发布，可立即发布进入派发中心或设置定时发布（右上区域按时间自动排队），加急任务自动置顶优先派发。</p>
      </div>
    </div>

    <!-- 左：任务基本信息 / 右：定时发布（固定等高） -->
    <el-row :gutter="16">
      <el-col :span="16">
        <el-card shadow="hover" class="same-h-card">
          <template #header><div class="card-title">任务基本信息</div></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="装货地点" prop="origin">
                  <el-input v-model="form.origin" placeholder="如：北京仓、上海集散中心" clearable maxlength="40" show-word-limit />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="卸货地点" prop="destination">
                  <el-input v-model="form.destination" placeholder="如：杭州站、深圳分公司" clearable maxlength="40" show-word-limit />
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="货物类型" prop="cargo">
                  <el-select v-model="form.cargo" placeholder="请选择货物类型" style="width:100%">
                    <el-option v-for="o in cargoOptions" :key="o" :label="o" :value="o" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="货物重量(吨)" prop="weight">
                  <el-input-number v-model="form.weight" :min="0.1" :max="100" :step="0.5" style="width:100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="完成期限" prop="sla_hours">
                  <el-select v-model="form.sla_hours" placeholder="最高 4 天 = 96 小时" style="width:100%">
                    <el-option v-for="o in slaOptions" :key="o.value" :label="o.label" :value="o.value" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="推荐车辆类型" prop="recommended_vehicle_type">
                  <el-select v-model="form.recommended_vehicle_type" style="width:100%">
                    <el-option v-for="v in vehicleOptions" :key="v" :label="v" :value="v" />
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="最迟发车" prop="latest_departure_time">
                  <el-date-picker v-model="form.latest_departure_time"
                    type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="选择最迟发车时间" style="width:100%"
                    :disabled-date="(d: Date) => d.getTime() < Date.now() - 8.64e7" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="定时设置" prop="scheduled_at">
                  <el-date-picker v-model="form.scheduled_at"
                    type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="设置定时发布时间（可选）" style="width:100%"
                    :disabled-date="(d: Date) => d.getTime() < new Date().setHours(0,0,0,0)" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="是否加急">
                  <el-radio-group v-model="form.is_urgent">
                    <el-radio-button :value="false">普通运输</el-radio-button>
                    <el-radio-button :value="true">加急运输（<span style="color:#F56C6C">优先派发</span>）</el-radio-button>
                  </el-radio-group>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="运费(元)" prop="freight">
                  <el-input-number v-model="form.freight" :min="0" :step="10" style="width:100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="备注信息" prop="remarks">
              <el-input v-model="form.remarks" type="textarea" resize="none" :rows="2" maxlength="200" show-word-limit placeholder="如有特殊要求请在此填写" />
            </el-form-item>
            <el-form-item label="快捷词">
              <div class="quick-tags">
                <el-tag v-for="q in QUICK_REMARKS" :key="q" effect="plain" class="quick-tag"
                  @click="form.remarks = form.remarks ? (form.remarks.includes(q)?form.remarks : form.remarks+' / '+q) : q">
                  + {{ q }}
                </el-tag>
              </div>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" size="large" :loading="submitting" @click="submitCreate">➕ 创建任务（存草稿）</el-button>
              <el-button type="success" size="large" :loading="submitting" @click="submitBulkCreate">📋 批量创建任务（存草稿）</el-button>
              <el-input-number v-model="form.bulk_count" :min="1" :max="50" :step="1" style="width:140px;margin-left:8px" :controls-position="'right'" />
              <span style="margin-left:6px;color:var(--color-muted,#909399);font-size:12px"></span>
            </el-form-item>
          </el-form>

          <!-- OCR 拖拽上传识别区：上传后后端识别并回填表单，无确认弹窗 -->
          <div class="ocr-section">
            <div
              class="ocr-dropzone"
              :class="{ 'is-dragover': ocrDragging, 'is-loading': ocrLoading }"
              @click="ocrLoading ? null : ocrInput?.click()"
              @dragover.prevent="ocrDragging = true"
              @dragleave.prevent="ocrDragging = false"
              @drop.prevent="onOcrDrop"
            >
              <div class="ocr-dropzone-inner">
                <div class="ocr-plus">+</div>
                <div class="ocr-tip">{{ ocrLoading ? '正在识别...' : '拖拽图片到此处，或点击选择图片' }}</div>
                <div class="ocr-hint">支持运单/调度单截图，识别后自动回填起点、终点、货物、重量等字段</div>
              </div>
              <input ref="ocrInput" type="file" accept="image/*" style="display:none" @change="onOcrFileSelect" />
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 定时发布：固定高度与左侧一致，内部三等分，无滚动条 -->
      <el-col :span="8">
        <el-card shadow="hover" class="same-h-card scheduled-fixed-card">
          <template #header>
            <div class="flex-between">
              <div>
                <div class="card-title">定时发布</div>
                <div class="countdown-subtitle">
                  离最近的定时任务发布还有：<b>{{ nextScheduledCountdown }}</b>
                </div>
              </div>
              <el-tag size="small" type="warning" effect="plain">🕒 {{ scheduled.length }}</el-tag>
            </div>
          </template>

          <!-- 始终渲染 3 个固定区域：有任务显示卡片，无任务显示占位框，位置不随任务数移动 -->
          <div class="scheduled-body">
            <div
              v-for="(slotIdx, idx) in 3"
              :key="slotIdx"
              class="scheduled-slot"
            >
              <div v-if="scheduledPaged[idx]" class="draft-card scheduled-card-item" :class="{ 'urgent-card': scheduledPaged[idx].is_urgent }">
                  <!-- 加急盖章（和草稿统一：不规则边缘虚化） -->
                  <div v-if="scheduledPaged[idx].is_urgent" class="urgent-stamp">
                    <svg viewBox="0 0 140 60" xmlns="http://www.w3.org/2000/svg">
                      <defs>
                        <filter id="stamp-blur-s" x="-10%" y="-10%" width="120%" height="120%">
                          <feGaussianBlur stdDeviation="1.4" />
                        </filter>
                        <filter id="stamp-noise-s" x="0" y="0" width="100%" height="100%">
                          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="noise" />
                          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5" />
                        </filter>
                      </defs>
                      <g filter="url(#stamp-noise-s)">
                        <g filter="url(#stamp-blur-s)">
                          <rect x="3" y="3" width="134" height="54" rx="6" ry="6"
                            fill="none" stroke="#ef4444" stroke-width="2.8" />
                          <rect x="10" y="10" width="120" height="40" rx="3" ry="3"
                            fill="none" stroke="#ef4444" stroke-width="1.2" />
                        </g>
                        <text x="70" y="40" text-anchor="middle"
                          fill="#ef4444" font-size="24" font-family="'STKaiti','KaiTi','SimSun',serif"
                          font-weight="bold" letter-spacing="4" font-style="italic">加急</text>
                      </g>
                    </svg>
                  </div>
                  <div class="draft-head">
                    <div class="draft-id"><b>{{ scheduledPaged[idx].id }}</b></div>
                    <el-tag type="warning" effect="light" size="small">🕒 {{ scheduledPaged[idx].scheduled_at }}</el-tag>
                  </div>
                  <div class="draft-route">
                    <span class="loc-tag">装</span>{{ scheduledPaged[idx].origin }}
                    <span class="arrow">➜</span>
                    <span class="loc-tag">卸</span>{{ scheduledPaged[idx].destination }}
                  </div>
                  <div class="draft-info">
                    <span>{{ scheduledPaged[idx].cargo }} · {{ scheduledPaged[idx].weight }} 吨</span>
                    <span>SLA {{ scheduledPaged[idx].sla_hours }}h</span>
                    <el-tag type="primary" effect="light" size="small">{{ scheduledPaged[idx].recommended_vehicle_type }}</el-tag>
                    <span class="freight">¥{{ scheduledPaged[idx].freight }}</span>
                  </div>
                  <div class="draft-remarks muted-txt">备注: {{ scheduledPaged[idx].remarks || '无备注' }}</div>
                  <div class="draft-actions">
                    <el-button size="small" type="success" plain @click="doPublish(scheduledPaged[idx])">📤 立即发布</el-button>
                    <el-button size="small" type="primary" plain :icon="View" @click="openEdit(scheduledPaged[idx])">查看/修改</el-button>
                    <el-button size="small" type="danger" plain @click="doCancelScheduled(scheduledPaged[idx])">✕ 取消定时发布</el-button>
                  </div>
                </div>
                <!-- 空位占位：高度与任务卡一致，保证三个区域固定不移动 -->
                <div v-else class="scheduled-empty-slot">
                  <span>空位 · 等待定时任务</span>
                </div>
              </div>

              <!-- 分页器：始终显示（占位），使用省略号模式 [1 ... 附近页 ... 末页] -->
              <div class="scheduled-pagination">
                <el-pagination
                  v-model:current-page="scheduledPage"
                  :page-size="scheduledPageSize"
                  :total="scheduled.length"
                  :pager-count="5"
                  layout="prev, pager, next"
                  background
                  small
                />
              </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <div class="module-hint">
      💡 流程说明：左侧管理员创建运输任务草稿，可在下方「待发布草稿（加急自动置顶）」中点「发布」立即进入派发中心，或点「定时发布」将任务推到右上区域排队，到点由系统自动派发。加急任务自动置顶优先派发。
    </div>

    <!-- 已创建任务（草稿） -->
    <el-card shadow="hover" style="margin-top:16px" v-loading="loadingDrafts">
      <template #header>
        <div class="flex-between">
          <div class="card-title">已创建任务（草稿）共 {{ totalCount }} 条 </div>
          <div v-if="unpublished.length > 0" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <el-button
              type="primary" size="default" plain
              :disabled="!selectedDraftIds.size"
              @click="doPublishSelected"
            >📋 发布任务（已选 {{ selectedDraftIds.size }} 条）</el-button>
            <el-button
              type="warning" size="default" plain
              :disabled="!selectedDraftIds.size"
              @click="openBulkSchedule"
            >⏰ 批量定时发布（已选 {{ selectedDraftIds.size }} 条）</el-button>
            <el-button
              type="danger" size="default" plain
              :disabled="!selectedDraftIds.size"
              @click="doBulkDelete"
            >🗑 批量删除（已选 {{ selectedDraftIds.size }} 条）</el-button>
            <el-button
              type="success" size="default"
              @click="doPublishAll"
            >🚀 一键发布全部草稿（{{ unpublished.length }} 条）</el-button>
          </div>
        </div>
      </template>

      <div v-if="unpublished.length > 0">
        <div class="col-title">
          <span class="dot"></span> 待发布草稿（加急自动置顶）<span class="col-tip">共 {{ unpublished.length }} 条</span>
          <el-checkbox
            :model-value="allDraftsSelected"
            :indeterminate="selectedDraftIds.size > 0 && !allDraftsSelected"
            @change="toggleSelectAll"
            style="margin-left:auto"
          >全选 / 取消全选</el-checkbox>
        </div>

        <!-- 草稿任务改为 3 列一排，固定卡片高度 -->
        <el-row :gutter="14">
          <el-col
            :span="8"
            v-for="d in unpublished"
            :key="d.id"
            style="margin-bottom: 10px"
          >
            <div class="draft-card unpublished-grid-card" :class="{ 'urgent-card': d.is_urgent }">
              <!-- 加急盖章（中心长方形，透明度高，不规则边缘虚化） -->
              <div v-if="d.is_urgent" class="urgent-stamp">
                <svg viewBox="0 0 140 60" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <filter id="stamp-blur" x="-10%" y="-10%" width="120%" height="120%">
                      <feGaussianBlur stdDeviation="1.4" />
                    </filter>
                    <filter id="stamp-noise" x="0" y="0" width="100%" height="100%">
                      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="noise" />
                      <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5" />
                    </filter>
                  </defs>
                  <g filter="url(#stamp-noise)">
                    <g filter="url(#stamp-blur)">
                      <rect x="3" y="3" width="134" height="54" rx="6" ry="6"
                        fill="none" stroke="#ef4444" stroke-width="2.8" />
                      <rect x="10" y="10" width="120" height="40" rx="3" ry="3"
                        fill="none" stroke="#ef4444" stroke-width="1.2" />
                    </g>
                    <text x="70" y="40" text-anchor="middle"
                      fill="#ef4444" font-size="24" font-family="'STKaiti','KaiTi','SimSun',serif"
                      font-weight="bold" letter-spacing="4" font-style="italic">加急</text>
                  </g>
                </svg>
              </div>

              <div class="draft-head">
                <div class="draft-id"><b>{{ d.id }}</b></div>
                <div class="draft-meta muted-txt">{{ d.create_time }} · 创建人 {{ d.creator }}</div>
              </div>
              <div class="draft-route">
                <span class="loc-tag">装</span>{{ d.origin }}
                <span class="arrow">➜</span>
                <span class="loc-tag">卸</span>{{ d.destination }}
              </div>
              <!-- 固定布局第一行：货物·吨 / SLA / 车型 / 运费（运费固定，不跑） -->
              <div class="draft-info draft-info-row1">
                <span class="cargo-ton">{{ d.cargo }} · {{ d.weight }} 吨</span>
                <span class="sla">SLA {{ d.sla_hours }}h</span>
                <el-tag type="primary" effect="light" size="small">{{ d.recommended_vehicle_type }}</el-tag>
                <span class="freight">运费 ¥{{ d.freight }}</span>
              </div>
              <!-- 固定布局第二行：最迟发车（占位，没填也留位置） -->
              <div class="draft-info draft-info-row2">
                <span class="latest-label">最迟发车：</span>
                <span class="latest-value">{{ d.latest_departure_time || '—' }}</span>
              </div>
              <!-- 备注固定高度，没填也留空行 -->
              <div class="draft-remarks muted-txt" :class="{ empty: !d.remarks }">
                {{ d.remarks || '（无备注）' }}
              </div>
              <div class="draft-actions">
                <el-button size="small" type="success" plain @click="doPublish(d)">📤 发布</el-button>
                <el-button size="small" type="primary" plain :icon="View" @click="openEdit(d)">查看 / 修改</el-button>
                <el-button size="small" type="warning" plain @click="openSchedule(d)">⏰ 定时发布</el-button>
                <!-- 勾选框：与其他按钮同一行、同高，正方形，勾选图案居中 -->
                <el-checkbox
                  class="draft-select-corner"
                  :model-value="selectedDraftIds.has(d.id)"
                  @change="toggleSelectDraft(d.id)"
                  @click.stop
                />
              </div>
            </div>
          </el-col>
        </el-row>
      </div>

      <el-empty v-if="!loadingDrafts && totalCount === 0" description="暂无草稿任务，在上方创建后会自动堆积在这里" style="padding: 36px 0" />
      <el-empty v-else-if="!unpublished.length" description="所有草稿已发布或已设为定时发布" style="padding: 36px 0" />
    </el-card>

    <!-- 查看/修改弹窗 -->
    <el-dialog v-model="editVisible" title="查看 / 修改草稿" width="680px">
      <el-form label-width="120px" :model="editForm">
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="装货地点"><el-input v-model="editForm.origin" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="卸货地点"><el-input v-model="editForm.destination" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="货物类型"><el-select v-model="editForm.cargo" style="width:100%"><el-option v-for="o in cargoOptions" :key="o" :label="o" :value="o"/></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="重量(吨)"><el-input-number v-model="editForm.weight" :min="0" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="SLA(小时)"><el-input-number v-model="editForm.sla_hours" :min="1" :max="96" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="推荐车辆"><el-select v-model="editForm.recommended_vehicle_type" style="width:100%"><el-option v-for="v in vehicleOptions" :key="v" :label="v" :value="v"/></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最迟发车"><el-date-picker v-model="editForm.latest_departure_time" type="datetime" value-format="YYYY-MM-DD HH:mm" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="运费(元)"><el-input-number v-model="editForm.freight" :min="0" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="是否加急"><el-switch v-model="editForm.is_urgent" active-text="加急" inactive-text="普通"/></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="定时发布时间" v-if="isScheduledTask">
              <el-date-picker
                v-model="editScheduledAt"
                type="datetime"
                value-format="YYYY-MM-DD HH:mm"
                placeholder="选择定时发布时间（修改后保存会重新设置）"
                style="width:100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注"><el-input v-model="editForm.remarks" type="textarea" :rows="2" maxlength="200" show-word-limit /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible=false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存修改</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="scheduleVisible" title="定时发布" width="480px">
      <el-form label-width="120px">
        <el-form-item label="选择发布时间">
          <el-date-picker v-model="scheduleTime" type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="选择定时发布的时间点" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scheduleVisible=false">取消</el-button>
        <el-button type="primary" @click="submitSchedule">确认设置</el-button>
      </template>
    </el-dialog>

    <!-- 批量定时发布弹窗 -->
    <el-dialog v-model="bulkScheduleVisible" title="批量定时发布" width="480px">
      <el-form label-width="120px">
        <el-form-item label="已选任务">
          <span>共 {{ selectedDraftIds.size }} 条</span>
        </el-form-item>
        <el-form-item label="统一发布时间" required>
          <el-date-picker v-model="bulkScheduleTime" type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="选择统一的定时发布时间" style="width:100%"
            :disabled-date="(d: Date) => d.getTime() < new Date().setHours(0,0,0,0)" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkScheduleVisible=false">取消</el-button>
        <el-button type="primary" @click="submitBulkSchedule">确认设置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: 16px; display:flex; justify-content:space-between; align-items:flex-end; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.muted { color: var(--color-muted, #909399); font-size: 13px; margin: 0; }
.card-title { font-size: 15px; font-weight: 600; }
.flex-between { display:flex; align-items:center; justify-content:space-between; }

/* 左右卡片等高 —— 高度固定死，两栏始终一致，互不撑动 */
.same-h-card { height: 700px; display:flex; flex-direction:column; }
.same-h-card :deep(.el-card__body) { flex: 1; display:flex; flex-direction:column; overflow: hidden; }

.muted-txt { color: var(--color-muted, #909399); font-size: 13px; line-height: 1.8; }

.quick-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.quick-tag { cursor: pointer; user-select:none; transition: .15s; }
.quick-tag:hover { color: #409EFF; border-color: #409EFF; }

.col-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 600; margin-bottom: 10px; color: var(--color-text, #303133);
}
.col-title .dot {
  width: 8px; height: 8px; border-radius: 50%; background: #409EFF; display: inline-block;
}
.col-title .col-tip {
  font-weight: 400; color: var(--color-muted, #909399); font-size: 12px; margin-left: 4px;
}

.draft-card {
  position: relative;
  padding: 10px 12px 10px 12px;
  border: 1px solid var(--border-color, #ebeef5);
  border-radius: 8px;
  background: var(--bg-card, #fff);
  display:flex; flex-direction:column; gap: 5px;
  transition: .18s;
  overflow: hidden;
  /* 固定卡片最小高度，防止因内容差异拉伸 */
  min-height: 210px;
}
.draft-card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.06); border-color:var(--border-color, #c0c4cc); }
.draft-card.urgent-card {
  background: linear-gradient(90deg, rgba(245,99,99,.10) 0%, var(--bg-card, #fff) 100%);
  border: 1px solid #f5c2c7;
}

/* 草稿卡片勾选框：与其他三个按钮同一行、高度一致(24px)，正方形，勾选图案固定在正中心 */
.draft-select-corner {
  margin: 0;
  margin-left: auto; /* 推到行最右侧，与按钮水平对齐 */
  height: 24px;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.draft-select-corner :deep(.el-checkbox__inner) {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border-width: 1.5px;
}
/* 勾选图案：以正方形中心为基准居中，不超出按钮 */
.draft-select-corner :deep(.el-checkbox__inner::after) {
  left: 50%;
  top: 50%;
  width: 4px;
  height: 9px;
  border-width: 2px;
  transform: translate(-50%, -55%) rotate(45deg) scaleY(0);
}
.draft-select-corner :deep(.el-checkbox__input.is-checked .el-checkbox__inner::after) {
  transform: translate(-50%, -55%) rotate(45deg) scaleY(1);
}
.draft-select-corner :deep(.el-checkbox__label) { display: none; }

/* 草稿卡片信息行固定布局 */
.draft-info {
  display:flex; gap: 8px; flex-wrap:wrap; font-size:12px; color:var(--color-text, #606266); align-items:center;
}
.draft-info-row1 { flex-wrap: wrap; }
.draft-info-row1 .cargo-ton { color: var(--color-text, #606266); }
.draft-info-row1 .sla { color: var(--color-muted, #909399); }
.draft-info-row2 { font-size: 12px; }
.draft-info-row2 .latest-label { color: var(--color-muted, #909399); }
.draft-info-row2 .latest-value { color: var(--color-text, #303133); font-weight: 500; }

/* 备注固定高度，始终显示3行 */
.draft-remarks {
  min-height: 42px;
  padding: 4px 6px;
  background: var(--table-stripe, #fafbfc);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text, #606266);
  word-break: break-word;
}
.draft-remarks.empty {
  color: var(--color-muted, #c0c4cc);
  font-style: italic;
  background: var(--table-stripe, #fafbfc);
}

/* 草稿卡片操作按钮区域固定在底部（勾选框与按钮同行） */
.draft-actions {
  margin-top: auto;
  display:flex; gap: 6px; align-items:center; flex-wrap: wrap;
}

/* 定时发布固定：内部三个 slot 平均分配剩余空间，不滚动 */
.scheduled-fixed-card :deep(.el-card__body) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px;
}
.scheduled-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}
.scheduled-slot {
  flex: 1;                /* 三等分 */
  min-height: 0;
  display: flex;
  align-items: center;
  padding: 4px 0;
}
.scheduled-slot + .scheduled-slot {
  border-top: 1px dashed var(--border-color, #f0f2f5);
}
.scheduled-card-item {
  width: 100%;
  height: auto;
  /* 覆盖 .draft-card 的 min-height:210px：定时卡内容比草稿卡少，
     高度由内容决定，避免三个按钮下方出现多余空白 */
  min-height: 0;
  background: linear-gradient(90deg, rgba(230,162,60,.10) 0%, var(--bg-card, #fff) 100%);
  border: 1px solid rgba(230,162,60,.35);
}
/* 定时任务卡：备注与三个按钮之间只留少量间距，不把按钮推到底部 */
.scheduled-card-item .draft-actions { margin-top: 8px; }
/* 空位占位：与任务卡同尺寸，虚线框，保证三个区域固定不移动 */
.scheduled-empty-slot {
  width: 100%;
  height: 100%;
  min-height: 170px;
  border: 1.5px dashed #dcdfe6;
  border-radius: 8px;
  background: repeating-linear-gradient(
    -45deg, transparent, transparent 10px, rgba(144,147,153,0.05) 10px, rgba(144,147,153,0.05) 20px
  );
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-muted, #c0c4cc);
  font-size: 13px;
  letter-spacing: 1px;
}

/* 定时发布加急红色方块 */
.urgent-square {
  width: 36px;
  height: 36px;
  background: #ef4444;
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  letter-spacing: 1px;
  flex-shrink: 0;
}

/* 加急盖章（草稿中心长方形，透明度高） */
.urgent-stamp {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 62%;
  pointer-events: none;
  z-index: 3;
  opacity: 0.28;
}
.urgent-stamp svg {
  width: 100%;
  height: auto;
  display: block;
}

.draft-head { display:flex; justify-content:space-between; align-items:center; }
.draft-head .draft-id { font-size: 14px; }
.draft-route { display:flex; align-items:center; gap: 6px; font-size: 14px; }
.draft-route .loc-tag { display:inline-block; width:20px; height:20px; line-height:20px; text-align:center; background:rgba(64,158,255,.14); color:#409EFF; border-radius:4px; font-size:12px; font-weight:600; }
.draft-route .arrow { color:var(--color-muted, #c0c4cc); }
.draft-info { display:flex; gap: 10px; flex-wrap:wrap; font-size:12px; color:var(--color-text, #606266); align-items:center; }
.draft-info .freight { color:#E6A23C; font-weight:600; }
.draft-remarks { font-size: 12px; }
.draft-actions { margin-top:auto; display:flex; gap: 6px; align-items:center; flex-wrap: wrap; }

.module-hint {
  color: var(--color-muted, #9ca3af);
  font-size: 12px;
  line-height: 1.7;
  margin: 10px 4px;
  letter-spacing: .2px;
}

.scheduled-pagination {
  display: flex;
  justify-content: center;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color, #ebeef5);
  flex-shrink: 0;
}

.countdown-subtitle {
  font-size: 12px;
  color: var(--color-muted, #909399);
  margin-top: 2px;
  line-height: 1.4;
}
.countdown-subtitle b {
  color: #E6A23C;
  font-weight: 700;
  letter-spacing: .5px;
}

/* ---------- OCR 拖拽上传区（占满表单下方剩余空间，拖拽区上下空白对称） ---------- */
.ocr-section {
  margin-top: 14px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;  /* 拖拽区在剩余空间中垂直居中：距按钮与距卡底空白相等 */
}
.ocr-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--color-text, #303133);
}
.ocr-dropzone {
  border: 2px dashed var(--border-color, #dcdfe6);
  border-radius: 8px;
  background: var(--table-stripe, #f5f7fa);
  cursor: pointer;
  transition: .2s;
  user-select: none;
}
.ocr-dropzone:hover,
.ocr-dropzone.is-dragover {
  border-color: #409eff;
  background: rgba(64,158,255,.08);
}
.ocr-dropzone.is-loading {
  opacity: .6;
  pointer-events: none;
}
.ocr-dropzone-inner {
  padding: 50px 16px;   /* 加高拖拽区，填满表单与卡底之间的对称留白 */
  text-align: center;
}
.ocr-plus {
  font-size: 30px;     /* 加号随拖拽区等比加大 */
  font-weight: 300;
  color: #409eff;
  line-height: 1;
}
.ocr-tip {
  font-size: 13px;
  color: var(--color-text, #303133);
  margin-top: 4px;
}
.ocr-hint {
  font-size: 12px;
  color: var(--color-muted, #909399);
  margin-top: 2px;
}
</style>
