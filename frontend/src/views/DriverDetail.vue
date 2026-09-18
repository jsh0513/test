<script setup lang="ts">
import { ref, onMounted, reactive, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Refresh } from '@element-plus/icons-vue'
import {
  getDriverDetail,
  getDriverAttendance, getDriverMonthlyTasks,
  updateDriverMaintenance,
} from '../api'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)

const loading = ref(false)
const data: any = ref({
  driver: {}, stats: {}, maintenance: {},
  attendance: { list: [], stats: {}, year: 0, month: 0 },
  tasksMonth: { list: [], year: 0, month: 0 },
})

// ------ 时区 + 入职日期限制 ------
const nowChina = new Date()
const thisYear = nowChina.getFullYear()
const thisMonth = nowChina.getMonth() + 1

function parseJoinDateYM() {
  const jd = data.value.driver?.join_date
  if (!jd) return { year: thisYear, month: 1 }
  const m = String(jd).match(/^(\d{4})-(\d{1,2})/)
  if (!m) return { year: thisYear, month: 1 }
  return { year: Number(m[1]), month: Number(m[2]) }
}
const minYM = computed(() => parseJoinDateYM())
const maxYM = computed(() => ({ year: thisYear, month: thisMonth }))

function clampYM(target: { year: number; month: number }) {
  if (target.year < minYM.value.year) { target.year = minYM.value.year; target.month = minYM.value.month; return }
  if (target.year === minYM.value.year && target.month < minYM.value.month) { target.month = minYM.value.month }
  if (target.year > maxYM.value.year) { target.year = maxYM.value.year; target.month = maxYM.value.month; return }
  if (target.year === maxYM.value.year && target.month > maxYM.value.month) { target.month = maxYM.value.month }
}

function monthShift(target: any, delta: number) {
  let totalMonths = target.year * 12 + (target.month - 1) + delta
  target.month = (totalMonths % 12) + 1
  target.year = Math.floor(totalMonths / 12)
  clampYM(target)
}

function yearOptions() {
  const minY = minYM.value.year
  const maxY = maxYM.value.year
  const arr: number[] = []
  for (let y = minY; y <= maxY; y++) arr.push(y)
  return arr
}

// ------ 出勤日历使用的年月（右上角导航按钮只控制日历） ------
const calYM = reactive({ year: thisYear, month: thisMonth })
clampYM(calYM)

// ------ 接单历史使用的年月（接单历史独立搜索，与日历互不影响） ------
const orderYM = reactive({ year: thisYear, month: thisMonth })
clampYM(orderYM)

// ------ 接单历史：搜索条件 + 分页（10 条/页） ------
const taskRouteSearch = ref('')
const taskPage = ref(1)
const taskPageSize = 10

async function loadAll() {
  loading.value = true
  try {
    const r = await getDriverDetail(id)
    data.value = r
    clampYM(calYM)
    clampYM(orderYM)
    // 日历与接单历史各自加载，互不干扰
    await Promise.all([loadAttendance(), loadMonthlyTasks()])
  } finally { loading.value = false }
}
onMounted(loadAll)

async function loadAttendance() {
  clampYM(calYM)
  const r = await getDriverAttendance(id, calYM.year, calYM.month)
  data.value.attendance = r
}

async function loadMonthlyTasks() {
  clampYM(orderYM)
  const ta = await getDriverMonthlyTasks(id, orderYM.year, orderYM.month)
  data.value.tasksMonth = ta
  taskPage.value = 1
}

// 接单历史：按年月查询
function searchOrderMonth() {
  clampYM(orderYM)
  taskPage.value = 1
  loadMonthlyTasks()
}
// 接单历史：重置搜索条件（路线关键字清空，年月回到当月）
function resetOrderSearch() {
  taskRouteSearch.value = ''
  orderYM.year = thisYear
  orderYM.month = thisMonth
  clampYM(orderYM)
  taskPage.value = 1
  loadMonthlyTasks()
}

// 接单历史 → 按路线关键字过滤 + 分页切片
const filteredTasks = computed(() => {
  const list = data.value.tasksMonth?.list || []
  const kw = (taskRouteSearch.value || '').trim().toLowerCase()
  const filtered = kw ? list.filter((t: any) =>
    String(t.origin || '').toLowerCase().includes(kw) ||
    String(t.destination || '').toLowerCase().includes(kw)
  ) : list
  const start = (taskPage.value - 1) * taskPageSize
  return filtered.slice(start, start + taskPageSize)
})
const filteredTasksTotal = computed(() => {
  const list = data.value.tasksMonth?.list || []
  const kw = (taskRouteSearch.value || '').trim().toLowerCase()
  return kw ? list.filter((t: any) =>
    String(t.origin || '').toLowerCase().includes(kw) ||
    String(t.destination || '').toLowerCase().includes(kw)
  ).length : list.length
})

// ------ 保修：登记今天完成 / 手动设置上一次保修日期（均带确认框，改动记入人员变动日志） ------
// 手动选择的保修日期（不能晚于今天）
const maintDate = ref('')
function disableFutureDate(d: Date) {
  return d.getTime() > new Date(new Date().toDateString()).getTime()
}

async function refreshMaintenance() {
  try {
    await ElMessageBox.confirm(
      `确认已完成司机「${data.value.driver?.name}」的车辆保养？确认后将更新上一次保修时间，下次保修倒计时将重新从今天起算 2 年。`,
      '确认保修更新',
      { confirmButtonText: '✓ 已完成保修，更新时间', cancelButtonText: '暂未完成', type: 'success' }
    )
  } catch (_) { return }
  try {
    const r = await updateDriverMaintenance(id)
    if (r.maintenance) data.value.maintenance = r.maintenance
    ElMessage.success('已登记本次保修，下次保修时间已顺延 2 年')
  } catch (_) {}
}

// 手动设置「上一次保修时间」（管理员/调度员均可，改动自动记录到人员变动）
async function setMaintenanceDate() {
  if (!maintDate.value) {
    ElMessage.warning('请先选择保修日期')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认将司机「${data.value.driver?.name}」的上一次保修时间设置为 ${maintDate.value} ？\n该改动会记录到「人员变动」日志，下次保修倒计时将从该日期起算 2 年。`,
      '确认设置保修时间',
      { confirmButtonText: '确认设置', cancelButtonText: '取消', type: 'warning' }
    )
  } catch (_) { return }
  try {
    const r = await updateDriverMaintenance(id, maintDate.value)
    if (r.maintenance) data.value.maintenance = r.maintenance
    ElMessage.success('保修时间已更新，并已记录到人员变动日志')
    maintDate.value = ''
  } catch (_) {}
}

// ------ 出勤日历渲染 ------
const attendWeekday = ['日','一','二','三','四','五','六']
const attendanceGrid = computed(() => {
  const list: any[] = data.value.attendance.list || []
  if (!list.length) return []
  const padStart = new Date(list[0].date).getDay()
  const head = Array.from({ length: padStart }, () => ({ empty: true }))
  return [...head, ...list]
})
function attendCellClass(status: string) {
  return ({
    出勤: 'attend-full', 请假: 'attend-leave',
    缺勤: 'attend-absent', 休假: 'attend-rest',
  } as Record<string,string>)[status] || ''
}
function attendStatusTagType(s: string) {
  return ({ 出勤:'success', 休假:'info', 请假:'warning', 缺勤:'danger' } as Record<string,string>)[s] || 'info'
}
</script>

<template>
  <div v-loading="loading">
    <div class="page-header">
      <div>
        <h2 style="display:flex;align-items:center;gap:8px">
          <el-button text @click="router.back()" :icon="ArrowLeft" />
          司机详情统计
          <el-tag type="primary" effect="plain" size="small">{{ data.driver?.name }}（{{ data.driver?.plate }}）</el-tag>
        </h2>
        <p>查看司机所有关键指标（出勤日历按入职日期 + 北京时间对标）</p>
      </div>
    </div>

    <!-- 基础信息 -->
    <el-card style="margin-bottom: 16px">
      <template #header><b>司机基础信息</b></template>
      <el-descriptions :column="4" border>
        <el-descriptions-item label="姓名">{{ data.driver?.name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="年龄">
          <span style="font-weight:600">{{ data.driver?.age || '-' }}</span> 岁
        </el-descriptions-item>
        <el-descriptions-item label="性别">
          <el-tag size="small" effect="plain" :type="data.driver?.gender === '女' ? 'danger' : 'primary'">
            {{ data.driver?.gender || '男' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="手机号">{{ data.driver?.phone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="车牌号">{{ data.driver?.plate || '-' }}</el-descriptions-item>
        <el-descriptions-item label="所在城市">{{ data.driver?.city || '-' }}</el-descriptions-item>
        <el-descriptions-item label="车辆类型">{{ data.driver?.vehicle_type || '-' }}</el-descriptions-item>
        <el-descriptions-item label="当前状态">
          <el-tag>{{ data.driver?.status || '-' }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="入职日期">
          {{ data.driver?.join_date || '-' }}
          <el-tag v-if="data.driver?.join_date" size="small" effect="plain" type="info" style="margin-left:6px">
            最早可查：{{ parseJoinDateYM().year }} 年 {{ parseJoinDateYM().month }} 月
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="身份证" :span="3">{{ data.driver?.id_card || '-' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 行 1：任务统计卡（只留 3 项） + 车辆保修（按钮加确认框） -->
    <el-row :gutter="16" style="margin-bottom:16px">
      <el-col :span="12">
        <el-card style="height:100%">
          <template #header><b>任务统计卡</b><span style="color:var(--color-muted,#909399);font-size:12px;margin-left:8px">总任务数 / 累计运输重量 / 累计公里数（TRIP 小计里程）</span></template>
          <el-row :gutter="12">
            <el-col :span="8">
              <div class="mini-stat">
                <div class="mini-k">总任务数</div>
                <div class="mini-v c-primary">{{ data.stats?.task_total || 0 }}</div>
                <div class="mini-hint">当月任务总量</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="mini-stat">
                <div class="mini-k">累计运输重量</div>
                <div class="mini-v c-warning">{{ data.stats?.total_weight || 0 }}</div>
                <div class="mini-hint">吨（当月任务货物重量合计）</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="mini-stat">
                <div class="mini-k">累计公里数</div>
                <div class="mini-v c-success">{{ data.stats?.total_trip_mileage || 0 }}</div>
                <div class="mini-hint">km（当月 TRIP 小计里程累计）</div>
              </div>
            </el-col>
          </el-row>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card style="height:100%">
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>车辆保修（2 年一次）</b>
              <el-button type="primary" size="small" :icon="Refresh" @click="refreshMaintenance">已完成保修，更新时间</el-button>
            </div>
          </template>
          <el-row :gutter="16">
            <el-col :span="12">
              <div class="mini-stat" style="border-right:1px dashed var(--border-color)">
                <div class="mini-k">上一次保修时间</div>
                <div class="mini-v c-info" style="font-size:22px">{{ data.maintenance?.last_maintenance || '-' }}</div>
                <div class="mini-hint">左边：上次保修</div>
              </div>
            </el-col>
            <el-col :span="12">
              <div class="mini-stat">
                <div class="mini-k">下一次保修倒计时</div>
                <div v-if="data.maintenance?.days_left !== undefined" class="mini-v"
                  :class="data.maintenance.overdue ? 'c-danger' : (data.maintenance.urgent ? 'c-warning' : 'c-success')"
                  style="font-size:24px">
                  {{ data.maintenance.overdue ? `已过期 ${-data.maintenance.days_left} 天` : `${data.maintenance.days_left} 天` }}
                </div>
                <div class="mini-hint">下一次时间：{{ data.maintenance?.next_maintenance || '-' }}</div>
              </div>
            </el-col>
          </el-row>
          <el-alert
            v-if="data.maintenance?.urgent"
            style="margin-top:8px"
            :type="data.maintenance.overdue ? 'error' : 'warning'"
            :title="data.maintenance.overdue ? '保修已过期，请尽快安排保修' : '保修临近到期（≤30 天），请安排'"
            show-icon :closable="false" />
          <!-- 手动设置上一次保修时间（管理员/调度员均可，带确认框，改动记入人员变动） -->
          <div style="display:flex;gap:8px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px dashed var(--border-color,#ebeef5)">
            <span style="font-size:13px;color:var(--color-muted,#909399);white-space:nowrap">设置上一次保修时间：</span>
            <el-date-picker
              v-model="maintDate"
              type="date"
              size="small"
              value-format="YYYY-MM-DD"
              :disabled-date="disableFutureDate"
              placeholder="选择保修日期（不可晚于今天）"
              style="width:200px"
            />
            <el-button size="small" type="warning" plain @click="setMaintenanceDate">确认设置</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 行 2：左 接单历史（框架保留） + 右 出勤日历（右半边） -->
    <el-card>
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <b>接单历史 & 出勤日历</b>
            <el-tag size="small" effect="plain" type="info" style="margin-left:8px">
              范围：入职（{{ minYM.year }}年{{ minYM.month }}月）～ 当前（{{ maxYM.year }}年{{ maxYM.month }}月）
            </el-tag>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <el-button-group>
              <el-button size="small" :disabled="calYM.year<=minYM.year && calYM.month<=minYM.month" @click="monthShift(calYM, -12); loadAttendance()">‹‹ 上一年</el-button>
              <el-button size="small" :disabled="calYM.year<=minYM.year && calYM.month<=minYM.month" @click="monthShift(calYM, -1); loadAttendance()">上个月</el-button>
              <el-button size="small" :disabled="calYM.year>=maxYM.year && calYM.month>=maxYM.month" @click="monthShift(calYM, 1); loadAttendance()">下个月</el-button>
              <el-button size="small" :disabled="calYM.year>=maxYM.year && calYM.month>=maxYM.month" @click="monthShift(calYM, 12); loadAttendance()">下一年 ››</el-button>
            </el-button-group>
            <el-select v-model="calYM.year" size="small" style="width:110px" @change="loadAttendance">
              <el-option v-for="y in yearOptions()" :key="y" :value="y" :label="y+' 年'" />
            </el-select>
            <el-select v-model="calYM.month" size="small" style="width:90px" @change="loadAttendance">
              <el-option v-for="m in 12" :key="m" :value="m" :label="m+' 月'" />
            </el-select>
            <el-button type="primary" size="small" @click="loadAttendance">查看该月</el-button>
          </div>
        </div>
      </template>

      <el-row :gutter="16">
        <!-- ===== 左：接单历史（独立搜索：起/终点 + 年月，10 条/页，与出勤日历互不影响） ===== -->
        <el-col :span="14">
          <div class="section-title">📋 接单历史 · {{ orderYM.year }} 年 {{ orderYM.month }} 月
            <el-tag style="margin-left:8px">共 {{ filteredTasksTotal }} 单</el-tag>
          </div>

          <!-- 搜索栏 1：按起点/终点路线 -->
          <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
            <el-input
              v-model="taskRouteSearch"
              placeholder="🔍 按起点/终点路线搜索（如：北京→上海）"
              clearable style="flex:1;max-width:420px" size="small"
              @keyup.enter="taskPage=1"
            />
            <el-button size="small" type="primary" link @click="taskPage=1">搜索</el-button>
            <el-button size="small" link @click="resetOrderSearch">重置</el-button>
          </div>
          <!-- 搜索栏 2：按年/月（最早以入职时间为准） -->
          <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
            <span style="font-size:12px;color:var(--color-muted,#909399)">按月份查询：</span>
            <el-select v-model="orderYM.year" size="small" style="width:100px">
              <el-option v-for="y in yearOptions()" :key="y" :value="y" :label="y+' 年'" />
            </el-select>
            <el-select v-model="orderYM.month" size="small" style="width:80px">
              <el-option v-for="m in 12" :key="m" :value="m" :label="m+' 月'" />
            </el-select>
            <el-button size="small" type="primary" plain @click="searchOrderMonth">查询该月接单</el-button>
          </div>

          <el-table size="small" :data="filteredTasks" stripe empty-text="该月暂无接单记录" style="margin-top:4px">
            <el-table-column prop="id" label="任务编号" width="160" />
            <el-table-column label="路线">
              <template #default="{row}">{{ row.origin }} → {{ row.destination }}</template>
            </el-table-column>
            <el-table-column prop="cargo" label="货物" width="90" />
            <el-table-column label="吨" width="55">
              <template #default="{row}">{{ row.weight }}</template>
            </el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{row}"><el-tag size="small">{{ row.status }}</el-tag></template>
            </el-table-column>
            <el-table-column label="TRIP(km)" width="90">
              <template #default="{row}">{{ row.trip_mileage != null ? row.trip_mileage : '—' }}</template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-if="filteredTasksTotal > taskPageSize"
            size="small" background layout="prev, pager, next, total"
            :total="filteredTasksTotal" :page-size="taskPageSize"
            v-model:current-page="taskPage" style="margin-top:8px;justify-content:flex-end;display:flex"
          />
        </el-col>

        <!-- ===== 右：出勤日历 ===== -->
        <el-col :span="10">
          <div class="section-title">📅 出勤日历 · {{ calYM.year }} 年 {{ calYM.month }} 月</div>

          <div class="calendar-week">
            <div v-for="w in attendWeekday" :key="w" class="week-cell">{{ w }}</div>
          </div>
          <div class="calendar-grid">
            <template v-for="(cell, i) in attendanceGrid" :key="i">
              <div v-if="cell.empty" class="cal-cell empty"></div>
              <div v-else class="cal-cell" :class="attendCellClass(cell.status)">
                <div class="d">{{ cell.date.slice(8) }}</div>
                <div class="s">{{ cell.status === '—' || cell.status === '未入职' ? '' : cell.status }}</div>
              </div>
            </template>
          </div>

          <div style="display:flex;gap:16px;margin-top:10px;font-size:12px;color:var(--color-muted)">
            <span><i class="dot attend-full"></i>出勤</span>
            <span><i class="dot attend-leave"></i>请假</span>
            <span><i class="dot attend-absent"></i>缺勤</span>
            <span><i class="dot attend-rest"></i>休假</span>
          </div>

          <!-- 月度汇总小卡片 -->
          <el-row :gutter="10" style="margin-top:12px">
            <el-col :span="6"><div class="mini-stat compact"><div class="mini-k">出勤</div><div class="mini-v c-success" style="font-size:20px">{{ data.attendance?.stats?.出勤 || 0 }}</div></div></el-col>
            <el-col :span="6"><div class="mini-stat compact"><div class="mini-k">请假</div><div class="mini-v c-warning" style="font-size:20px">{{ data.attendance?.stats?.请假 || 0 }}</div></div></el-col>
            <el-col :span="6"><div class="mini-stat compact"><div class="mini-k">缺勤</div><div class="mini-v c-danger" style="font-size:20px">{{ data.attendance?.stats?.缺勤 || 0 }}</div></div></el-col>
            <el-col :span="6"><div class="mini-stat compact"><div class="mini-k">休假</div><div class="mini-v c-info" style="font-size:20px">{{ data.attendance?.stats?.休假 || 0 }}</div></div></el-col>
          </el-row>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: 16px; display:flex; align-items:flex-end; justify-content:space-between; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.page-header p  { margin: 0; color: var(--color-muted, #909399); font-size: 13px; }

.mini-stat {
  padding: 12px 14px;
  background: var(--bg-page, #f5f7fa);
  border-radius: 8px;
}
.mini-stat.compact { padding: 8px 10px; text-align:center }
.mini-k { font-size: 12px; color: var(--color-muted, #909399) }
.mini-v { font-size: 26px; font-weight: 700; margin: 4px 0 }
.mini-hint { font-size: 11px; color: var(--color-muted, #909399) }
.c-primary { color: #409EFF }
.c-success { color: #67C23A }
.c-warning { color: #E6A23C }
.c-danger  { color: #F56C6C }
.c-info    { color: #909399 }

.section-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px dashed var(--border-color, #ebeef5) }

.calendar-week { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 4px }
.week-cell { text-align:center; font-size:12px; color:var(--color-muted, #909399); padding:6px 0 }
.calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px }
.cal-cell {
  border-radius: 6px; padding: 6px 8px; min-height: 48px;
  background: var(--bg-page, #f5f7fa);
  border: 1px solid var(--border-color, #ebeef5);
  display:flex; flex-direction:column; justify-content:space-between;
}
.cal-cell .d { font-weight:600; font-size:13px }
.cal-cell .s { font-size:11px }
.cal-cell.empty { background:transparent; border:none }
.cal-cell.attend-full   { background: rgba(103,194,58,.12); border-color: rgba(103,194,58,.3) }
.cal-cell.attend-full .s { color: #67C23A }
.cal-cell.attend-leave  { background: rgba(230,162,60,.12); border-color: rgba(230,162,60,.3) }
.cal-cell.attend-leave .s { color: #E6A23C }
.cal-cell.attend-absent { background: rgba(245,108,108,.1); border-color: rgba(245,108,108,.3) }
.cal-cell.attend-absent .s { color: #F56C6C }
.cal-cell.attend-rest   { background: rgba(144,147,153,.1); border-color: rgba(144,147,153,.3) }
.cal-cell.attend-rest .s { color: var(--color-muted, #606266) }

.dot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align: middle }
.dot.attend-full   { background:#67C23A }
.dot.attend-leave  { background:#E6A23C }
.dot.attend-absent { background:#F56C6C }
.dot.attend-rest   { background:#909399 }
</style>
