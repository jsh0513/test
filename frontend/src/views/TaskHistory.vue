<script setup lang="ts">
import { reactive, ref, onMounted, computed, nextTick } from 'vue'
import { Search, View } from '@element-plus/icons-vue'
import { getHistoryTasks, getTaskDetail, toggleDepartOverdue, toggleTaskOverdueFlag, toggleUrgentFlag } from '../api'
// 性能：base64 大图直接渲染会触发主线程同步解码（>100ms 长任务），缩略图工具在后台线程解码
import { makeThumbnails } from '../utils/imageThumb'
import { useUserStore } from '../stores/user'
import { ElMessage, ElMessageBox } from 'element-plus'

const store = useUserStore()
const isAdmin = computed(() => store.isAdmin)

const tableData = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const query = reactive({ keyword: '', status: '', start_date: '', end_date: '', page: 1, pageSize: 10 })
const statusOptions = ['已完成', '已取消', '异常']

const detailVisible = ref(false)
const detailTask = ref<any>({})
// 性能：详情弹窗先开窗显示骨架屏，取数/图片解码/组件渲染全部放到动画之后，
// 避免「点详情」瞬间把接口等待 + 大图解码 + descriptions 渲染挤进同一个动画帧
const detailLoading = ref(false)
const detailExThumbs = ref<string[]>([]) // 异常照片缩略图
const detailAtThumbs = ref<string[]>([]) // 运输照片缩略图

// 性能：timeline 一次性渲染全部日志会产生长任务，默认只渲染 50 条，可手动展开
const LOG_PAGE_SIZE = 50
const logsExpanded = ref(false)
const allLogs = computed(() => {
  const allowed = ['edit', 'dispatch', 'cancel', 'complete', 'depart', 'exception']
  return (detailTask.value._logs || []).filter((l: any) => allowed.includes(l.type))
})
const detailLogs = computed(() => (logsExpanded.value ? allLogs.value : allLogs.value.slice(0, LOG_PAGE_SIZE)))
const hiddenLogCount = computed(() => Math.max(0, allLogs.value.length - detailLogs.value.length))

function monthRange() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const pad = (n: number) => String(n).padStart(2, '0')
  const start = `${y}-${pad(m + 1)}-01`
  const end = `${y}-${pad(m + 1)}-${pad(now.getDate())}`
  return { start, end }
}
// 默认只显示当月任务
function applyCurrentMonth() {
  const { start, end } = monthRange()
  query.start_date = start
  query.end_date = end
}
async function fetchList() {
  loading.value = true
  try { const r = await getHistoryTasks(query); tableData.value = r.list || []; total.value = r.total || 0 }
  finally { loading.value = false }
}
function handleSearch() { query.page = 1; fetchList() }
function handleReset()  {
  query.keyword = ''
  query.status = ''
  applyCurrentMonth() // 重置后仍回到默认：当月
  handleSearch()
}

async function openDetail(row: any) {
  // 性能：先开窗让动画立即播放（骨架屏占位），再异步取数与解码；
  // 三件事（动画 / 请求 / 组件渲染）不再挤在同一个点击事件的同步执行里
  detailVisible.value = true
  detailLoading.value = true
  detailTask.value = {}
  detailExThumbs.value = []
  detailAtThumbs.value = []
  logsExpanded.value = false // 每次打开重置为分批展示
  // 性能修复：等一帧让骨架屏挂载，避免接口快时 true/false 被合并导致骨架屏不渲染
  await nextTick()
  try {
    const r = await getTaskDetail(row.id)
    const task = r.task || {}
    // 性能：在后台线程解码生成小缩略图用于列表展示，原图仅点击放大预览时使用
    const [exThumbs, atThumbs] = await Promise.all([
      makeThumbnails(task.exception_images || []),
      makeThumbnails(taskImages(task)),
    ])
    detailExThumbs.value = exThumbs
    detailAtThumbs.value = atThumbs
    detailTask.value = { ...task, _logs: r.logs || [] }
  } finally { detailLoading.value = false }
}

// 切换函数：发车超时 / 任务超时 / 加急标记
async function toggleFlag(row: any, field: 'depart_overdue' | 'task_overdue' | 'urgent_manual', label: string, api: Function) {
  try {
    // 加急的有效状态 = is_urgent || urgent_manual（与表格显示一致），否则提示方向会出错
    const effectiveNow = field === 'urgent_manual'
      ? Boolean(row.is_urgent || row.urgent_manual)
      : Boolean(row[field])
    await ElMessageBox.confirm(
      `确认将任务 ${row.id} 的「${label}」标记改为 ${effectiveNow ? '关闭' : '开启'}？`,
      '标记切换',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    const r = await api(row.id)
    if (field === 'urgent_manual') {
      // 后端按有效状态整体切换，同步两个字段才能在加急/普通间来回切换
      row.is_urgent = Boolean(r.is_urgent)
      row.urgent_manual = Boolean(r.urgent_manual)
    } else {
      row[field] = !row[field]
    }
    ElMessage.success(`「${label}」标记已更新`)
  } catch (_) { /* 取消 */ }
}
const canToggle = (row: any) => isAdmin.value && row.status !== '已取消'
function toggleDepartOverdueRow(row: any) { toggleFlag(row, 'depart_overdue', '发车是否超时', toggleDepartOverdue) }
function toggleTaskOverdueRow(row: any)   { toggleFlag(row, 'task_overdue', '任务是否超时', toggleTaskOverdueFlag) }
function toggleUrgentRow(row: any)        { toggleFlag(row, 'urgent_manual', '加急标记', toggleUrgentFlag) }

function statusTag(s: string) {
  if (s === '已完成') return 'success'
  if (s === '已取消') return 'info'
  if (s === '异常') return 'danger'
  return 'warning'
}
function logIcon(t: string) {
  return ({ edit:'✏️', dispatch:'📤', complete:'✅', cancel:'❌', depart:'🚛', exception:'⚠️' } as any)[t] || '🔹'
}
function logTypeLabel(t: string) {
  return ({ edit:'修改', dispatch:'派发', complete:'确认完成', cancel:'取消', depart:'确认发车', exception:'上报异常' } as any)[t] || t
}
function logTypeColor(t: string) {
  return ({ edit:'warning', dispatch:'primary', complete:'success', cancel:'danger', depart:'warning', exception:'danger' } as any)[t] || 'info'
}

// 运输照片：优先取多张数组，向后兼容旧的单张 attachment
function taskImages(t: any): string[] {
  if (Array.isArray(t?.attachments) && t.attachments.length) return t.attachments
  return t?.attachment ? [t.attachment] : []
}

onMounted(() => { applyCurrentMonth(); fetchList() })
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>历史任务</h2>
        <p>已完成 / 已取消 / 异常的任务归档，支持编号/起点/终点/状态/时间范围查询，可查看完整操作追溯记录</p>
      </div>
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form :inline="true" :model="query" label-width="58px">
        <el-form-item label="关键字">
          <el-input v-model="query.keyword" placeholder="任务编号/起点/终点" clearable style="width:240px" :prefix-icon="Search" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部状态" clearable style="width:130px">
            <el-option v-for="s in statusOptions" :key="s" :value="s" :label="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间">
          <el-date-picker v-model="query.start_date" value-format="YYYY-MM-DD" placeholder="开始" style="width:140px" />
          <span style="margin:0 8px">至</span>
          <el-date-picker v-model="query.end_date"   value-format="YYYY-MM-DD" placeholder="结束" style="width:140px" />
        </el-form-item>
        <el-form-item label="">
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="hover" style="margin-top:12px">
      <el-table :data="tableData" v-loading="loading" stripe class="history-table" style="width:100%">
        <el-table-column prop="id" label="任务编号" min-width="132" />
        <el-table-column prop="driver_name" label="司机" min-width="72" />
        <el-table-column prop="origin" label="起点" min-width="88" />
        <el-table-column prop="destination" label="终点" min-width="88" />
        <el-table-column prop="cargo" label="货物" min-width="80" />
        <el-table-column label="载重" min-width="72"><template #default="{row}">{{ row.weight }} 吨</template></el-table-column>
        <el-table-column label="状态" min-width="84" align="center" header-align="center">
          <template #default="{row}">
            <el-tag :type="statusTag(row.status)" :effect="row.status==='异常' ? 'dark' : 'light'" class="status-tag-cell">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <!-- 发车超时 tag -->
        <el-table-column label="发车超时" min-width="90" align="center" header-align="center">
          <template #default="{row}">
            <el-tag
              :type="row.depart_overdue ? 'danger' : 'info'"
              :effect="row.depart_overdue ? 'dark' : 'plain'"
              size="small"
              :style="{ cursor: canToggle(row) ? 'pointer' : 'not-allowed', opacity: canToggle(row) ? 1 : 0.5 }"
              @click="canToggle(row) && toggleDepartOverdueRow(row)"
            >{{ row.depart_overdue ? '⚠ 超时' : '未超时' }}</el-tag>
          </template>
        </el-table-column>
        <!-- 任务超时 tag -->
        <el-table-column label="任务超时" min-width="90" align="center" header-align="center">
          <template #default="{row}">
            <el-tag
              :type="row.task_overdue ? 'danger' : 'info'"
              :effect="row.task_overdue ? 'dark' : 'plain'"
              size="small"
              :style="{ cursor: canToggle(row) ? 'pointer' : 'not-allowed', opacity: canToggle(row) ? 1 : 0.5 }"
              @click="canToggle(row) && toggleTaskOverdueRow(row)"
            >{{ row.task_overdue ? '⚠ 超时' : '未超时' }}</el-tag>
          </template>
        </el-table-column>
        <!-- 是否加急 tag -->
        <el-table-column label="是否加急" min-width="88" align="center" header-align="center">
          <template #default="{row}">
            <el-tag
              :type="(row.is_urgent || row.urgent_manual) ? 'danger' : 'info'"
              :effect="(row.is_urgent || row.urgent_manual) ? 'dark' : 'plain'"
              size="small"
              :style="{ cursor: canToggle(row) ? 'pointer' : 'not-allowed', opacity: canToggle(row) ? 1 : 0.5 }"
              @click="canToggle(row) && toggleUrgentRow(row)"
            >{{ (row.is_urgent || row.urgent_manual) ? '加急' : '普通' }}</el-tag>
          </template>
        </el-table-column>
        <!-- 完成时间：新完成的任务排在最上面（后端按 complete_time 倒序） -->
        <el-table-column prop="complete_time" label="完成时间" min-width="146">
          <template #default="{row}">
            <span v-if="row.complete_time">{{ row.complete_time }}</span>
            <span v-else style="color:var(--color-muted)">—</span>
          </template>
        </el-table-column>
        <!-- 操作列只保留"详细"按钮 -->
        <el-table-column label="操作" min-width="80" align="center" header-align="center">
          <template #default="{row}">
            <el-button link type="primary" :icon="View" @click="openDetail(row)">详细</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination class="pagination"
        v-model:current-page="query.page" v-model:page-size="query.pageSize"
        :page-sizes="[10,20,50]" :total="total" :pager-count="7"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="fetchList" @current-change="fetchList" />
    </el-card>

    <!-- 历史任务详情 & 操作追溯 -->
    <el-dialog v-model="detailVisible" title="历史任务详情 & 操作追溯" width="760px">
      <!-- 性能：加载中先渲染轻量骨架屏，避免数据未就绪时内容突兀跳变；弹窗本身不加 v-if -->
      <el-skeleton v-if="detailLoading" :rows="8" animated style="padding:4px" />
      <template v-else-if="detailTask.id">
        <!-- 基本信息：按括号分组 → 同排 -->
        <el-descriptions :column="2" border size="small" title="基本信息">
          <!-- (任务编号, 创建人) -->
          <el-descriptions-item label="任务编号"><b>{{ detailTask.id }}</b></el-descriptions-item>
          <el-descriptions-item label="创建人">{{ detailTask.creator }}</el-descriptions-item>
          <!-- (装货地点, 卸货地点) -->
          <el-descriptions-item label="装货地点">{{ detailTask.origin }}</el-descriptions-item>
          <el-descriptions-item label="卸货地点">{{ detailTask.destination }}</el-descriptions-item>
          <!-- (推荐车辆类型, 货物) -->
          <el-descriptions-item label="推荐车辆类型">
            <el-tag type="primary" effect="light">{{ detailTask.recommended_vehicle_type || '厢式货车' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="货物">{{ detailTask.cargo }}({{ detailTask.weight }}吨)</el-descriptions-item>
          <!-- (状态, 司机) -->
          <el-descriptions-item label="状态">
            <el-tag :type="statusTag(detailTask.status)" :effect="detailTask.status==='异常' ? 'dark' : 'light'">{{ detailTask.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="司机">{{ detailTask.driver_name || '未分配' }}</el-descriptions-item>
          <!-- (运费, 调度员) -->
          <el-descriptions-item label="运费">¥{{ detailTask.freight || 0 }} 元</el-descriptions-item>
          <el-descriptions-item label="调度员">{{ detailTask.dispatcher_name || '（未派发）' }}</el-descriptions-item>
          <!-- (是否加急, TRIP小计里程) -->
          <el-descriptions-item label="是否加急">
            <el-tag :type="(detailTask.is_urgent || detailTask.urgent_manual) ? 'danger' : 'info'" effect="light">
              {{ (detailTask.is_urgent || detailTask.urgent_manual) ? '加急' : '普通' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="TRIP 小计里程">
            {{ detailTask.trip_mileage != null ? detailTask.trip_mileage + ' km' : '-' }}
          </el-descriptions-item>
        </el-descriptions>

        <!-- 时间信息：左3右3 对齐 -->
        <el-descriptions :column="2" border size="small" title="时间信息" style="margin-top:12px">
          <el-descriptions-item label="发布时间">{{ detailTask.publish_time || '—' }}</el-descriptions-item>
          <el-descriptions-item label="发车时间">{{ detailTask.departure_time || '—' }}</el-descriptions-item>
          <el-descriptions-item label="最迟发车">
            {{ detailTask.latest_departure_time || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="派发时间">{{ detailTask.dispatch_time || '—' }}</el-descriptions-item>
          <el-descriptions-item label="完成期限">{{ detailTask.sla_hours || 8 }} 小时</el-descriptions-item>
          <el-descriptions-item label="完成时间">{{ detailTask.complete_time || '—' }}</el-descriptions-item>
        </el-descriptions>

        <!-- 其他信息：发车是否超时 | 任务是否超时；附件 | 取消原因 -->
        <el-descriptions :column="2" border size="small" title="其他信息" style="margin-top:12px">
          <el-descriptions-item label="发车是否超时">
            <el-tag v-if="detailTask.depart_overdue" type="danger" effect="light">发车超时</el-tag>
            <el-tag v-else type="success" effect="plain">未超时</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="任务是否超时">
            <el-tag v-if="detailTask.task_overdue" type="danger" effect="light">任务超时</el-tag>
            <el-tag v-else type="success" effect="plain">未超时</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="运输照片(附件)">
            <template v-if="taskImages(detailTask).length">
              <!-- 性能：:src 用后台解码的缩略图避免主线程解码长任务，preview-src-list 保留原图（放大预览仍清晰） -->
              <el-image
                v-for="(img, i) in taskImages(detailTask)" :key="i"
                :src="detailAtThumbs[i] || img" :preview-src-list="taskImages(detailTask)"
                :initial-index="i" preview-teleported fit="cover"
                style="width:64px;height:48px;border-radius:4px;margin:0 8px 4px 0;cursor:pointer"
              />
            </template>
            <span v-else style="color:var(--color-muted)">-</span>
          </el-descriptions-item>
          <el-descriptions-item label="取消原因">
            <template v-if="detailTask.cancel_reason">
              <el-tag type="danger" effect="plain">{{ detailTask.cancel_reason }}</el-tag>
            </template>
            <span v-else style="color:var(--color-muted)">-</span>
          </el-descriptions-item>
          <!-- 异常信息（仅异常任务） -->
          <el-descriptions-item v-if="detailTask.exception_reason" label="异常原因" :span="2">
            <el-tag type="danger" effect="dark">{{ detailTask.exception_reason }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="detailTask.exception_time" label="异常上报时间">
            {{ detailTask.exception_time }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detailTask.exception_by_name" label="异常上报人">
            {{ detailTask.exception_by_name }}
          </el-descriptions-item>
          <el-descriptions-item v-if="(detailTask.exception_images || []).length" label="异常现场照片" :span="2">
            <!-- 性能：同运输照片，缩略图展示 + 原图预览，避免打开弹窗时一次性解码多张大 base64 图 -->
            <el-image
              v-for="(img, i) in (detailTask.exception_images || [])" :key="'ex'+i"
              :src="detailExThumbs[i] || img" :preview-src-list="detailTask.exception_images"
              :initial-index="i" preview-teleported fit="cover"
              style="width:72px;height:72px;border-radius:6px;margin:0 8px 4px 0;cursor:pointer"
            />
          </el-descriptions-item>
          <!-- 备注信息 / 附加信息：等高两行，无内容显示「无」 -->
          <el-descriptions-item label="备注信息" :span="2">
            <div class="remarks-box">
              {{ detailTask.remarks || '无' }}
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="附加信息" :span="2">
            <div class="remarks-box">
              {{ detailTask.extra_remarks || '无' }}
            </div>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 操作日志 -->
        <div style="margin:18px 0 8px; font-weight:600">全流程操作日志(含修改人/派发人/确认完成人/确认发车人)</div>
        <el-timeline>
          <!-- 性能：日志分批渲染（首屏 50 条），避免任务日志很多时一次性生成大量 DOM 节点 -->
          <el-timeline-item v-for="l in detailLogs" :key="l.id" :timestamp="l.time" placement="top" :type="logTypeColor(l.type)">
            <div>
              <span style="font-size:18px; margin-right:6px">{{ logIcon(l.type) }}</span>
              <b>{{ l.user_name }}</b>
              <el-tag size="small" :type="logTypeColor(l.type)" effect="plain" style="margin:0 6px">
                {{ logTypeLabel(l.type) }}
              </el-tag>
              <span>{{ l.detail }}</span>
            </div>
          </el-timeline-item>
          <el-empty v-if="!detailLogs.length" description="该任务暂无相关操作日志" :image-size="80" />
        </el-timeline>
        <!-- 手动加载剩余日志，把长任务拆成多次小渲染 -->
        <div v-if="hiddenLogCount > 0" style="text-align:center; margin-top:4px">
          <el-button link type="primary" @click="logsExpanded = true">加载更多日志（还有 {{ hiddenLogCount }} 条）</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.filter-card { margin-bottom: 12px; }
.filter-card :deep(.el-form-item) { margin-bottom: 12px; margin-right: 22px; }
.pagination { margin-top: 16px; justify-content: flex-end; display: flex; }
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.page-header p { margin: 0; color: var(--color-muted, #909399); font-size: 13px; }

/* 拉开各列信息间距、利用右侧空白 */
.history-table :deep(.el-table__cell) { padding: 10px 0; }
.history-table :deep(.cell) { padding-left: 14px; padding-right: 14px; }
.status-tag-cell { white-space: nowrap; flex-shrink: 0; }

/* 备注信息 / 附加信息：固定两行高度 */
.remarks-box {
  min-height: 56px;
  padding: 6px 10px;
  background: var(--table-stripe, #fafbfc);
  border: 1px solid var(--border-color, #ebeef5);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text, #303133);
}
</style>
