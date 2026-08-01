<script setup lang="ts">
import type { MeetingMediaProfile, MeetingMediaTtsProfile } from '@proj-airi/stage-shared/meeting-media'

import { matchesMeetingMediaDeviceName, MEETING_MEDIA_COMPATIBILITY_NAMES } from '@proj-airi/stage-shared/meeting-media'
import { resolveActiveTranscriptionModel, resolveTranscriptionProviderOptions, useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useMeetingMediaStore } from '@proj-airi/stage-ui/stores/modules/meeting-media'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Callout } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import MeetingMediaPreflightPanel from './components/meeting-media-preflight-panel.vue'
import MeetingMediaProfilePanel from './components/meeting-media-profile-panel.vue'
import MeetingMediaRuntimePanel from './components/meeting-media-runtime-panel.vue'

import { useMeetingMediaDevices } from '../../../composables/use-meeting-media-devices'

const meetingMediaStore = useMeetingMediaStore()
const hearingStore = useHearingStore()
const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const {
  bridgeError,
  canStart,
  commandPending,
  connected,
  lastError,
  preflightResult,
  profile,
  runtime,
} = storeToRefs(meetingMediaStore)
const { activeTranscriptionModel, activeTranscriptionProvider } = storeToRefs(hearingStore)
const { activeSpeechModel, activeSpeechProvider, activeSpeechVoice } = storeToRefs(speechStore)
const {
  inventory,
  captureSources,
  error: browserDeviceError,
  refreshing: deviceRefreshing,
  authorizingVideoInput,
  authorizingAudioOutput,
  refresh: refreshDevices,
  requestScreenCapturePermission,
  authorizeVideoInput,
  authorizeAudioOutput,
} = useMeetingMediaDevices()
const { t } = useI18n()
const profileEditError = shallowRef<string | null>(null)

const profileChanged = computed(() => (
  runtime.value.activeProfile !== null
  && JSON.stringify(runtime.value.activeProfile) !== JSON.stringify(profile.value)
))
const activeSpeechProfile = computed(() => {
  const providerId = activeTranscriptionProvider.value
  const providerConfig = providersStore.getProviderConfig(providerId)
  const providerOptions = resolveTranscriptionProviderOptions(providerConfig)
  return {
    providerId,
    model: resolveActiveTranscriptionModel(activeTranscriptionModel.value, providerConfig),
    locale: providerOptions.language ?? navigator.language,
  }
})
const activeTtsProfile = computed<MeetingMediaTtsProfile>(() => {
  const providerId = activeSpeechProvider.value
  const providerConfig = providersStore.getProviderConfig(providerId)
  const voiceId = activeSpeechVoice.value?.id
    ?? (typeof providerConfig?.voice === 'string' ? providerConfig.voice : '')
  const voiceName = activeSpeechVoice.value?.name ?? voiceId
  const model = activeSpeechModel.value
    || (typeof providerConfig?.model === 'string' ? providerConfig.model : '')
  return {
    providerId,
    model,
    voiceId,
    voiceName,
  }
})
const meetingTtsVoices = computed(() => speechStore.getVoicesForProvider(profile.value.tts.providerId))

watch(
  [
    () => profile.value.tts.providerId,
    () => profile.value.tts.model,
  ],
  ([providerId, model]) => {
    if (providerId)
      void speechStore.loadVoicesForProvider(providerId, model || undefined)
  },
  { immediate: true },
)

function updateProfile(nextProfile: MeetingMediaProfile): void {
  try {
    meetingMediaStore.setProfile(nextProfile)
    profileEditError.value = null
  }
  catch {
    // Invalid intermediate edits are rejected at the persisted profile boundary.
    profileEditError.value = 'MEETING_MEDIA_PROFILE_INVALID'
  }
}

async function authorizeObsVirtualCamera(): Promise<void> {
  try {
    await authorizeVideoInput(MEETING_MEDIA_COMPATIBILITY_NAMES.camera)
  }
  catch {
    // The device composable exposes authorization failures through browserDeviceError.
  }
}

async function authorizeAgentAudioOutput(): Promise<void> {
  try {
    const device = await authorizeAudioOutput(MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone)
    if (device.kind !== 'audiooutput' || !matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone)) {
      profileEditError.value = 'MEETING_MEDIA_AGENT_OUTPUT_DEVICE_INVALID'
      return
    }

    updateProfile({
      ...profile.value,
      agentAudio: {
        ...profile.value.agentAudio,
        outputDeviceId: device.deviceId,
        outputDeviceName: MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone,
      },
    })
  }
  catch {
    // The device composable exposes selection failures through browserDeviceError.
  }
}

async function runPreflight(): Promise<void> {
  try {
    await meetingMediaStore.runPreflight()
  }
  catch {
    // The store exposes the transport failure through bridgeError for this page.
  }
}

async function start(): Promise<void> {
  try {
    await meetingMediaStore.start()
  }
  catch {
    // The store exposes the transport failure through bridgeError for this page.
  }
}

async function stop(): Promise<void> {
  try {
    await meetingMediaStore.stop()
  }
  catch {
    // The store exposes the transport failure through bridgeError for this page.
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-5 pb-12']">
    <Callout
      v-if="profileEditError"
      theme="orange"
      :label="t('tamagotchi.settings.pages.meeting-media.profile.invalid-title')"
    >
      {{ profileEditError === 'MEETING_MEDIA_PROFILE_INVALID'
        ? t('tamagotchi.settings.pages.meeting-media.profile.invalid-description')
        : t(`tamagotchi.settings.pages.meeting-media.errors.${profileEditError}`) }}
    </Callout>

    <MeetingMediaRuntimePanel
      :runtime="runtime"
      :last-error="lastError"
      :bridge-error="bridgeError"
      :connected="connected"
      :command-pending="commandPending"
      :can-start="canStart"
      :profile-changed="profileChanged"
      @start="start"
      @stop="stop"
    />

    <MeetingMediaPreflightPanel
      :backend="profile.backend"
      :receive-audio-enabled="profile.receiveAudio.enabled"
      :preflight="preflightResult"
      :browser-devices="inventory"
      :browser-device-error="browserDeviceError"
      :device-refreshing="deviceRefreshing"
      :command-pending="commandPending"
      @check="runPreflight"
      @request-screen-capture-permission="requestScreenCapturePermission"
      @refresh-devices="refreshDevices"
    />

    <MeetingMediaProfilePanel
      :profile="profile"
      :monitor-outputs="inventory.monitorOutputs"
      :audio-outputs="inventory.audioOutputs"
      :capture-sources="captureSources"
      :device-labels-available="inventory.labelsAvailable"
      :active-speech-profile="activeSpeechProfile"
      :active-tts-profile="activeTtsProfile"
      :tts-voices="meetingTtsVoices"
      :authorizing-video-input="authorizingVideoInput"
      :authorizing-agent-output="authorizingAudioOutput"
      @update:profile="updateProfile"
      @authorize-video-input="authorizeObsVirtualCamera"
      @authorize-agent-output="authorizeAgentAudioOutput"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: tamagotchi.settings.pages.meeting-media.title
  subtitleKey: settings.title
  descriptionKey: tamagotchi.settings.pages.meeting-media.description
  icon: i-solar:videocamera-record-bold-duotone
  settingsEntry: true
  order: 7
  stageTransition:
    name: slide
</route>
