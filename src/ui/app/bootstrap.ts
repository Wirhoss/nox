import { createPinia } from 'pinia'
import { createApp } from 'vue'

import { i18n } from '@/shared/i18n'

import App from './App.vue'
import router from './router'

import '@/shared/styles/global.scss'

try {
  await i18n.initialize()
} catch {
  // The app still mounts so its connection recovery surface remains reachable;
  // untranslated keys make the missing language API visible instead of hiding it.
}

const app = createApp(App)

app.use(createPinia())
app.use(i18n)
app.use(router)

app.mount('#app')
