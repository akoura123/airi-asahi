<script setup lang="ts">
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const providerId = 'volcengine'
const defaultModel = 'seed-tts-2.0'

interface VolcengineV3SpeechOptions {
  audio?: {
    speedRatio?: number
  }
}

const speedRatio = shallowRef<number>(1.0)

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)
const { t } = useI18n()

const apiKeyConfigured = computed(() => {
  const apiKey = providers.value[providerId]?.apiKey
  return typeof apiKey === 'string' && apiKey.trim().length > 0
})

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions<string, VolcengineV3SpeechOptions>
  if (!provider) {
    throw new Error('Failed to initialize speech provider')
  }

  const providerConfig = providersStore.getProviderConfig(providerId)
  const model = providerConfig.model as string | undefined || defaultModel

  return await speechStore.speech(
    provider,
    model,
    input,
    voiceId,
    {
      ...providerConfig,
    },
  )
}

watch(speedRatio, () => {
  const providerConfig = providersStore.getProviderConfig(providerId)
  if (!providerConfig.audio) {
    providerConfig.audio = {}
  }

  (providerConfig.audio as Record<string, unknown>).speedRatio = speedRatio.value
})

watch(apiKeyConfigured, async (configured) => {
  if (configured)
    await speechStore.loadVoicesForProvider(providerId, defaultModel)
}, {
  immediate: true,
})
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    placeholder="Volcengine API Key"
  >
    <template #voice-settings>
      <FieldRange
        v-model="speedRatio"
        :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
        :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
        :min="0.5"
        :max="2.0" :step="0.01"
      />
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        default-text="你好，这是火山引擎 Seed-TTS 2.0 的语音合成测试。"
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
  </route>
