<script setup lang="ts">
import { reactive, ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getTasks, getHistoryTasks, getDrivers,
  exportTasksExcel, exportAttendanceExcel, exportReconciliationExcel,
} from '../api'

const activeTab = ref('tasks')  // tasks | attendance | reconciliation

// 三表统一：每 10 条显示一页（前端分页）
const PAGE_SIZE = 10
const taskPage = ref(1)
const driverPage = ref(1)
const reconPage = ref(1)

// 与任务全流程状态一致：待派发 → 待发车 → 进行中 / 已超时 → 已完成 / 已取消
const statusOptions = ['待派发','待发车','进行中','已超时','已完成','已取消']
const statusTagType = (s: string) =>
  (({ 待派发:'info', 待发车:'warning', 进行中:'primary', 已超时:'danger', 已完成:'success', 已取消:'info' }) as any)[s] || 'info'

// ============ Tab1：任务记录导出 ============
const taskFilter = reactive({ keyword: '', status: '', start_date: '', end_date: '' })
const taskList = ref<any[]>([])
const taskLoading = ref(false)
const taskSelected = ref<string[]>([])
async function loadTasks() {
  taskLoading.value = true
  taskSelected.value = []
  taskPage.value = 1
  try {
    // R7 修复：并行查询 + 严格 try/catch，确保 loading 必然复位，避免"一进去就转圈"
    const [active, history] = await Promise.all([
      getTasks({ ...taskFilter, page: 1, pageSize: 500, status: taskFilter.status }).catch(() => ({ list: [] })),
      getHistoryTasks({ ...taskFilter, page: 1, pageSize: 500 }).catch(() => ({ list: [] })),
    ])
    const merged = [...((active as any).list || []), ...((history as any).list || [])]
    const seen = new Set<string>()
    taskList.value = merged.filter((t) => {
      if (!t || !t.id) return false
      if (seen.has(t.id)) return false
      seen.add(t.id)
      if (taskFilter.status && (t.effective_status || t.status) !== taskFilter.status) return false
      return true
    }).sort((a, b) => (b.create_time || '').localeCompare(a.create_time || ''))
  } catch (e: any) {
    taskList.value = []
  } finally { taskLoading.value = false }
}
function taskDownloadAll() {
  const p: any = {}
  if (taskFilter.keyword) p.keyword = taskFilter.keyword
  if (taskFilter.status)  p.status = taskFilter.status
  if (taskFilter.start_date) p.start_date = taskFilter.start_date
  if (taskFilter.end_date)   p.end_date = taskFilter.end_date
  exportTasksExcel(p, [])
  ElMessage.success('任务记录（全部）下载已开始')
}
function taskDownloadSelected() {
  if (!taskSelected.value.length) return ElMessage.warning('请先勾选需要下载的任务')
  exportTasksExcel({}, taskSelected.value)
  ElMessage.success(`已选择 ${taskSelected.value.length} 条，下载已开始`)
}

// ============ Tab2：员工出勤记录导出 ============
const attFilter = reactive({ keyword: '', year: new Date().getFullYear(), month: new Date().getMonth() + 1 })
const driverList = ref<any[]>([])
const driverLoading = ref(false)
const driverSelected = ref<number[]>([])
async function loadDrivers() {
  driverLoading.value = true
  driverSelected.value = []
  driverPage.value = 1
  try {
    const r = await getDrivers({
      page: 1, pageSize: 500,
      keyword: attFilter.keyword,
    }).catch(() => ({ list: [] }))
    driverList.value = (r as any).list || []
  } catch (e: any) {
    driverList.value = []
  } finally { driverLoading.value = false }
}
function attDownloadAll() {
  const p: any = { year: attFilter.year, month: attFilter.month }
  exportAttendanceExcel(p, [])
  ElMessage.success('员工出勤记录（全部）下载已开始')
}
function attDownloadSelected() {
  if (!driverSelected.value.length) return ElMessage.warning('请先勾选需要导出的司机')
  exportAttendanceExcel({ year: attFilter.year, month: attFilter.month }, driverSelected.value)
  ElMessage.success(`已选择 ${driverSelected.value.length} 名司机，下载已开始`)
}

// ============ Tab3：订单 / 运单对账表导出 ============
const reconFilter = reactive({ keyword: '', status: '', start_date: '', end_date: '' })
const reconList = ref<any[]>([])
const reconLoading = ref(false)
const reconSelected = ref<string[]>([])
async function loadRecon() {
  reconLoading.value = true
  reconSelected.value = []
  reconPage.value = 1
  try {
    const [active, history] = await Promise.all([
      getTasks({ ...reconFilter, page: 1, pageSize: 500, status: reconFilter.status }).catch(() => ({ list: [] })),
      getHistoryTasks({ ...reconFilter, page: 1, pageSize: 500 }).catch(() => ({ list: [] })),
    ])
    const merged = [...((active as any).list || []), ...((history as any).list || [])]
    const seen = new Set<string>()
    reconList.value = merged.filter((t) => {
      if (!t || !t.id) return false
      if (seen.has(t.id)) return false
      seen.add(t.id)
      if (reconFilter.status && (t.effective_status || t.status) !== reconFilter.status) return false
      return true
    }).sort((a, b) => (b.create_time || '').localeCompare(a.create_time || ''))
  } catch (e: any) {
    reconList.value = []
  } finally { reconLoading.value = false }
}
function reconDownloadAll() {
  const p: any = {}
  if (reconFilter.keyword) p.keyword = reconFilter.keyword
  if (reconFilter.status)  p.status = reconFilter.status
  if (reconFilter.start_date) p.start_date = reconFilter.start_date
  if (reconFilter.end_date)   p.end_date = reconFilter.end_date
  exportReconciliationExcel(p, [])
  ElMessage.success('订单/运单对账表（全部）下载已开始')
}
function reconDownloadSelected() {
  if (!reconSelected.value.length) return ElMessage.warning('请先勾选需要导出的任务')
  exportReconciliationExcel({}, reconSelected.value)
  ElMessage.success(`已选择 ${reconSelected.value.length} 条，下载已开始`)
}

// Tab 切换时加载：出勤/对账首次切换立即加载，保证"点进去就能看到默认全部信息"
onMounted(() => {
  loadTasks()
})
function onTabChange(name: string | number) {
  if (name === 'attendance' && !driverList.value.length && !driverLoading.value) loadDrivers()
  if (name === 'reconciliation' && !reconList.value.length && !reconLoading.value) loadRecon()
}

// 前端分页切片（每页 10 条）
const pagedTaskList = computed(() =>
  taskList.value.slice((taskPage.value - 1) * PAGE_SIZE, taskPage.value * PAGE_SIZE))
const pagedDriverList = computed(() =>
  driverList.value.slice((driverPage.value - 1) * PAGE_SIZE, driverPage.value * PAGE_SIZE))
const pagedReconList = computed(() =>
  reconList.value.slice((reconPage.value - 1) * PAGE_SIZE, reconPage.value * PAGE_SIZE))

const years = computed(() => {
  const y = new Date().getFullYear()
  return [y - 1, y, y + 1]
})
const months = Array.from({ length: 12 }, (_, i) => i + 1)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>数据查询统计</h2>
        <p>管理员与调度员均可使用。支持三类数据导出：任务记录、员工出勤、订单 / 运单对账表；可下载全部或仅下载已勾选。</p>
      </div>
    </div>

    <el-card shadow="hover">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <!-- ============ Tab1：任务记录导出 ============ -->
        <el-tab-pane label="📋 任务记录导出" name="tasks">
          <!-- 筛选 -->
          <el-form :inline="true" :model="taskFilter" label-width="90px" class="filter-form">
            <el-form-item label="关键字">
              <el-input v-model="taskFilter.keyword" placeholder="任务编号 / 起点 / 终点" clearable style="width:240px" />
            </el-form-item>
            <el-form-item label="任务状态">
              <el-select v-model="taskFilter.status" clearable placeholder="全部" style="width:160px">
                <el-option v-for="s in statusOptions" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
            <el-form-item label="时间范围">
              <el-date-picker v-model="taskFilter.start_date" value-format="YYYY-MM-DD" placeholder="开始" style="width:140px" />
              <span style="margin:0 6px;color:var(--color-muted,#c0c4cc)">至</span>
              <el-date-picker v-model="taskFilter.end_date" value-format="YYYY-MM-DD" placeholder="结束" style="width:140px" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="loadTasks">🔍 查询</el-button>
              <el-button @click="taskFilter.keyword='';taskFilter.status='';taskFilter.start_date='';taskFilter.end_date='';loadTasks()">重置</el-button>
            </el-form-item>
          </el-form>
          <!-- 导出按钮栏 -->
          <div class="action-bar">
            <el-tag type="info" effect="plain">共 {{ taskList.length }} 条，已选 {{ taskSelected.length }} 条</el-tag>
            <div>
              <el-button type="success" plain @click="taskDownloadSelected">⬇️ 下载（已选）</el-button>
              <el-button type="primary" @click="taskDownloadAll">⬇️ 下载全部</el-button>
            </div>
          </div>
          <!-- 任务表 -->
          <el-table
            :data="pagedTaskList" v-loading="taskLoading"
            stripe border style="width:100%" row-key="id"
            @selection-change="(v: any[]) => taskSelected = v.map(x => x.id)"
          >
            <el-table-column type="selection" width="46" reserve-selection />
            <el-table-column prop="id" label="任务编号" width="160" />
            <el-table-column label="起-终点" width="220">
              <template #default="{row}">{{ row.origin }} → {{ row.destination }}</template>
            </el-table-column>
            <el-table-column prop="cargo" label="货物" width="100" />
            <el-table-column prop="weight" label="吨" width="60" />
            <el-table-column label="状态" width="90">
              <template #default="{row}">
                <el-tag size="small" :type="statusTagType(row.effective_status || row.status)">
                  {{ row.effective_status || row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="司机" width="90" prop="driver_name" />
            <el-table-column label="运费(元)" width="90" align="right">
              <template #default="{row}">¥ {{ row.freight || 0 }}</template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="150" />
          </el-table>
          <el-pagination
            v-if="taskList.length > PAGE_SIZE"
            background layout="prev, pager, next, total"
            :total="taskList.length" :page-size="PAGE_SIZE" :pager-count="7"
            v-model:current-page="taskPage" style="margin-top:10px;justify-content:flex-end;display:flex"
          />
        </el-tab-pane>

        <!-- ============ Tab2：员工出勤记录导出 ============ -->
        <el-tab-pane label="🧑‍💼 员工出勤记录导出" name="attendance">
          <el-form :inline="true" :model="attFilter" label-width="90px" class="filter-form">
            <el-form-item label="关键字">
              <el-input v-model="attFilter.keyword" placeholder="司机姓名 / 车牌 / 城市" clearable style="width:240px" />
            </el-form-item>
            <el-form-item label="年份">
              <el-select v-model="attFilter.year" style="width:120px">
                <el-option v-for="y in years" :key="y" :label="y + ' 年'" :value="y" />
              </el-select>
            </el-form-item>
            <el-form-item label="月份">
              <el-select v-model="attFilter.month" style="width:120px">
                <el-option v-for="m in months" :key="m" :label="m + ' 月'" :value="m" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="loadDrivers">🔍 查询</el-button>
              <el-button @click="attFilter.keyword='';attFilter.year=new Date().getFullYear();attFilter.month=new Date().getMonth()+1;loadDrivers()">重置</el-button>
            </el-form-item>
          </el-form>
          <div class="action-bar">
            <el-tag type="info" effect="plain">共 {{ driverList.length }} 名司机，已选 {{ driverSelected.length }} 名 · 导出月份：{{ attFilter.year }}-{{ String(attFilter.month).padStart(2,'0') }}</el-tag>
            <div>
              <el-button type="success" plain @click="attDownloadSelected">⬇️ 下载（已选）</el-button>
              <el-button type="primary" @click="attDownloadAll">⬇️ 下载全部</el-button>
            </div>
          </div>
          <el-table
            :data="pagedDriverList" v-loading="driverLoading"
            stripe border style="width:100%" row-key="id"
            @selection-change="(v: any[]) => driverSelected = v.map(x => x.id)"
          >
            <el-table-column type="selection" width="46" reserve-selection />
            <el-table-column prop="id" label="ID" width="60" />
            <el-table-column prop="name" label="司机" width="100" />
            <el-table-column prop="phone" label="手机号" width="140" />
            <el-table-column prop="plate" label="车牌" width="120" />
            <el-table-column prop="vehicle_type" label="车型" width="100" />
            <el-table-column prop="city" label="所在城市" width="110" />
            <el-table-column label="状态" width="90">
              <template #default="{row}">
                <el-tag size="small" :type="({空闲:'success',请假:'info',休假:'warning',任务中:'primary',已停用:'danger',待审核:'warning'} as any)[row.status] || 'info'">
                  {{ row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="join_date" label="入职日期" width="120" />
          </el-table>
          <el-pagination
            v-if="driverList.length > PAGE_SIZE"
            background layout="prev, pager, next, total"
            :total="driverList.length" :page-size="PAGE_SIZE" :pager-count="7"
            v-model:current-page="driverPage" style="margin-top:10px;justify-content:flex-end;display:flex"
          />
        </el-tab-pane>

        <!-- ============ Tab3：订单 / 运单对账表导出 ============ -->
        <el-tab-pane label="🧾 订单 / 运单对账表导出" name="reconciliation">
          <el-form :inline="true" :model="reconFilter" label-width="90px" class="filter-form">
            <el-form-item label="关键字">
              <el-input v-model="reconFilter.keyword" placeholder="任务编号 / 起点 / 终点" clearable style="width:240px" />
            </el-form-item>
            <el-form-item label="任务状态">
              <el-select v-model="reconFilter.status" clearable placeholder="全部" style="width:160px">
                <el-option v-for="s in statusOptions" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
            <el-form-item label="时间范围">
              <el-date-picker v-model="reconFilter.start_date" value-format="YYYY-MM-DD" placeholder="开始" style="width:140px" />
              <span style="margin:0 6px;color:var(--color-muted,#c0c4cc)">至</span>
              <el-date-picker v-model="reconFilter.end_date" value-format="YYYY-MM-DD" placeholder="结束" style="width:140px" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="loadRecon">🔍 查询</el-button>
              <el-button @click="reconFilter.keyword='';reconFilter.status='';reconFilter.start_date='';reconFilter.end_date='';loadRecon()">重置</el-button>
            </el-form-item>
          </el-form>
          <div class="action-bar">
            <el-tag type="info" effect="plain">共 {{ reconList.length }} 条，已选 {{ reconSelected.length }} 条</el-tag>
            <div>
              <el-button type="success" plain @click="reconDownloadSelected">⬇️ 下载（已选）</el-button>
              <el-button type="primary" @click="reconDownloadAll">⬇️ 下载全部</el-button>
            </div>
          </div>
          <el-table
            :data="pagedReconList" v-loading="reconLoading"
            stripe border style="width:100%" row-key="id"
            @selection-change="(v: any[]) => reconSelected = v.map(x => x.id)"
          >
            <el-table-column type="selection" width="46" reserve-selection />
            <el-table-column prop="id" label="任务编号" width="160" />
            <el-table-column label="起-终点" width="220">
              <template #default="{row}">{{ row.origin }} → {{ row.destination }}</template>
            </el-table-column>
            <el-table-column label="司机/车牌" width="170">
              <template #default="{row}">{{ row.driver_name || '-' }}</template>
            </el-table-column>
            <el-table-column prop="cargo" label="货物" width="100" />
            <el-table-column label="运费(元)" width="100" align="right">
              <template #default="{row}"><b style="color:#E6A23C">¥ {{ row.freight || 0 }}</b></template>
            </el-table-column>
            <el-table-column label="加急" width="70" align="center">
              <template #default="{row}">
                <el-tag v-if="row.is_urgent" type="danger" effect="light" size="small">加急</el-tag>
                <span v-else style="color:var(--color-muted,#c0c4cc)">—</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{row}">
                <el-tag size="small" :type="statusTagType(row.effective_status || row.status)">
                  {{ row.effective_status || row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="complete_time" label="完成时间" width="150">
              <template #default="{row}">{{ row.complete_time || '—' }}</template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-if="reconList.length > PAGE_SIZE"
            background layout="prev, pager, next, total"
            :total="reconList.length" :page-size="PAGE_SIZE" :pager-count="7"
            v-model:current-page="reconPage" style="margin-top:10px;justify-content:flex-end;display:flex"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.page-header p { margin: 0; color: var(--color-muted, #909399); font-size: 13px; }

.filter-form {
  border-bottom: 1px dashed #ebeef5;
  padding-bottom: 8px;
  margin-bottom: 0;
}
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
}
</style>
