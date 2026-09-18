<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, Delete as DDelete } from '@element-plus/icons-vue'
import { getUsers, createUser, updateUser, deleteUser } from '../api'
import { useUserStore } from '../stores/user'

const userStore = useUserStore()
// 超级管理员可管理所有账号（含角色）；普通管理员只能管理调度员账号
const isSuperAdmin = computed(() => userStore.isSuperAdmin)

const list = ref<any[]>([])
const loading = ref(false)
const addVisible = ref(false)
const editVisible = ref(false)
const form = reactive({ username: '', password: '', name: '', role: 'dispatcher' })
const editingId = ref<number | null>(null)

async function fetch() {
  loading.value = true
  try { const r = await getUsers(); list.value = r.list || [] } finally { loading.value = false }
}

function openAdd() {
  editingId.value = null
  Object.assign(form, { username: '', password: '123456', name: '', role: 'dispatcher' })
  addVisible.value = true
}
async function submitAdd() {
  if (!form.username || !form.password || !form.name) return ElMessage.warning('信息不完整')
  await createUser(form)
  ElMessage.success('账号创建成功')
  addVisible.value = false
  fetch()
}

// 该行是否可被当前登录人编辑：超管可编辑所有人；普通管理员只能编辑调度员
function canEdit(row: any) {
  if (isSuperAdmin.value) return true
  return row.role !== 'admin'
}

function openEdit(u: any) {
  if (!canEdit(u)) {
    return ElMessage.warning('仅超级管理员可修改管理员账号与角色权限')
  }
  editingId.value = u.id
  Object.assign(form, { username: u.username, password: '', name: u.name, role: u.role })
  editVisible.value = true
}
async function submitEdit() {
  if (!editingId.value) return
  const body: any = { name: form.name }
  // 仅超级管理员可调整角色
  if (isSuperAdmin.value) body.role = form.role
  if (form.password) body.password = form.password
  await updateUser(editingId.value, body)
  ElMessage.success('修改成功')
  editVisible.value = false
  fetch()
}

async function handleDelete(u: any) {
  if (!canEdit(u)) {
    return ElMessage.warning('仅超级管理员可删除管理员账号')
  }
  await ElMessageBox.confirm(`确认删除账号「${u.username}」？`, '提示', { type: 'warning' })
  await deleteUser(u.id)
  ElMessage.success('已删除')
  fetch()
}

function roleTag(r: any) {
  // id=1 / username=admin 为超级管理员
  if (r.role === 'admin' && (r.username === 'admin' || r.id === 1)) return { type: 'danger', text: '超级管理员' }
  if (r.role === 'admin') return { type: 'warning', text: '管理员' }
  return { type: 'primary', text: '调度员' }
}

onMounted(fetch)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>账号管理</h2>
        <p>仅管理员可见：创建/修改账号、重置密码、分配角色(调度员不可删除司机/不可管理账号)</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openAdd">新增账号</el-button>
    </div>

    <el-card shadow="hover">
      <el-table :data="list" v-loading="loading" stripe style="width:100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="username" label="账号" width="140" />
        <el-table-column prop="name" label="姓名" width="180" />
        <el-table-column label="角色" width="140">
          <template #default="{ row }">
            <el-tag :type="roleTag(row).type">{{ roleTag(row).text }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" />
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Edit"
              :disabled="!canEdit(row)"
              @click="openEdit(row)">编辑 / 重置密码</el-button>
            <el-button link type="danger" :icon="DDelete"
              :disabled="!canEdit(row)"
              @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="addVisible" title="新增账号" width="440px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="账号"><el-input v-model="form.username" /></el-form-item>
        <el-form-item label="初始密码"><el-input v-model="form.password" show-password /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%" :disabled="!isSuperAdmin">
            <el-option label="管理员" value="admin" />
            <el-option label="调度员" value="dispatcher" />
          </el-select>
          <div v-if="!isSuperAdmin" style="font-size:12px;color:var(--color-muted);margin-top:3px">
            仅超级管理员可创建管理员账号，当前默认创建调度员
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible=false">取消</el-button>
        <el-button type="primary" @click="submitAdd">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑账号(不填密码则不修改)" width="440px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="账号"><el-input v-model="form.username" disabled /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="form.password" show-password placeholder="留空不修改" /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%" :disabled="!isSuperAdmin">
            <el-option label="管理员" value="admin" />
            <el-option label="调度员" value="dispatcher" />
          </el-select>
          <div v-if="!isSuperAdmin" style="font-size:12px;color:var(--color-muted);margin-top:3px">
            仅超级管理员可调整账号角色
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible=false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
