import { createRouter, createWebHistory } from 'vue-router'

import AccessRoute from '@/routes/AccessRoute.vue'
import ChatRoute from '@/routes/ChatRoute.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: { name: 'chat' } },
    { component: AccessRoute, name: 'access', path: '/access' },
    { component: ChatRoute, name: 'chat', path: '/chat' },
    { path: '/:pathMatch(.*)*', redirect: { name: 'chat' } },
  ],
})

export default router
