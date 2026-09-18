<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { login, getMe } from '../api'
import { useUserStore } from '../stores/user'
import { Van } from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const form = reactive({ username: 'admin', password: '123456' })
const loading = ref(false)

async function handleLogin() {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入账号密码')
    return
  }
  loading.value = true
  try {
    const r = await login({ username: form.username, password: form.password })
    userStore.setLogin(r.token, r.user)
    ElMessage.success(`欢迎回来，${r.user.name}`)
    const redirect = (route.query.redirect as string) || '/dashboard'
    router.push(redirect)
  } catch (_err: any) {
    // R7b: 账号密码错误时显示提示，不要刷新页面；响应拦截器已经弹过 message，但这里再兜底一次确保有提示
    ElMessage({
      type: 'error',
      message: _err?.response?.data?.message || '账号或密码错误，请检查后重试',
      duration: 2500,
      showClose: true,
    })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-box">
      <div class="brand">
        <el-icon :size="28" color="#409EFF"><Van /></el-icon>
        <span>货运司机任务分派管理系统</span>
      </div>
      <div class="sub">Driver Task Dispatch Management</div>

      <el-form :model="form" label-position="top" style="margin-top:24px">
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="请输入账号" size="large" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" placeholder="请输入密码" show-password size="large" @keyup.enter="handleLogin" />
        </el-form-item>
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="handleLogin">登录</el-button>
      </el-form>

      <div class="tips">
        <div>默认账号(密码均为 <b>123456</b>)：</div>
        <div>管理员：<code>admin</code></div>
        <div>调度员：<code>disp1</code> 、<code>disp2</code></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(1000px 400px at 20% 10%, rgba(64,158,255,0.15), transparent 60%),
    radial-gradient(800px 500px at 80% 90%, rgba(103,194,58,0.12), transparent 60%),
    #f5f7fa;
}
.login-box {
  width: 380px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.08);
  padding: 36px 32px 28px;
}
.brand { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: #1f2937; }
.sub   { color: #909399; font-size: 12px; margin-top: 4px; }
.tips  { margin-top: 20px; padding: 12px; background: #f5f7fa; border-radius: 6px; font-size: 12px; color: #606266; line-height: 1.8; }
.tips code { background: #fff; padding: 1px 6px; border-radius: 4px; color: #409EFF; }
/* R8 登录页暗色配色，与全局主题一致 */
html[data-theme='dark'] .login-page {
  background:
    radial-gradient(1000px 400px at 20% 10%, rgba(64,158,255,0.18), transparent 60%),
    radial-gradient(800px 500px at 80% 90%, rgba(103,194,58,0.10), transparent 60%),
    var(--bg-page);  /* #1f2937  不是纯黑 */
}
html[data-theme='dark'] .login-box {
  background: var(--bg-card);  /* #272e3b 卡片容器 */
  color: var(--color-text);   /* #e5e7eb 主文字 */
  box-shadow: 0 16px 40px rgba(0,0,0,0.35);
  border: 1px solid var(--border-color);  /* #374151 */
}
html[data-theme='dark'] .tips {
  background: var(--table-stripe);  /* #2c3442 隔行底色同色，作为tips背景 */
  color: var(--color-muted);        /* #9ca3af 次要文字 */
}
html[data-theme='dark'] .tips code {
  background: #12233a;
  color: #60a5fa;                /* 主色略亮，保持可识别 */
}
html[data-theme='dark'] .brand { color: var(--color-text); }
html[data-theme='dark'] .sub   { color: var(--color-muted); }
</style>
