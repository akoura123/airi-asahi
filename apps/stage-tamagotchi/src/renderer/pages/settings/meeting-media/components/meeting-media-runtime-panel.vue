<script setup lang="ts">
import type { MeetingMediaError, MeetingMediaRuntime } from '@proj-airi/stage-shared/meeting-media'
import type { DeepReadonly } from 'vue'

import { Button, Callout } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  runtime: DeepReadonly<MeetingMediaRuntime>
  lastError: MeetingMediaError | null
  bridgeError: string | null
  connected: boolean
  commandPending: boolean
  canStart: boolean
  profileChanged: boolean
}>()

const emit = defineEmits<{
  start: []
  stop: []
}>()

const { t, te } = useI18n()

const canStop = computed(() => (
  props.runtime.sessionId !== null
  && props.runtime.state !== 'idle'
  && props.runtime.state !== 'stopping'
  && !props.commandPending
))

const runtimeStateLabel = computed(() => t(
  `tamagotchi.settings.pages.meeting-media.runtime.states.${props.runtime.state}`,
))

function errorLabel(error: MeetingMediaError): string {
  const key = `tamagotchi.settings.pages.meeting-media.errors.${error.code}`
  return te(key) ? t(key) : error.code
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
    <header :class="['flex flex-wrap items-start justify-between gap-4']">
      <div :class="['flex flex-col gap-1']">
        <h2 :class="['text-base font-semibold text-neutral-900 dark:text-neutral-100']">
          {{ t('tamagotchi.settings.pages.meeting-media.runtime.title') }}
        </h2>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.meeting-media.runtime.description') }}
        </p>
      </div>
      <span
        :class="[
          'rounded-full px-3 py-1.5 text-xs font-semibold',
          runtime.state === 'running'
            ? 'bg-lime-500/10 text-lime-700 dark:text-lime-300'
            : runtime.state === 'error'
              ? 'bg-orange-500/10 text-orange-700 dark:text-orange-300'
              : 'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300',
        ]"
      >
        {{ runtimeStateLabel }}
      </span>
    </header>

    <Callout
      v-if="!connected"
      theme="orange"
      :label="t('tamagotchi.settings.pages.meeting-media.runtime.bridge-unavailable-title')"
    >
      {{ t('tamagotchi.settings.pages.meeting-media.runtime.bridge-unavailable-description') }}
    </Callout>

    <Callout
      v-if="lastError"
      theme="orange"
      :label="errorLabel(lastError)"
    >
      <div :class="['flex flex-col gap-1 text-xs']">
        <span>{{ t('tamagotchi.settings.pages.meeting-media.runtime.error-code') }}: {{ lastError.code }}</span>
        <span v-if="lastError.route">
          {{ t('tamagotchi.settings.pages.meeting-media.runtime.error-route') }}:
          {{ t(`tamagotchi.settings.pages.meeting-media.routes.${lastError.route}`) }}
        </span>
      </div>
    </Callout>

    <Callout
      v-else-if="bridgeError"
      theme="orange"
      :label="t('tamagotchi.settings.pages.meeting-media.runtime.bridge-error')"
    >
      {{ t('tamagotchi.settings.pages.meeting-media.runtime.bridge-error-description') }}
    </Callout>

    <Callout
      v-if="profileChanged"
      theme="violet"
      :label="t('tamagotchi.settings.pages.meeting-media.runtime.pending-profile-title')"
    >
      {{ t('tamagotchi.settings.pages.meeting-media.runtime.pending-profile-description') }}
    </Callout>

    <dl :class="['grid grid-cols-1 gap-3 text-sm md:grid-cols-3']">
      <div :class="['rounded-xl bg-white/55 p-3 dark:bg-neutral-950/45']">
        <dt :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.meeting-media.runtime.session') }}
        </dt>
        <dd :class="['mt-1 truncate font-mono text-xs']">
          {{ runtime.sessionId ?? '—' }}
        </dd>
      </div>
      <div :class="['rounded-xl bg-white/55 p-3 dark:bg-neutral-950/45']">
        <dt :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.meeting-media.runtime.video-fps') }}
        </dt>
        <dd :class="['mt-1 font-mono']">
          {{ runtime.metrics.video.actualFps.toFixed(1) }} fps
        </dd>
      </div>
      <div :class="['rounded-xl bg-white/55 p-3 dark:bg-neutral-950/45']">
        <dt :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.meeting-media.runtime.speech-segments') }}
        </dt>
        <dd :class="['mt-1 font-mono']">
          {{ runtime.metrics.remoteAudio.speechSegments }}
        </dd>
      </div>
    </dl>

    <div :class="['flex flex-wrap justify-end gap-3']">
      <Button
        v-if="canStop"
        variant="danger"
        icon="i-solar:stop-circle-bold-duotone"
        :loading="commandPending"
        :disabled="commandPending"
        @click="emit('stop')"
      >
        {{ t('tamagotchi.settings.pages.meeting-media.actions.stop') }}
      </Button>
      <Button
        v-else
        variant="primary"
        icon="i-solar:play-circle-bold-duotone"
        :loading="commandPending"
        :disabled="!canStart"
        @click="emit('start')"
      >
        {{ t('tamagotchi.settings.pages.meeting-media.actions.start') }}
      </Button>
    </div>
  </section>
</template>
