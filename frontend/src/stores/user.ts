import { defineStore } from 'pinia'

export interface UserInfo {
  id: number
  username: string
  name: string
  role: 'admin' | 'dispatcher'
  avatar: string
  phone?: string
  gender?: string
  created_at?: string
}

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    user: (JSON.parse(localStorage.getItem('user') || 'null') as UserInfo | null),
    theme: (localStorage.getItem('theme') as 'light' | 'dark') || 'light',
  }),
  getters: {
    isLogin: (s) => !!s.token && !!s.user,
    isAdmin: (s) => s.user?.role === 'admin',
    // 超级管理员：内置 admin 账号（id=1），可管理管理员账号与角色
    isSuperAdmin: (s) => s.user?.role === 'admin' && (s.user?.username === 'admin' || s.user?.id === 1),
    role: (s) => s.user?.role || '',
    // 账号身份统一显示：名字 ID:x（如「管理员 ID:1」「调度员 小王 ID:5」）
    displayName: (s) => s.user ? `${s.user.name} ID:${s.user.id}` : '',
  },
  actions: {
    setLogin(token: string, user: UserInfo) {
      this.token = token
      this.user = user
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
    },
    setUser(user: UserInfo) {
      this.user = user
      localStorage.setItem('user', JSON.stringify(user))
    },
    logout() {
      this.token = ''
      this.user = null
      localStorage.removeItem('token')
      localStorage.removeItem('user')
    },
    setTheme(t: 'light' | 'dark') {
      this.theme = t
      localStorage.setItem('theme', t)
      document.documentElement.setAttribute('data-theme', t)
      if (t === 'dark') document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
    },
    applyTheme() {
      this.setTheme(this.theme)
    },
  },
})
