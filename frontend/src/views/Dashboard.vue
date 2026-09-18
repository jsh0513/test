<script setup lang="ts">
import { onMounted, ref, nextTick, computed, watch } from 'vue'
import * as echarts from 'echarts'
import { useRouter } from 'vue-router'
import { getOverview, getTaskStatus, getDriverStatus, getUrgentTasks } from '../api'
import { useUserStore } from '../stores/user'

const router = useRouter()
const userStore = useUserStore()
// 图表配色随夜间模式切换（深蓝主题用浅轴色）
const chartColors = computed(() => userStore.theme === 'dark'
  ? { axis: '#8ea3c0', label: '#aebdd6', split: 'rgba(255,255,255,0.08)', border: '#15273f' }
  : { axis: '#dcdfe6', label: '#606266', split: '#f0f2f5', border: '#fff' })
const overview = ref<any>({})
const taskStatus = ref<any>({})
const driverStatus = ref<any>({})
const urgentTasks = ref<any[]>([])

let statusChart: echarts.ECharts | null = null
let driverChart: echarts.ECharts | null = null

// R3: 司机状态统一新命名：在职→空闲，休息→请假
const driverStatusLegend: Record<string, string> = {
  请假: '#909399',   // 原"休息"
  空闲: '#67C23A',   // 原"在职"
  任务中: '#409EFF',
  已停用: '#F56C6C',
  休假: '#E6A23C',
  待审核: '#9B59B6',
}

async function load() {
  try {
    overview.value = await getOverview()
    taskStatus.value = await getTaskStatus()
    driverStatus.value = await getDriverStatus()
    const r = await getUrgentTasks()
    // 只预警「离任务倒计时不足 1 小时」的任务（timely === 'soon'），已超时的不在此列
    urgentTasks.value = (r.list || []).filter((t: any) => t.timely === 'soon')
  } catch (e) { console.error(e) }
  await nextTick()
  renderCharts()
}

function renderCharts() {
  // 任务状态分布（柱状图，移至右侧）
  const statusEl = document.getElementById('status-chart')
  if (statusEl) {
    statusChart?.dispose()
    statusChart = echarts.init(statusEl)
    const cats = Object.keys(taskStatus.value)
    const vals = Object.values(taskStatus.value) as number[]
    statusChart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 20, right: 20, top: 24, bottom: 36, containLabel: true },
      xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: chartColors.value.axis } }, axisLabel: { color: chartColors.value.label } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: chartColors.value.split } }, axisLabel: { color: chartColors.value.label } },
      series: [{
        type: 'bar', data: vals, barWidth: 44,
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: (p: any) => (['#E6A23C','#409EFF','#67C23A','#909399','#F56C6C'])[p.dataIndex % 5],
        },
      }],
    })
  }
  // 司机状态占比（饼图，放在左侧原7日趋势位置）
  const dEl = document.getElementById('driver-chart')
  if (dEl) {
    driverChart?.dispose()
    driverChart = echarts.init(dEl)
    const data = Object.keys(driverStatus.value).map(k => ({
      name: k,
      value: Number(driverStatus.value[k]) || 0,
      itemStyle: { color: driverStatusLegend[k] || '#409EFF' },
    }))
    const total = data.reduce((s, d) => s + d.value, 0)
    driverChart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: {
        orient: 'vertical', right: 10, top: 'center',
        textStyle: { color: chartColors.value.label, fontSize: 12 },
      },
      title: {
        text: `司机总数 ${total}`,
        left: 'center', top: 10,
        textStyle: { fontSize: 14, color: chartColors.value.label, fontWeight: 500 },
      },
      series: [{
        name: '司机状态',
        type: 'pie',
        radius: ['45%', '68%'],
        center: ['36%', '55%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: chartColors.value.border, borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data,
      }],
    })
  }
}

const taskLegendColor = computed(() => ({
  待派发: '#E6A23C', 进行中: '#409EFF', 已完成: '#67C23A', 已取消: '#909399', 已超时: '#F56C6C',
}))

function statusTag(s: string) {
  if (s === '已完成') return 'success'
  if (s === '进行中' || s === '待派发') return 'primary'
  if (s === '已超时') return 'danger'
  if (s === '已取消') return 'info'
  return 'warning'
}
function timelyTag(t: string) {
  if (t === 'overdue') return { type: 'danger', text: '已超时' }
  if (t === 'soon') return { type: 'warning', text: '即将超时' }
  return null
}
function urgentRowClass({ row }: { row: any }) {
  return (row && row.timely === 'overdue') ? 'row-danger' : 'row-warn'
}
function gotoTasks() { router.push('/tasks') }

onMounted(() => {
  load()
  window.addEventListener('resize', () => { statusChart?.resize(); driverChart?.resize() })
})

// 夜间模式切换后重绘图表，保证坐标轴/图例文字可见
watch(() => userStore.theme, () => { nextTick(renderCharts) })
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>数据概览</h2>
        <p>实时掌握本月任务预警与运行状态</p>
      </div>
    </div>

    <!-- 顶部 4 个统计卡：只显示数字（本月口径），不再显示注册司机总数 -->
    <el-row :gutter="16">
      <el-col v-for="s in [
        { label: '未被分配的任务总数', value: overview.unassigned_tasks ?? 0, color: '#E6A23C' },
        { label: '进行中任务',         value: overview.running_tasks ?? 0,    color: '#409EFF' },
        { label: '已完成任务',         value: overview.completed_tasks ?? 0,  color: '#67C23A' },
        { label: '已超时 / 即将超时',  value: (overview.overdue_tasks ?? 0) + (overview.soon_tasks ?? 0), color: '#F56C6C' },
      ]" :key="s.label" :span="6">
        <el-card class="stat-card" shadow="hover">
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-num" :style="{ color: s.color }">{{ s.value }}</div>
          <div class="stat-month-hint">（本月数据）</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 左侧：司机状态占比饼图；右侧：任务状态分布柱状图 -->
    <el-row :gutter="16" class="chart-row">
      <el-col :span="12">
        <el-card shadow="hover">
          <template #header>
            <div class="card-title">司机状态占比</div>
          </template>
          <div id="driver-chart" style="width:100%; height: 320px"></div>
          <div class="legend-row">
            <span v-for="(c,name) in driverStatusLegend" :key="name" class="leg">
              <i class="dot" :style="{background: c}"></i>
              {{ name }} {{ driverStatus[name] ?? 0 }}
            </span>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="hover">
          <template #header>
            <div class="card-title">任务状态分布</div>
          </template>
          <div id="status-chart" style="width:100%; height: 320px"></div>
          <div class="legend-row">
            <span v-for="(v,k) in taskStatus" :key="k" class="leg">
              <i class="dot" :style="{background: (taskLegendColor as any)[k]}"></i>
              {{ k }} {{ v }}
            </span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 即将超时的任务 / 已超时标红 -->
    <el-card shadow="hover">
      <template #header>
        <div class="flex-row">
          <div class="card-title">即将超时预警（倒计时不足 1 小时）</div>
          <el-button type="primary" size="small" @click="gotoTasks">前往派发中心</el-button>
        </div>
      </template>
      <el-table :data="urgentTasks" stripe style="width:100%" :row-class-name="urgentRowClass">
        <el-table-column prop="id" label="任务编号" width="180" />
        <el-table-column prop="driver_name" label="司机" width="110" />
        <el-table-column prop="origin" label="起点" />
        <el-table-column prop="destination" label="终点" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" effect="light">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时效预警" width="140">
          <template #default="{ row }">
            <template v-if="timelyTag(row.timely)">
              <el-tag :type="timelyTag(row.timely)!.type" effect="dark">
                {{ timelyTag(row.timely)!.text }}
              </el-tag>
            </template>
            <span v-else style="color:var(--color-muted,#909399)">正常</span>
          </template>
        </el-table-column>
        <el-table-column prop="create_time" label="创建时间" width="180" />
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.stat-card { min-height: 110px; }
.stat-label { font-size: 13px; color: var(--color-muted); }
.stat-num   { font-size: 34px; margin: 10px 0 6px; font-weight: 700; }
.stat-month-hint { font-size: 12px; color: var(--color-muted); }
.chart-row { margin-top: 16px; margin-bottom: 16px; }
.card-title { font-size: 15px; font-weight: 600; }
.flex-row { display: flex; align-items: center; justify-content: space-between; }
.legend-row { display: flex; flex-wrap: wrap; gap: 18px; padding: 10px 0 0; font-size: 12px; color: var(--color-text, #606266); }
.legend-row .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
:deep(.row-danger) td { background: rgba(245,108,108,0.12) !important; }
:deep(.row-warn)   td { background: rgba(230,162,60,0.12) !important; }
</style>
