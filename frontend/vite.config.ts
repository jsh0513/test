import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',                //只允许本地访问
    port: 5174,
    open:true,
    strictPort: true,                     //严格端口,当端口被占用时直接报错
    proxy: {
      '/api': 'http://localhost:3001',          //代理配置
    },
  },
})
