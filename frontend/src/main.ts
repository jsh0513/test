import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'

// 全局亮色/暗色主题样式 (R8: 亮=Element Plus 默认；暗=#1f2937 + #272e3b)
import './assets/global.css'

// --------- 用户 Store，用于启动时自动应用主题 (避免刷新后暗色不生效) ---------
import { useUserStore } from './stores/user'

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())

// 在挂载前应用一次主题（确保暗色页面打开瞬间无纯白闪烁）
const userStore = useUserStore()
userStore.applyTheme()

app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
