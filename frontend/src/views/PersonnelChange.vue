<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Close, User } from '@element-plus/icons-vue'
import { getPendingDrivers, auditDriver, createDriver, getDriverChangeLogs, getAccountLogs } from '../api'
import { useUserStore } from '../stores/user'

const userStore = useUserStore()

const list = ref<any[]>([])
const loading = ref(false)
const total = ref(0)
const query = reactive({ page: 1, pageSize: 10 })

// 当前 Tab：pending（待审核）/ logs（司机状态变更）/ account（账号操作记录）
const activeTab = ref('pending')

// 司机状态变更记录（管理员页面）
const changeLogs = ref<any[]>([])
const logsLoading = ref(false)
const logsTotal = ref(0)
const logsQuery = reactive({ page: 1, pageSize: 10 })

// 账号操作记录（管理员页面）
const accountLogs = ref<any[]>([])
const accountLoading = ref(false)
const accountTotal = ref(0)
const accountQuery = reactive({ page: 1, pageSize: 10 })

const FIELD_LABELS: Record<string, string> = {
  name: '姓名', phone: '手机号', plate: '车牌号', city: '所在城市',
  vehicle_type: '车辆类型', status: '状态', audit_status: '审核状态',
  age: '年龄', gender: '性别', id_card: '身份证', last_maintenance: '保修时间',
  reason: '驳回原因',
}
const STATUS_LABELS: Record<string, string> = {
  pending: '待审核', approved: '已通过', rejected: '已驳回',
}
function fieldLabel(k: string) { return FIELD_LABELS[k] || k }
function fieldVal(k: string, v: any) {
  if (v === undefined || v === null || v === '') return '空'
  if (k === 'audit_status') return STATUS_LABELS[String(v)] || String(v)
  return String(v)
}
// 把一条日志的 before/after 拼成 "字段：旧值 → 新值"
function logChanges(row: any): string[] {
  if (row.action === 'delete') return ['该司机已被删除']
  const keys = row.changed_keys && row.changed_keys.length ? row.changed_keys : Object.keys(row.after || {})
  return keys.map((k: string) => {
    const b = row.before && k in row.before ? fieldVal(k, row.before[k]) : '空'
    const a = row.after && k in row.after ? fieldVal(k, row.after[k]) : '空'
    return `${fieldLabel(k)}：${b} → ${a}`
  })
}
function logTagType(action: string) {
  if (action === 'audit_pass' || action === 'enable') return 'success'
  if (action === 'disable' || action === 'delete' || action === 'audit_reject') return 'danger'
  if (action === 'maintenance') return 'warning'
  return 'info'
}

// 调度员提交新司机用表单
const formVisible = ref(false)
const formRef = ref<any>(null)
const form = reactive({
  name: '', phone: '', plate: '', city: '', vehicle_type: '厢式货车', age: 30,
})
const submitting = ref(false)
const vehicleOptions = ['厢式货车', '平板车', '冷链车', '半挂']
const rules = {
  name: [{ required: true, message: '请填写司机姓名', trigger: 'blur' }],
  phone: [{ required: true, pattern: /^1\d{10}$/, message: '请填写 11 位手机号', trigger: 'blur' }],
  plate: [{ required: true, message: '请填写车牌号', trigger: 'blur' }],
}

async function load() {
  loading.value = true
  try {
    const r = await getPendingDrivers(query)
    list.value = r.list || []
    total.value = r.total ?? 0
  } catch (_) {
    list.value = []; total.value = 0
  } finally {
    loading.value = false
  }
}

// 司机状态变更记录（仅管理员）
async function loadLogs() {
  logsLoading.value = true
  try {
    const r = await getDriverChangeLogs(logsQuery)
    changeLogs.value = r.list || []
    logsTotal.value = r.total ?? 0
  } catch (_) {
    changeLogs.value = []; logsTotal.value = 0
  } finally {
    logsLoading.value = false
  }
}

// 账号操作记录（仅管理员）
async function loadAccountLogs() {
  accountLoading.value = true
  try {
    const r = await getAccountLogs(accountQuery)
    accountLogs.value = r.list || []
    accountTotal.value = r.total ?? 0
  } catch (_) {
    accountLogs.value = []; accountTotal.value = 0
  } finally {
    accountLoading.value = false
  }
}

// 切换 Tab 时按需加载
watch(activeTab, (t) => {
  if (t === 'logs' && userStore.isAdmin) loadLogs()
  if (t === 'account' && userStore.isAdmin) loadAccountLogs()
})

// 分页切换时重新加载对应列表
watch(() => query.page, load)
watch(() => logsQuery.page, loadLogs)
watch(() => accountQuery.page, loadAccountLogs)

function accountActionTag(action: string) {
  if (action === 'create') return { type: 'success', text: '创建账号' }
  if (action === 'change_password') return { type: 'warning', text: '密码修改' }
  if (action === 'edit_info') return { type: 'primary', text: '信息修改' }
  if (action === 'role_change') return { type: 'warning', text: '角色调整' }
  if (action === 'delete') return { type: 'danger', text: '删除账号' }
  return { type: 'info', text: ACCOUNT_ACTION_FALLBACK[action] || action }
}
// 兜底中文映射，确保任何情况下操作类型都不出现英文
const ACCOUNT_ACTION_FALLBACK: Record<string, string> = {
  create: '创建账号', edit_info: '信息修改', change_password: '密码修改',
  delete: '删除账号', role_change: '角色调整',
}
const DRIVER_ACTION_FALLBACK: Record<string, string> = {
  edit: '编辑信息', audit_pass: '审核通过', audit_reject: '审核驳回',
  disable: '状态变更(停用)', enable: '状态变更(启用)', delete: '删除司机',
  auto_city: '同步城市', maintenance: '保修信息', status_change: '状态变更',
}
function driverActionText(row: any) {
  return row.action_label || DRIVER_ACTION_FALLBACK[row.action] || '其他操作'
}

function statusTag(s: string) {
  if (s === '待审核') return { type: 'warning', text: s }
  if (s === '在职') return { type: 'success', text: s }
  if (s === '已停用') return { type: 'info', text: s }
  if (s === '休假') return { type: '', text: s }
  return { type: 'info', text: s }
}

async function approve(row: any) {
  try {
    await ElMessageBox.confirm(
      `确认通过司机「${row.name}(${row.plate})」的注册申请？通过后司机状态将变更为「在职」，可接收任务。`,
      '审核通过确认',
      { confirmButtonText: '通过审核', cancelButtonText: '取消', type: 'success' }
    )
    await auditDriver(row.id, true)
    ElMessage.success(`司机「${row.name}」已通过审核，状态已变更为在职`)
    load()
  } catch (e: any) {
    if (e !== 'cancel') console.error(e)
  }
}

async function reject(row: any) {
  try {
    // 驳回不再要求填写原因
    await ElMessageBox.confirm(
      `确认驳回司机「${row.name}(${row.plate})」的注册申请？驳回后司机状态将变更为「已停用」。`,
      '驳回注册申请',
      { confirmButtonText: '确认驳回', cancelButtonText: '取消', type: 'warning' }
    )
    await auditDriver(row.id, false)
    ElMessage.warning(`已驳回司机「${row.name}」，状态已变更为已停用`)
    load()
  } catch (e: any) {
    if (e !== 'cancel') console.error(e)
  }
}

// ---------- 调度员：录入新司机 ----------
function openSubmitForm() {
  Object.assign(form, { name: '', phone: '', plate: '', city: '', vehicle_type: '厢式货车', age: 30 })
  formVisible.value = true
}
async function submitDriver() {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch (_) { return }
  try {
    submitting.value = true
    await createDriver({ ...form, status: '待审核', audit_status: 'pending' })
    ElMessage.success('已提交司机注册申请，请等待超级管理员审核。系统已通知管理员。')
    formVisible.value = false
    load()
  } catch (_) {
  } finally {
    submitting.value = false
  }
}

onMounted(() => { load() })
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>人员变动
          <el-tag v-if="userStore.isAdmin" type="danger" size="small" effect="light" style="margin-left:8px">超级管理员：审核</el-tag>
          <el-tag v-else type="warning" size="small" effect="light" style="margin-left:8px">调度员：录入申请</el-tag>
        </h2>
        <p v-if="userStore.isAdmin">审核调度员录入的新司机注册申请。通过后司机状态变为「在职」，可被派发任务。</p>
        <p v-else>在此录入新司机资料并提交注册申请，由超级管理员审核通过后方可上岗接单。</p>
      </div>
      <div>
        <el-button v-if="!userStore.isAdmin" type="primary" :icon="User" @click="openSubmitForm">➕ 录入新司机注册申请</el-button>
        <el-button plain @click="load">🔄 刷新列表</el-button>
      </div>
    </div>

    <!-- 调度员提交表单弹窗 -->
    <el-dialog v-if="!userStore.isAdmin" v-model="formVisible" title="录入新司机注册申请（调度员专属）" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="司机姓名" prop="name"><el-input v-model="form.name" placeholder="请输入姓名" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="手机号" prop="phone"><el-input v-model="form.phone" placeholder="11 位手机号" maxlength="11" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="车牌号" prop="plate"><el-input v-model="form.plate" placeholder="如：浙A-12345" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="所在城市"><el-input v-model="form.city" placeholder="如：杭州" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="车辆类型">
              <el-select v-model="form.vehicle_type" style="width:100%">
                <el-option v-for="v in vehicleOptions" :key="v" :label="v" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="年龄"><el-input-number v-model="form.age" :min="18" :max="70" style="width:100%" /></el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="formVisible=false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitDriver">提交注册申请</el-button>
      </template>
    </el-dialog>

    <!-- 导航菜单式 Tab：待审核司机 / 司机状态变更记录 / 账号操作记录 -->
    <el-card shadow="hover">
      <el-tabs v-model="activeTab">
        <!-- Tab 1：待审核司机列表 -->
        <el-tab-pane label="待审核司机" name="pending">
          <el-alert
            :title="userStore.isAdmin
              ? '说明：审核通过后，司机状态从「待审核」→「在职」；驳回后状态变为「已停用」。'
              : '说明：您所提交的注册申请会出现在下方列表中，等待超级管理员审核。'"
            type="info" :closable="false" show-icon size="small" style="margin-bottom:12px"
          />
          <el-table :data="list" stripe v-loading="loading" border style="width:100%">
            <el-table-column prop="id" label="编号" width="70" />
            <el-table-column prop="name" label="司机姓名" width="110">
              <template #default="{ row }">
                <div style="display:flex;align-items:center;gap:6px">
                  <el-avatar :size="24" style="background:#409EFF;color:#fff">{{ row.name?.charAt?.(0) || 'U' }}</el-avatar>
                  <b>{{ row.name }}</b>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="phone" label="手机号" width="140" />
            <el-table-column prop="plate" label="车牌号" width="130" />
            <el-table-column prop="vehicle_type" label="车型" width="120" />
            <el-table-column prop="city" label="所在城市" width="110" />
            <el-table-column prop="join_date" label="注册日期" width="120" />
            <el-table-column prop="age" label="年龄" width="80" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="(statusTag(row.status) as any).type" effect="light">{{ statusTag(row.status).text }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column v-if="userStore.isAdmin" label="操作" width="240">
              <template #default="{ row }">
                <el-button type="success" size="small" :icon="Check" @click="approve(row)">✅ 同意注册</el-button>
                <el-button type="danger" size="small" plain :icon="Close" @click="reject(row)">驳回</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!loading && list.length === 0"
            :description="userStore.isAdmin ? '暂无待审核的司机申请' : '暂无申请记录，点击右上角「录入新司机注册申请」开始'">
            <el-button v-if="!userStore.isAdmin" type="primary" @click="openSubmitForm">录入新司机注册申请</el-button>
            <el-button v-else type="primary" @click="$router.push('/drivers')">前往司机管理</el-button>
          </el-empty>
          <div v-if="total > 0" class="tab-pagination">
            <el-pagination
              v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
              layout="total, prev, pager, next" :pager-count="5" background />
          </div>
        </el-tab-pane>

        <!-- Tab 2：司机状态变更记录（仅管理员） -->
        <el-tab-pane v-if="userStore.isAdmin" label="司机状态变更记录" name="logs">
          <div class="tab-toolbar">
            <span class="tab-tip">司机编辑 / 审核 / 停用启用 / 删除 / 保修等操作留痕</span>
          </div>
          <el-table :data="changeLogs" stripe border size="small" style="width:100%" v-loading="logsLoading">
            <el-table-column prop="time" label="时间" width="160" />
            <el-table-column label="司机" width="180">
              <template #default="{ row }">
                <b>{{ row.driver_name || '—' }}</b>
                <span style="color:var(--color-muted);font-size:12px;margin-left:4px">{{ row.driver_id_card ? '(' + row.driver_id_card + ')' : '' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作类型" width="150">
              <template #default="{ row }">
                <el-tag size="small" :type="logTagType(row.action)" effect="light">
                  {{ driverActionText(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="变更内容">
              <template #default="{ row }">
                <span v-for="(c, i) in logChanges(row)" :key="i" style="display:block;font-size:13px;line-height:1.8">
                  · {{ c }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="user_name" label="操作人" width="130" />
          </el-table>
          <el-empty v-if="!logsLoading && changeLogs.length === 0" description="暂无状态变更记录" :image-size="80" />
          <div v-if="logsTotal > 0" class="tab-pagination">
            <el-pagination
              v-model:current-page="logsQuery.page" :page-size="logsQuery.pageSize" :total="logsTotal"
              layout="total, prev, pager, next" :pager-count="5" background />
          </div>
        </el-tab-pane>

        <!-- Tab 3：账号操作记录（仅管理员） -->
        <el-tab-pane v-if="userStore.isAdmin" label="账号操作记录" name="account">
          <div class="tab-toolbar">
            <span class="tab-tip">新增账号、信息修改、角色调整、密码修改、删除账号等账号操作留痕</span>
          </div>
          <el-table :data="accountLogs" stripe border size="small" style="width:100%" v-loading="accountLoading">
            <el-table-column prop="time" label="时间" width="160" />
            <el-table-column label="操作类型" width="130">
              <template #default="{ row }">
                <el-tag size="small" :type="accountActionTag(row.action).type" effect="light">
                  {{ accountActionTag(row.action).text }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="目标账号" width="180">
              <template #default="{ row }">
                <b>{{ row.target_name || '—' }}</b>
                <span style="color:var(--color-muted);font-size:12px;margin-left:4px">{{ row.target_username ? '(' + row.target_username + ')' : '' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="detail" label="操作详情" />
            <el-table-column prop="operator_name" label="操作人" width="130" />
          </el-table>
          <el-empty v-if="!accountLoading && accountLogs.length === 0" description="暂无账号操作记录" :image-size="80" />
          <div v-if="accountTotal > 0" class="tab-pagination">
            <el-pagination
              v-model:current-page="accountQuery.page" :page-size="accountQuery.pageSize" :total="accountTotal"
              layout="total, prev, pager, next" :pager-count="5" background />
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-card shadow="hover" style="margin-top:16px">
      <template #header>
        <div class="card-title">🔐 权限划分说明</div>
      </template>
      <el-descriptions :column="1" border>
        <el-descriptions-item v-if="userStore.isAdmin" label="超级管理员 (admin)">
          <ul class="ul">
            <li>✅ 发布新任务（「任务发布」模块）</li>
            <li>✅ 审核司机注册 / 驳回（本模块）</li>
            <li>✅ 账号管理：新增调度员/改密码/分配角色</li>
            <li>✅ 停用/启用司机、删除司机</li>
            <li>✅ 拥有调度员的所有权限：查询、派发、修改、取消任务，确认完成；司机详情/编辑等</li>
          </ul>
        </el-descriptions-item>
        <el-descriptions-item v-else label="调度员 (dispatcher)">
          <ul class="ul">
            <li>❌ 不能发布新任务（无「任务发布」入口）</li>
            <li>❌ 不能审核新司机（在本模块仅可录入新司机注册申请，不能审核）</li>
            <li>❌ 不能管理账号/删除司机/停用司机</li>
            <li>❌ 不能将司机设为已停用/任务中</li>
            <li>✅ 录入新司机（提交后状态=待审核，需超级管理员审核）</li>
            <li>✅ 编辑司机基本信息、在在职/休息/休假之间切换司机状态</li>
            <li>✅ 可查询任务、派发任务、修改任务、取消任务、确认完成</li>
          </ul>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<style scoped>
.page-header { margin-bottom: 16px; display:flex; align-items:flex-end; justify-content:space-between; }
.page-header h2 { margin: 0 0 4px; font-size: 22px; }
.page-header p { margin: 0; color: var(--color-muted, #909399); font-size: 13px; }
.card-title { font-size: 15px; font-weight: 600; }
.flex-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.ul { margin:0; padding-left:18px; }
.ul li { padding:2px 0; font-size:13px; }
.tab-toolbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.tab-tip { font-size:12px; color: var(--color-muted, #909399); }
.tab-pagination { margin-top: 12px; display:flex; justify-content:flex-end; }
</style>
