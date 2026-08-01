import type {
  MeetingMediaCommandResult,
  MeetingMediaPreflight,
  MeetingMediaProfile,
  MeetingMediaRuntime,
} from '@proj-airi/stage-shared/meeting-media'

import { errorMessageFromValue } from '@proj-airi/stage-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import {
  createDefaultMeetingMediaProfile,
  createInitialMeetingMediaRuntime,
  migrateMeetingMediaProfile,
  parseMeetingMediaProfile,
} from '@proj-airi/stage-shared/meeting-media'
import { defineStore } from 'pinia'
import { computed, readonly, shallowRef } from 'vue'

/** Renderer-independent control boundary implemented by the desktop Eventa bridge. */
export interface MeetingMediaControl {
  preflight: (profile: MeetingMediaProfile) => Promise<MeetingMediaPreflight>
  start: (profile: MeetingMediaProfile) => Promise<MeetingMediaCommandResult>
  stop: (sessionId: string) => Promise<MeetingMediaCommandResult>
  getRuntime: () => Promise<MeetingMediaRuntime>
  subscribeRuntime: (listener: (runtime: MeetingMediaRuntime) => void) => () => void
}

const MEETING_MEDIA_PROFILE_KEY = 'settings/meeting-media/profile/v3'
const LEGACY_MEETING_MEDIA_PROFILE_KEY = 'settings/meeting-media/profile/v2'

/** Moves the raw v2 profile into the v3 storage key before VueUse reads it. */
function migrateStoredMeetingMediaProfile(): void {
  if (typeof globalThis.localStorage === 'undefined')
    return

  if (globalThis.localStorage.getItem(MEETING_MEDIA_PROFILE_KEY) !== null)
    return

  const rawProfile = globalThis.localStorage.getItem(LEGACY_MEETING_MEDIA_PROFILE_KEY)
  if (!rawProfile)
    return

  try {
    const migrated = migrateMeetingMediaProfile(JSON.parse(rawProfile))
    if (migrated)
      globalThis.localStorage.setItem(MEETING_MEDIA_PROFILE_KEY, JSON.stringify(migrated))
  }
  catch (error) {
    console.warn('[Meeting Media] Failed to migrate the persisted v2 profile.', error)
  }
}

/**
 * Owns the persisted profile and renderer-side view of the process-wide meeting session.
 * Runtime changes are accepted only through the bound control or explicit store actions.
 */
export const useMeetingMediaStore = defineStore('modules:meeting-media', () => {
  migrateStoredMeetingMediaProfile()

  const profile = useLocalStorageManualReset<MeetingMediaProfile>(
    MEETING_MEDIA_PROFILE_KEY,
    createDefaultMeetingMediaProfile(),
  )
  const runtime = shallowRef<MeetingMediaRuntime>(createInitialMeetingMediaRuntime())
  const preflightResult = shallowRef<MeetingMediaPreflight | null>(null)
  const lastCommandError = shallowRef<MeetingMediaCommandResult['error']>(null)
  const bridgeError = shallowRef<string | null>(null)
  const connected = shallowRef(false)
  const commandPending = shallowRef(false)

  let control: MeetingMediaControl | undefined
  let unsubscribeRuntime: (() => void) | undefined
  let startOperation: Promise<MeetingMediaCommandResult> | undefined

  const profileIsValid = computed(() => {
    try {
      parseMeetingMediaProfile(profile.value)
      return true
    }
    catch {
      return false
    }
  })
  const lastError = computed(() => {
    const commandError = lastCommandError.value
    const runtimeError = runtime.value.lastError
    if (!commandError)
      return runtimeError
    if (!runtimeError)
      return commandError

    // Command rejection and route failure are independent events; display whichever
    // happened later so an older double-click warning cannot hide a runtime failure.
    return runtimeError.occurredAtMs >= commandError.occurredAtMs ? runtimeError : commandError
  })
  const canStart = computed(() => {
    return connected.value
      && profileIsValid.value
      && !commandPending.value
      && (runtime.value.state === 'idle' || runtime.value.state === 'error')
  })

  function setProfile(nextProfile: MeetingMediaProfile): void {
    profile.value = parseMeetingMediaProfile(nextProfile)
  }

  function resetProfile(): void {
    profile.value = createDefaultMeetingMediaProfile()
  }

  function updateRuntime(nextRuntime: MeetingMediaRuntime): void {
    runtime.value = structuredClone(nextRuntime)
  }

  function requireControl(): MeetingMediaControl {
    if (!control)
      throw new Error('Meeting media control is not connected.')
    return control
  }

  async function refreshRuntime(): Promise<MeetingMediaRuntime> {
    try {
      const nextRuntime = await requireControl().getRuntime()
      updateRuntime(nextRuntime)
      bridgeError.value = null
      return nextRuntime
    }
    catch (error) {
      bridgeError.value = errorMessageFromValue(error)
      throw error
    }
  }

  async function runPreflight(): Promise<MeetingMediaPreflight> {
    commandPending.value = true
    try {
      const result = await requireControl().preflight(parseMeetingMediaProfile(profile.value))
      preflightResult.value = structuredClone(result)
      bridgeError.value = null
      return result
    }
    catch (error) {
      bridgeError.value = errorMessageFromValue(error)
      throw error
    }
    finally {
      commandPending.value = false
    }
  }

  function start(): Promise<MeetingMediaCommandResult> {
    // A physical double-click can arrive before Vue renders the disabled state.
    // All callers share the same process-level start transition and its result.
    if (startOperation)
      return startOperation

    commandPending.value = true
    lastCommandError.value = null
    const operation = (async () => {
      try {
        const result = await requireControl().start(parseMeetingMediaProfile(profile.value))
        updateRuntime(result.runtime)
        preflightResult.value = result.runtime.preflight
        lastCommandError.value = result.error
        bridgeError.value = null
        return result
      }
      catch (error) {
        bridgeError.value = errorMessageFromValue(error)
        throw error
      }
      finally {
        commandPending.value = false
      }
    })()

    startOperation = operation
    const clearOperation = () => {
      if (startOperation === operation)
        startOperation = undefined
    }
    void operation.then(clearOperation, clearOperation)
    return operation
  }

  async function stop(): Promise<MeetingMediaCommandResult | null> {
    const sessionId = runtime.value.sessionId
    if (!sessionId)
      return null

    commandPending.value = true
    try {
      const result = await requireControl().stop(sessionId)
      updateRuntime(result.runtime)
      lastCommandError.value = result.error
      bridgeError.value = null
      return result
    }
    catch (error) {
      bridgeError.value = errorMessageFromValue(error)
      throw error
    }
    finally {
      commandPending.value = false
    }
  }

  async function connect(nextControl: MeetingMediaControl): Promise<void> {
    unsubscribeRuntime?.()
    control = nextControl
    unsubscribeRuntime = nextControl.subscribeRuntime(updateRuntime)
    connected.value = true

    try {
      await refreshRuntime()
    }
    catch {
      disconnect()
    }
  }

  function disconnect(): void {
    unsubscribeRuntime?.()
    unsubscribeRuntime = undefined
    control = undefined
    connected.value = false
  }

  return {
    profile,
    runtime: readonly(runtime),
    preflightResult: readonly(preflightResult),
    lastCommandError: readonly(lastCommandError),
    bridgeError: readonly(bridgeError),
    connected: readonly(connected),
    commandPending: readonly(commandPending),
    profileIsValid,
    lastError,
    canStart,
    setProfile,
    resetProfile,
    updateRuntime,
    refreshRuntime,
    runPreflight,
    start,
    stop,
    connect,
    disconnect,
  }
})
