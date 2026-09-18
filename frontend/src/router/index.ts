import { createRouter, createWebHistory } from 'vue-router'
import MainLayout from '../layouts/MainLayout.vue'
import { useUserStore } from '../stores/user'

const routes = [
  { path: '/login', name: 'Login', component: () => import('../views/Login.vue'), meta: { title: '登录', public: true } },

  {
    path: '/',
    component: MainLayout,
    redirect: '/dashboard',
    meta: { requiresAuth: true },
    children: [
      { path: 'dashboard',   name: 'Dashboard',       component: () => import('../views/Dashboard.vue'),        meta: { title: '数据概览' } },
      { path: 'tasks/new',   name: 'TaskPublish',     component: () => import('../views/TaskPublish.vue'),     meta: { title: '任务发布', roles: ['admin'] } },
      { path: 'tasks',       name: 'Tasks',           component: () => import('../views/TaskDispatch.vue'),    meta: { title: '任务派发与跟踪' } },
      { path: 'history',     name: 'History',         component: () => import('../views/TaskHistory.vue'),     meta: { title: '历史任务' } },
      { path: 'drivers',     name: 'Drivers',         component: () => import('../views/DriverManagement.vue'),meta: { title: '司机管理' } },
      { path: 'drivers/:id', name: 'DriverDetail',    component: () => import('../views/DriverDetail.vue'),   meta: { title: '司机详情' } },
      { path: 'personnel',   name: 'PersonnelChange', component: () => import('../views/PersonnelChange.vue'), meta: { title: '人员变动' } },
      { path: 'statistics',  name: 'Statistics',      component: () => import('../views/Statistics.vue'),      meta: { title: '数据查询统计' } },
      { path: 'users',       name: 'Users',           component: () => import('../views/UserManagement.vue'),  meta: { title: '账号管理', roles: ['admin'] } },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const store = useUserStore()
  store.applyTheme()

  if (to.meta?.public) return next()

  if (!store.isLogin) {
    return next({ path: '/login', query: { redirect: to.fullPath } })
  }

  const required: string[] | undefined = to.meta?.roles as any
  if (required && required.length && !required.includes(store.role)) {
    return next('/dashboard')
  }
  next()
})

export default router
