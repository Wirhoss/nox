/// <reference types="vite/client" />

import type { MessageParameters } from '@/shared/i18n'

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    $plural(key: string, count: number, parameters?: MessageParameters): string
    $t(key: string, parameters?: MessageParameters): string
  }
}
