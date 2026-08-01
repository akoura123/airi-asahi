<script setup lang="ts">
import {
  Alert,
  ProviderApiKeyInput,
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'

const providerId = 'volcengine-transcription'
const defaultModel = 'volc.seedasr.sauc.duration'

const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)
const {
  t,
  router,
  providerMetadata,
  apiKey,
  isValidating,
  isValid,
  validationMessage,
  handleResetSettings,
} = useProviderValidation(providerId)

const model = computed(() => {
  const configuredModel = providers.value[providerId]?.model
  return typeof configuredModel === 'string' && configuredModel.trim()
    ? configuredModel
    : defaultModel
})

onMounted(() => {
  const providerConfig = providersStore.getProviderConfig(providerId)
  if (providerConfig && (typeof providerConfig.model !== 'string' || !providerConfig.model.trim()))
    providerConfig.model = defaultModel
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon="providerMetadata?.icon"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer :class="['w-full', 'max-w-2xl']">
      <ProviderBasicSettings
        :title="t('settings.pages.providers.common.section.basic.title')"
        :description="t('settings.pages.providers.common.section.basic.description')"
        :on-reset="handleResetSettings"
      >
        <ProviderApiKeyInput
          v-model="apiKey"
          :provider-name="providerMetadata?.localizedName"
          placeholder="Volcengine API Key"
          required
        />
        <FieldInput
          :model-value="model"
          :label="t('settings.pages.modules.consciousness.sections.section.provider-model-selection.manual_model_name')"
          :placeholder="t('settings.pages.modules.consciousness.sections.section.provider-model-selection.manual_model_placeholder')"
          disabled
        />

        <Alert v-if="isValidating > 0" type="loading">
          <template #title>
            {{ t('settings.dialogs.onboarding.validationRunning') }}
          </template>
        </Alert>
        <Alert v-else-if="!isValid && validationMessage" type="error">
          <template #title>
            {{ t('settings.dialogs.onboarding.validationFailed') }}
          </template>
          <template #content>
            <div :class="['whitespace-pre-wrap break-all']">
              {{ validationMessage }}
            </div>
          </template>
        </Alert>
        <Alert v-else-if="isValid" type="success">
          <template #title>
            {{ t('settings.dialogs.onboarding.validationSuccess') }}
          </template>
        </Alert>
      </ProviderBasicSettings>
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
