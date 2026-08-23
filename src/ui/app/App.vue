<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'

import AccessRoute from '@/routes/AccessRoute.vue'

import { useAuthStore } from './stores/auth.store'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

onMounted(() => {
  void auth.initialize()
})

watch(
  [() => auth.state.type, () => route.name],
  ([stateType, routeName]) => {
    if (stateType === 'checking') return
    if (stateType === 'authenticated' && routeName === 'access') {
      void router.replace({ name: 'chat' })
      return
    }
    if (stateType !== 'authenticated' && routeName !== 'access') {
      void router.replace({ name: 'access' })
    }
  },
  { immediate: true },
)
</script>

<template>
  <RouterView v-if="auth.state.type === 'authenticated'" />
  <AccessRoute v-else />
</template>
