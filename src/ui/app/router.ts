import { createRouter, createWebHistory } from 'vue-router'

import AccessRoute from '@/routes/AccessRoute.vue'
import ChatRoute from '@/routes/ChatRoute.vue'
import SessionsRoute from '@/routes/SessionsRoute.vue'
import SettingsRoute from '@/routes/SettingsRoute.vue'

import AuthenticatedShell from './AuthenticatedShell.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { component: AccessRoute, name: 'access', path: '/access' },
    {
      component: AuthenticatedShell,
      path: '/',
      children: [
        { path: '', redirect: { name: 'chat' } },
        { component: ChatRoute, name: 'chat', path: 'chat' },
        { component: SessionsRoute, name: 'sessions', path: 'sessions/:sessionId?' },
        { path: 'settings', redirect: { name: 'settings', params: { section: 'general' } } },
        { component: SettingsRoute, name: 'settings', path: 'settings/:section/:entryId?' },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'chat' } },
  ],
})

export default router
