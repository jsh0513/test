<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import { Search, Edit, View, Delete as Dl } from '@element-plus/icons-vue'
import { getDrivers, updateDriver, deleteDriver, toggleDriverDisable } from '../api'

const router = useRouter()
const userStore = useUserStore()

const loading = ref(false)
const tableData = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const search = reactive({ keyword: '', status: '', city: '' })

// R3: 状态严格使用新命名：空闲(原"在职")、请假(原"休息")，绝对不会再出现旧名称
// 管理员选项：空闲、请假、休假、任务中、已停用、待审核（后三个仅状态展示用，不允许调度员选择）
const statusOptionsAll = ['空闲', '请假', '休假', '任务中', '已停用', '待审核']
// 调度员选项：只能改空闲/请假/休假三个（不能改任务中/已停用/待审核，由系统自动或管理员操作）
const statusOptionsDispatcher = ['空闲', '请假', '休假']
const statusOptions = computed(() => userStore.isAdmin ? statusOptionsAll : statusOptionsDispatcher)
// 列表上方筛选器的状态选项（含所有可能状态，用于查看过滤）
const filterStatusList = ['空闲','请假','任务中','已停用','休假','待审核']

// R3: 兼容后端/缓存可能返回的旧命名（在职→空闲 / 休息→请假），任何入口都要做归一化
function normStatus(s: any): string {
  if (!s) return '空闲'
  if (s === '在职') return '空闲'
  if (s === '休息') return '请假'
  return String(s)
}

async function fetch() {
  loading.value = true
  try {
    const r = await getDrivers({ page: page.value, pageSize: pageSize.value, ...search })
    // 强制归一化每条司机的 status 显示名，杜绝"在职/休息"旧名漏网
    tableData.value = (r.list || []).map((d: any) => ({ ...d, status: normStatus(d.status) }))
    total.value = r.total || 0
  } finally { loading.value = false }
}
onMounted(fetch)
function onSearch() { page.value = 1; fetch() }

const addVisible = ref(false)
const editing: any = ref(null)
const form = reactive({ name: '', phone: '', plate: '', city: '', vehicle_type: '', status: '空闲' })

function openEdit(row: any) {
  // R5: 调度员无法编辑已停用司机
  if (!userStore.isAdmin && normStatus(row.status) === '已停用') {
    return ElMessage.warning('调度员不能编辑已停用人员，请联系管理员启用')
  }
  editing.value = { ...row }
  Object.assign(form, {
    name: row.name, phone: row.phone, plate: row.plate,
    city: row.city, vehicle_type: row.vehicle_type,
    // R3: 打开编辑时先归一化旧名，确保下拉框正确匹配当前值
    status: normStatus(row.status),
  })
  addVisible.value = true
}

async function saveForm() {
  if (!editing.value) return
  if (!form.name || !form.phone || !form.plate) {
    return ElMessage.warning('请填写姓名、手机、车牌号')
  }
  // R3: 保存前再一次归一化 status，确保调度员不小心选了旧名也不会存入后端
  const outStatus = normStatus(form.status)
  if (!userStore.isAdmin && ['已停用', '待审核', '任务中'].includes(outStatus)) {
    return ElMessage.warning('调度员不能将司机设为「已停用 / 待审核 / 任务中」')
  }
  try {
    await updateDriver(editing.value.id, { ...form, status: outStatus })
    ElMessage.success('修改成功（变更日志已记录）')
    addVisible.value = false
    fetch()
  } catch (_) {}
}

function doDelete(row: any) {
  ElMessageBox.confirm(`确认删除司机「${row.name}」(${row.plate})？`, '删除确认', { type: 'warning' })
    .then(async () => {
      try {
        await deleteDriver(row.id)
        ElMessage.success('删除成功（变更日志已记录）')
        fetch()
      } catch (_) {}
    }).catch(() => {})
}

// R5: 停用/启用 —— 管理员有启用权；调度员只能停用（空闲人员），不能启用
async function toggleDisabled(row: any) {
  const isDisabledNow = row.status === '已停用'
  const actionText = isDisabledNow ? '启用' : '停用'
  const targetStatus = isDisabledNow ? '空闲' : '已停用'
  if (!userStore.isAdmin && isDisabledNow) {
    return ElMessage.warning('调度员不能启用已停用司机，请联系管理员')
  }
  if (!userStore.isAdmin && row.status === '任务中') {
    return ElMessage.warning('任务中司机不能停用')
  }
  try {
    await ElMessageBox.confirm(
      `确认${actionText}司机「${row.name}」(${row.plate})？${actionText}后状态将变为「${targetStatus}」`,
      `${actionText}司机确认`, { type: 'warning' }
    )
    await toggleDriverDisable(row.id)
    ElMessage.success(`${actionText}成功（变更日志已记录）`)
    fetch()
  } catch (_) {}
}

function goDetail(row: any) {
  router.push(`/drivers/${row.id}`)
}

function statusTagType(s: string) {
  return ({
    空闲: 'success', 任务中: 'primary', 请假: 'info',
    休假: 'warning', 待审核: 'warning', 已停用: 'danger',
  } as Record<string, string>)[s] || 'info'
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>司机管理</h2>
        <p>查询、编辑司机；「详情统计」可跳独立页查看出勤、保修、违章等完整数据（新增司机入口已移至「人员变动」模块）</p>
      </div>
    </div>

    <el-card style="margin-bottom: 16px">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字"><el-input v-model="search.keyword" placeholder="姓名/手机/车牌" :prefix-icon="Search" clearable /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="search.status" placeholder="全部" clearable style="width:150px">
            <el-option v-for="s in filterStatusList" :key="s" :value="s" :label="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="城市"><el-input v-model="search.city" clearable /></el-form-item>
        <el-form-item>
          <el-button type="primary" @click="onSearch">查询</el-button>
          <el-button @click="search.keyword = search.status = search.city = ''; onSearch()">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table :data="tableData" v-loading="loading" stripe style="width:100%">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="name" label="司机姓名" width="100">
          <template #default="{row}">
            <div style="display:flex;align-items:center;gap:8px">
              <el-avatar :size="26" style="background:#409EFF;color:#fff">{{ row.name?.charAt(0) }}</el-avatar>
              <span style="font-weight:500">{{ row.name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column prop="plate" label="车牌号" width="120" />
        <el-table-column prop="city" label="所在城市" width="100" />
        <el-table-column prop="vehicle_type" label="车辆类型" width="110" />
        <el-table-column label="状态" width="90">
          <template #default="{row}">
            <el-tag :type="statusTagType(row.status)" effect="light" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="join_date" label="入职日期" width="120" />
        <el-table-column label="操作" width="420" fixed="right">
          <template #default="{row}">
            <el-button size="small" type="primary" link :icon="View" @click="goDetail(row)">详情统计</el-button>
            <el-button
              size="small" type="primary" link :icon="Edit"
              :disabled="!userStore.isAdmin && row.status==='已停用'"
              @click="openEdit(row)"
            >编辑</el-button>
            <el-button v-if="userStore.isAdmin" size="small" type="danger" link :icon="Dl" @click="doDelete(row)">删除</el-button>
            <!-- R5：管理员/调度员都有停用按钮；但调度员无法启用已停用人员 -->
            <el-button
              size="small" type="warning" link
              :disabled="(!userStore.isAdmin && row.status==='已停用') || row.status==='任务中'"
              @click="toggleDisabled(row)"
            >
              {{ row.status === '已停用' ? '启用' : '停用' }}
            </el-button>
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

    <el-dialog v-model="addVisible" title="编辑司机" width="560px">
      <el-form :model="form" label-width="100px">
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="姓名"><el-input v-model="form.name" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="手机号"><el-input v-model="form.phone" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="车牌号"><el-input v-model="form.plate" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="所在城市"><el-input v-model="form.city" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="车辆类型">
              <el-select v-model="form.vehicle_type" placeholder="请选择" style="width:100%">
                <el-option v-for="v in ['厢式货车','平板车','冷链车','半挂']" :key="v" :label="v" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-select v-model="form.status" placeholder="选择状态" style="width:100%">
                <el-option v-for="s in statusOptions" :key="s" :value="s" :label="s" />
              </el-select>
              <div style="font-size:12px;color:var(--color-muted);margin-top:3px">
                {{ userStore.isAdmin ? '管理员可自由切换空闲/请假/休假/已停用' : '调度员可改：空闲、请假、休假（调度员无法编辑已停用司机）' }}
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" @click="saveForm">保存修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.page-header p { margin: 0; color: var(--color-muted, #909399); font-size: 13px; }
</style>
