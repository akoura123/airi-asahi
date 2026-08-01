<script setup lang="ts">
import type {
  MeetingMediaPreflight,
  MeetingMediaRoute,
  MeetingMediaRoutePreflight,
} from '@proj-airi/stage-shared/meeting-media'
import type { DeepReadonly } from 'vue'

import type { MeetingMediaBrowserDevices } from '../../../../composables/use-meeting-media-devices'

import { MEETING_MEDIA_COMPATIBILITY_NAMES, MEETING_MEDIA_DEVICE_NAMES, MEETING_MEDIA_ROUTES } from '@proj-airi/stage-shared/meeting-media'
import { Button } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  backend: 'native' | 'compatibility'
  receiveAudioEnabled: boolean
  preflight: DeepReadonly<MeetingMediaPreflight> | null
  browserDevices: MeetingMediaBrowserDevices
  browserDeviceError: string | null
  deviceRefreshing: boolean
  commandPending: boolean
}>()

const emit = defineEmits<{
  check: []
  requestScreenCapturePermission: []
  refreshDevices: []
}>()

const { t, te } = useI18n()

const routeChecks = computed(() => MEETING_MEDIA_ROUTES.map(route => ({
  route,
  result: props.preflight?.routes[route] ?? null,
})))

const needsScreenCapturePermission = computed(() => {
  return window.platform === 'darwin'
    && props.backend === 'compatibility'
    && props.receiveAudioEnabled
    && props.preflight?.routes['remote-audio-in']?.permission !== 'granted'
})

const browserDeviceChecks = computed(() => {
  if (props.backend === 'compatibility') {
    return [
      {
        name: MEETING_MEDIA_COMPATIBILITY_NAMES.camera,
        detected: props.browserDevices.obsVirtualCameraDetected,
      },
      {
        name: MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone,
        detected: props.browserDevices.blackHoleDetected,
      },
    ]
  }

  return [
    {
      name: MEETING_MEDIA_DEVICE_NAMES.camera,
      detected: props.browserDevices.virtualCameraDetected,
    },
    {
      name: MEETING_MEDIA_DEVICE_NAMES.meetingSpeaker,
      detected: props.browserDevices.meetingSpeakerDetected,
    },
    {
      name: MEETING_MEDIA_DEVICE_NAMES.virtualMicrophone,
      detected: props.browserDevices.virtualMicrophoneDetected,
    },
  ]
})

function routeLabel(route: MeetingMediaRoute): string {
  return t(`tamagotchi.settings.pages.meeting-media.routes.${route}`)
}

function resultLabel(result: DeepReadonly<MeetingMediaRoutePreflight> | null): string {
  if (!result)
    return t('tamagotchi.settings.pages.meeting-media.preflight.status.not-checked')
  if (!result.required)
    return t('tamagotchi.settings.pages.meeting-media.preflight.status.not-required')
  return result.ready
    ? t('tamagotchi.settings.pages.meeting-media.preflight.status.ready')
    : t('tamagotchi.settings.pages.meeting-media.preflight.status.blocked')
}

function resultClasses(result: DeepReadonly<MeetingMediaRoutePreflight> | null): string[] {
  if (result?.ready)
    return ['bg-lime-500/10 text-lime-700 dark:text-lime-300']
  if (result?.required === false)
    return ['bg-neutral-500/10 text-neutral-500 dark:text-neutral-400']
  if (result)
    return ['bg-orange-500/10 text-orange-700 dark:text-orange-300']
  return ['bg-neutral-500/10 text-neutral-500 dark:text-neutral-400']
}

function issueLabel(code: string): string {
  const key = `tamagotchi.settings.pages.meeting-media.errors.${code}`
  return te(key) ? t(key) : code
}

function preflightValueLabel(value: string): string {
  const key = `tamagotchi.settings.pages.meeting-media.preflight.values.${value}`
  return te(key) ? t(key) : value
}

function browserErrorLabel(code: string): string {
  const key = `tamagotchi.settings.pages.meeting-media.errors.${code}`
  return te(key) ? t(key) : code
}
</script>

<template>
  <section
    :class="[
      'flex flex-col gap-5 rounded-2xl p-5',
      'bg-neutral-100/60 dark:bg-neutral-900/45',
      'border border-neutral-200/70 dark:border-neutral-800/70',
    ]"
  >
    <header :class="['flex flex-wrap items-start justify-between gap-3']">
      <div :class="['flex max-w-2xl flex-col gap-1']">
        <h2 :class="['text-base font-semibold text-neutral-900 dark:text-neutral-100']">
          {{ t('tamagotchi.settings.pages.meeting-media.preflight.title') }}
        </h2>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.meeting-media.preflight.description') }}
        </p>
      </div>
      <div :class="['flex flex-wrap items-center gap-2']">
        <Button
          v-if="needsScreenCapturePermission"
          variant="secondary"
          size="sm"
          icon="i-solar:settings-minimalistic-bold-duotone"
          @click="emit('requestScreenCapturePermission')"
        >
          {{ t('tamagotchi.settings.screen-capture.permissions-prompt.open-preferences') }}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="i-solar:shield-check-bold-duotone"
          :loading="commandPending"
          :disabled="commandPending"
          @click="emit('check')"
        >
          {{ t('tamagotchi.settings.pages.meeting-media.actions.check') }}
        </Button>
      </div>
    </header>

    <div :class="['grid grid-cols-1 gap-3 lg:grid-cols-3']">
      <article
        v-for="check in routeChecks"
        :key="check.route"
        :class="[
          'flex flex-col gap-3 rounded-xl p-4',
          'bg-white/55 dark:bg-neutral-950/45',
          'border border-neutral-200/70 dark:border-neutral-800/70',
        ]"
      >
        <div :class="['flex items-center justify-between gap-3']">
          <span :class="['text-sm font-semibold']">{{ routeLabel(check.route) }}</span>
          <span :class="['rounded-full px-2.5 py-1 text-xs font-medium', ...resultClasses(check.result)]">
            {{ resultLabel(check.result) }}
          </span>
        </div>

        <dl v-if="check.result" :class="['grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs']">
          <dt :class="['text-neutral-500 dark:text-neutral-400']">
            {{ t('tamagotchi.settings.pages.meeting-media.preflight.component') }}
          </dt>
          <dd :class="['text-right font-mono']">
            {{ preflightValueLabel(check.result.component) }}
          </dd>
          <dt :class="['text-neutral-500 dark:text-neutral-400']">
            {{ t('tamagotchi.settings.pages.meeting-media.preflight.permission') }}
          </dt>
          <dd :class="['text-right font-mono']">
            {{ preflightValueLabel(check.result.permission) }}
          </dd>
        </dl>

        <ul v-if="check.result?.issues.length" :class="['flex flex-col gap-2']">
          <li
            v-for="issue in check.result.issues"
            :key="`${issue.code}-${issue.occurredAtMs}`"
            :class="['rounded-lg bg-orange-500/10 p-2 text-xs text-orange-800 dark:text-orange-200']"
          >
            {{ issueLabel(issue.code) }}
          </li>
        </ul>
      </article>
    </div>

    <div :class="['flex flex-col gap-3 rounded-xl bg-white/55 p-4 dark:bg-neutral-950/45']">
      <div :class="['flex flex-wrap items-start justify-between gap-3']">
        <div :class="['flex flex-col gap-1']">
          <h3 :class="['text-sm font-semibold']">
            {{ t('tamagotchi.settings.pages.meeting-media.devices.title') }}
          </h3>
          <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
            {{ t('tamagotchi.settings.pages.meeting-media.devices.description') }}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:refresh-bold-duotone"
          :loading="deviceRefreshing"
          :disabled="deviceRefreshing"
          @click="emit('refreshDevices')"
        >
          {{ t('tamagotchi.settings.pages.meeting-media.actions.refresh-devices') }}
        </Button>
      </div>

      <p
        v-if="browserDeviceError"
        :class="['rounded-lg bg-orange-500/10 p-2 text-xs text-orange-800 dark:text-orange-200']"
      >
        {{ browserErrorLabel(browserDeviceError) }}
      </p>
      <p
        v-else-if="!browserDevices.labelsAvailable"
        :class="['rounded-lg bg-orange-500/10 p-2 text-xs text-orange-800 dark:text-orange-200']"
      >
        {{ t('tamagotchi.settings.pages.meeting-media.devices.labels-unavailable') }}
      </p>

      <div :class="['grid grid-cols-1 gap-2', browserDeviceChecks.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3']">
        <div
          v-for="device in browserDeviceChecks"
          :key="device.name"
          :class="[
            'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs',
            'border border-neutral-200/70 dark:border-neutral-800/70',
          ]"
        >
          <span :class="['font-mono']">{{ device.name }}</span>
          <span :class="device.detected ? ['text-lime-600 dark:text-lime-300'] : ['text-neutral-500']">
            {{ device.detected
              ? t('tamagotchi.settings.pages.meeting-media.devices.detected')
              : t('tamagotchi.settings.pages.meeting-media.devices.not-detected') }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>
