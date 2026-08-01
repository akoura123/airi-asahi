<script setup lang="ts">
import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'
import type {
  MeetingMediaAgentAudioProfile,
  MeetingMediaProfile,
  MeetingMediaReceiveAudioProfile,
  MeetingMediaSpeechProfile,
  MeetingMediaTtsProfile,
  MeetingMediaVadProfile,
  MeetingMediaVideoProfile,
} from '@proj-airi/stage-shared/meeting-media'
import type { VoiceInfo } from '@proj-airi/stage-ui/stores/providers'

import { matchesMeetingMediaDeviceName, MEETING_MEDIA_COMPATIBILITY_NAMES } from '@proj-airi/stage-shared/meeting-media'
import { Button, FieldCheckbox, FieldInput, FieldRange, FieldSelect } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  profile: MeetingMediaProfile
  monitorOutputs: readonly MediaDeviceInfo[]
  audioOutputs: readonly MediaDeviceInfo[]
  captureSources: readonly SerializableDesktopCapturerSource[]
  deviceLabelsAvailable: boolean
  activeSpeechProfile: Pick<MeetingMediaSpeechProfile, 'providerId' | 'model' | 'locale'>
  activeTtsProfile: MeetingMediaTtsProfile
  ttsVoices: readonly VoiceInfo[]
  authorizingVideoInput: boolean
  authorizingAgentOutput: boolean
}>()

const emit = defineEmits<{
  'update:profile': [profile: MeetingMediaProfile]
  'authorizeVideoInput': []
  'authorizeAgentOutput': []
}>()

const { t } = useI18n()

type Resolution = '1280x720' | '1920x1080'

const resolutionOptions = computed(() => [
  { label: '1280 × 720 @ 30fps', value: '1280x720' as const },
  { label: '1920 × 1080 @ 30fps', value: '1920x1080' as const },
])

const fitOptions = computed(() => [
  { label: t('tamagotchi.settings.pages.meeting-media.profile.video.fit-options.contain'), value: 'contain' as const },
  { label: t('tamagotchi.settings.pages.meeting-media.profile.video.fit-options.cover'), value: 'cover' as const },
])

const backgroundOptions = computed(() => [
  { label: t('tamagotchi.settings.pages.meeting-media.profile.video.background-options.stage'), value: 'stage' as const },
  { label: t('tamagotchi.settings.pages.meeting-media.profile.video.background-options.color'), value: 'color' as const },
])

const recognitionModeOptions = computed(() => [
  { label: t('tamagotchi.settings.pages.meeting-media.profile.speech.mode-options.streaming'), value: 'streaming' as const },
  { label: t('tamagotchi.settings.pages.meeting-media.profile.speech.mode-options.batch'), value: 'batch' as const },
])

const duplexOptions = computed(() => [
  { label: t('tamagotchi.settings.pages.meeting-media.profile.duplex.options.full'), value: 'full-duplex' as const },
  ...(props.profile.backend === 'native'
    ? [{ label: t('tamagotchi.settings.pages.meeting-media.profile.duplex.options.half'), value: 'half-duplex' as const }]
    : []),
])

const backendOptions = computed(() => [
  { label: t('tamagotchi.settings.pages.meeting-media.profile.backend.options.compatibility'), value: 'compatibility' as const },
  { label: t('tamagotchi.settings.pages.meeting-media.profile.backend.options.native'), value: 'native' as const },
])

const monitorOutputOptions = computed(() => props.monitorOutputs.map((device, index) => ({
  label: device.label || t('tamagotchi.settings.pages.meeting-media.devices.unnamed-output', { index: index + 1 }),
  value: device.deviceId,
})))

const captureSourceOptions = computed(() => props.captureSources.map(source => ({
  label: source.name,
  value: source.id,
})))

const ttsVoiceOptions = computed(() => props.ttsVoices.map(voice => ({
  label: voice.name === voice.id ? voice.name : `${voice.name} (${voice.id})`,
  value: voice.id,
})))

const agentOutputOptions = computed(() => props.audioOutputs
  .filter(device => matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone))
  .map(device => ({
    label: device.label,
    value: device.deviceId,
  })))

const captureSourceId = computed({
  get: () => props.profile.receiveAudio.captureSourceId,
  set: (value: string) => {
    const source = props.captureSources.find(item => item.id === value)
    updateReceiveAudio({
      captureSourceId: value,
      captureSourceName: source?.name ?? '',
    })
  },
})

const agentOutputDeviceId = computed({
  get: () => props.profile.agentAudio.outputDeviceId,
  set: (value: string) => {
    const device = props.audioOutputs.find(item => item.deviceId === value)
    updateAgentAudio({
      outputDeviceId: value,
      outputDeviceName: device ? MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone : '',
    })
  },
})

const resolution = computed<Resolution>({
  get: () => `${props.profile.video.width}x${props.profile.video.height}` as Resolution,
  set: (value) => {
    updateVideo(value === '1920x1080'
      ? { width: 1920, height: 1080 }
      : { width: 1280, height: 720 })
  },
})

const backgroundKind = computed<'stage' | 'color'>({
  get: () => props.profile.video.background.kind === 'color' ? 'color' : 'stage',
  set: value => updateVideo({
    background: value === 'color'
      ? { kind: 'color', value: '#ffffff' }
      : { kind: 'stage' },
  }),
})

const backgroundColor = computed({
  get: () => props.profile.video.background.kind === 'color'
    ? props.profile.video.background.value
    : '#ffffff',
  set: (value: string) => updateVideo({ background: { kind: 'color', value } }),
})

function updateProfile(patch: Partial<MeetingMediaProfile>): void {
  emit('update:profile', {
    ...props.profile,
    ...patch,
  })
}

function updateBackend(backend: MeetingMediaProfile['backend'] | undefined): void {
  if (!backend)
    return

  updateProfile({
    backend,
    ...(backend === 'compatibility' ? { duplexPolicy: 'full-duplex' } : {}),
  })
}

function updateVideo(patch: Partial<MeetingMediaVideoProfile>): void {
  updateProfile({ video: { ...props.profile.video, ...patch } })
}

function updateReceiveAudio(patch: Partial<MeetingMediaReceiveAudioProfile>): void {
  updateProfile({ receiveAudio: { ...props.profile.receiveAudio, ...patch } })
}

function updateSpeech(patch: Partial<MeetingMediaSpeechProfile>): void {
  updateProfile({ speech: { ...props.profile.speech, ...patch } })
}

function updateTts(patch: Partial<MeetingMediaTtsProfile>): void {
  updateProfile({ tts: { ...props.profile.tts, ...patch } })
}

function updateTtsVoice(voiceId: string | undefined): void {
  const voice = props.ttsVoices.find(item => item.id === voiceId)
  updateTts({
    voiceId: voiceId ?? '',
    voiceName: voice?.name ?? '',
  })
}

function updateVad(patch: Partial<MeetingMediaVadProfile>): void {
  updateSpeech({ vad: { ...props.profile.speech.vad, ...patch } })
}

function updateAgentAudio(patch: Partial<MeetingMediaAgentAudioProfile>): void {
  updateProfile({ agentAudio: { ...props.profile.agentAudio, ...patch } })
}
</script>

<template>
  <section
    :class="[
      'flex flex-col gap-6 rounded-2xl p-5',
      'bg-neutral-100/60 dark:bg-neutral-900/45',
      'border border-neutral-200/70 dark:border-neutral-800/70',
    ]"
  >
    <header :class="['flex flex-col gap-1']">
      <h2 :class="['text-base font-semibold text-neutral-900 dark:text-neutral-100']">
        {{ t('tamagotchi.settings.pages.meeting-media.profile.title') }}
      </h2>
      <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ t('tamagotchi.settings.pages.meeting-media.profile.description') }}
      </p>
    </header>

    <FieldSelect
      :model-value="profile.backend"
      :options="backendOptions"
      :label="t('tamagotchi.settings.pages.meeting-media.profile.backend.title')"
      :description="t('tamagotchi.settings.pages.meeting-media.profile.backend.description')"
      @update:model-value="updateBackend($event)"
    />

    <div :class="['grid grid-cols-1 gap-6 lg:grid-cols-2']">
      <div :class="['flex flex-col gap-4 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
        <h3 :class="['text-sm font-semibold']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.video.title') }}
        </h3>
        <FieldCheckbox
          :model-value="profile.video.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.enabled')"
          :description="t('tamagotchi.settings.pages.meeting-media.profile.video.enabled-description')"
          @update:model-value="updateVideo({ enabled: $event })"
        />
        <p
          v-if="profile.backend === 'compatibility'"
          :class="['rounded-lg bg-violet-500/10 p-3 text-xs text-violet-800 dark:text-violet-200']"
        >
          {{ t('tamagotchi.settings.pages.meeting-media.profile.video.compatibility-description') }}
        </p>
        <Button
          v-if="profile.backend === 'compatibility'"
          variant="secondary"
          size="sm"
          icon="i-solar:videocamera-record-bold-duotone"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.authorize-input')"
          :loading="authorizingVideoInput"
          :disabled="authorizingVideoInput"
          @click="emit('authorizeVideoInput')"
        />
        <FieldSelect
          v-model="resolution"
          :options="resolutionOptions"
          :disabled="!profile.video.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.resolution')"
        />
        <FieldSelect
          :model-value="profile.video.fit"
          :options="fitOptions"
          :disabled="!profile.video.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.fit')"
          @update:model-value="updateVideo({ fit: $event })"
        />
        <FieldSelect
          v-model="backgroundKind"
          :options="backgroundOptions"
          :disabled="!profile.video.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.background')"
        />
        <FieldInput
          v-if="backgroundKind === 'color'"
          v-model="backgroundColor"
          type="color"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.background-color')"
        />
        <FieldCheckbox
          :model-value="profile.video.mirrorSource"
          :disabled="!profile.video.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.video.mirror')"
          :description="t('tamagotchi.settings.pages.meeting-media.profile.video.mirror-description')"
          @update:model-value="updateVideo({ mirrorSource: $event })"
        />
      </div>

      <div :class="['flex flex-col gap-4 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
        <h3 :class="['text-sm font-semibold']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.title') }}
        </h3>
        <FieldCheckbox
          :model-value="profile.receiveAudio.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.enabled')"
          :description="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.enabled-description')"
          @update:model-value="updateReceiveAudio({ enabled: $event })"
        />
        <FieldSelect
          v-if="profile.backend === 'compatibility'"
          v-model="captureSourceId"
          :options="captureSourceOptions"
          :disabled="!profile.receiveAudio.enabled"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.capture-placeholder')"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.capture-source')"
          :description="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.capture-description')"
        />
        <FieldSelect
          v-else
          :model-value="profile.receiveAudio.monitorDeviceId"
          :options="monitorOutputOptions"
          :disabled="!profile.receiveAudio.enabled || !deviceLabelsAvailable"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.monitor-placeholder')"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.monitor')"
          :description="deviceLabelsAvailable
            ? t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.monitor-description')
            : t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.labels-unavailable')"
          @update:model-value="updateReceiveAudio({ monitorDeviceId: $event })"
        />
        <FieldRange
          v-if="profile.receiveAudio.enabled && profile.backend === 'native'"
          :model-value="profile.receiveAudio.monitorGain"
          :min="0"
          :max="2"
          :step="0.05"
          :format-value="value => `${Math.round(value * 100)}%`"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.gain')"
          @update:model-value="updateReceiveAudio({ monitorGain: $event })"
        />
      </div>

      <div :class="['flex flex-col gap-4 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
        <h3 :class="['text-sm font-semibold']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.speech.title') }}
        </h3>
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:refresh-circle-bold-duotone"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.speech.use-current')"
          :disabled="!activeSpeechProfile.providerId || !activeSpeechProfile.model || !activeSpeechProfile.locale"
          @click="updateSpeech(activeSpeechProfile)"
        />
        <FieldInput
          :model-value="profile.speech.providerId"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.speech.provider')"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.speech.provider-placeholder')"
          @update:model-value="updateSpeech({ providerId: $event ?? '' })"
        />
        <FieldInput
          :model-value="profile.speech.model"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.speech.model')"
          @update:model-value="updateSpeech({ model: $event ?? '' })"
        />
        <FieldInput
          :model-value="profile.speech.locale"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.speech.locale')"
          placeholder="zh-CN"
          @update:model-value="updateSpeech({ locale: $event ?? '' })"
        />
        <FieldSelect
          :model-value="profile.speech.mode"
          :options="recognitionModeOptions"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.speech.mode')"
          @update:model-value="updateSpeech({ mode: $event })"
        />
      </div>

      <div :class="['flex flex-col gap-4 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
        <h3 :class="['text-sm font-semibold']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.vad.title') }}
        </h3>
        <FieldRange
          :model-value="profile.speech.vad.threshold"
          :min="0"
          :max="1"
          :step="0.01"
          :format-value="value => value.toFixed(2)"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.vad.threshold')"
          @update:model-value="updateVad({ threshold: $event })"
        />
        <FieldInput
          :model-value="profile.speech.vad.minSilenceDurationMs"
          type="number"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.vad.silence')"
          @update:model-value="updateVad({ minSilenceDurationMs: $event ?? 1 })"
        />
        <FieldInput
          :model-value="profile.speech.vad.speechPadMs"
          type="number"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.vad.padding')"
          @update:model-value="updateVad({ speechPadMs: $event ?? 0 })"
        />
        <FieldInput
          :model-value="profile.speech.vad.minSpeechDurationMs"
          type="number"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.vad.minimum-speech')"
          @update:model-value="updateVad({ minSpeechDurationMs: $event ?? 1 })"
        />
      </div>

      <div :class="['flex flex-col gap-4 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
        <h3 :class="['text-sm font-semibold']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.tts.title') }}
        </h3>
        <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.tts.description') }}
        </p>
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:refresh-circle-bold-duotone"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.tts.use-current')"
          :disabled="!activeTtsProfile.providerId || !activeTtsProfile.model || !activeTtsProfile.voiceId"
          @click="updateTts(activeTtsProfile)"
        />
        <FieldInput
          :model-value="profile.tts.providerId"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.tts.provider')"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.tts.provider-placeholder')"
          @update:model-value="updateTts({ providerId: $event ?? '' })"
        />
        <FieldInput
          :model-value="profile.tts.model"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.tts.model')"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.tts.model-placeholder')"
          @update:model-value="updateTts({ model: $event ?? '' })"
        />
        <FieldSelect
          v-if="ttsVoiceOptions.length"
          :model-value="profile.tts.voiceId"
          :options="ttsVoiceOptions"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.tts.voice')"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.tts.voice-placeholder')"
          @update:model-value="updateTtsVoice($event)"
        />
        <FieldInput
          v-else
          :model-value="profile.tts.voiceId"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.tts.voice')"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.tts.voice-placeholder')"
          @update:model-value="updateTts({ voiceId: $event ?? '' })"
        />
        <FieldInput
          :model-value="profile.tts.voiceName"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.tts.voice-name')"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.tts.voice-name-placeholder')"
          @update:model-value="updateTts({ voiceName: $event ?? '' })"
        />
      </div>

      <div :class="['flex flex-col gap-4 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
        <h3 :class="['text-sm font-semibold']">
          {{ t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.title') }}
        </h3>
        <FieldCheckbox
          :model-value="profile.agentAudio.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.enabled')"
          :description="t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.enabled-description')"
          @update:model-value="updateAgentAudio({ enabled: $event })"
        />
        <Button
          v-if="profile.backend === 'compatibility'"
          variant="secondary"
          size="sm"
          icon="i-solar:speaker-minimalistic-bold-duotone"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.authorize-output')"
          :loading="authorizingAgentOutput"
          :disabled="authorizingAgentOutput"
          @click="emit('authorizeAgentOutput')"
        />
        <FieldSelect
          v-if="profile.backend === 'compatibility'"
          v-model="agentOutputDeviceId"
          :options="agentOutputOptions"
          :disabled="!profile.agentAudio.enabled || !deviceLabelsAvailable"
          :placeholder="t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.output-placeholder')"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.output-device')"
          :description="deviceLabelsAvailable
            ? t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.output-description')
            : t('tamagotchi.settings.pages.meeting-media.profile.receive-audio.labels-unavailable')"
        />
        <FieldCheckbox
          :model-value="profile.agentAudio.localMonitor"
          :disabled="!profile.agentAudio.enabled"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.agent-audio.local-monitor')"
          @update:model-value="updateAgentAudio({ localMonitor: $event })"
        />
        <FieldSelect
          :model-value="profile.duplexPolicy"
          :options="duplexOptions"
          :label="t('tamagotchi.settings.pages.meeting-media.profile.duplex.title')"
          :description="t('tamagotchi.settings.pages.meeting-media.profile.duplex.description')"
          @update:model-value="updateProfile({ duplexPolicy: $event })"
        />
      </div>
    </div>
  </section>
</template>
