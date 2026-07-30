import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'

import { setupElectronScreenCapture } from '@proj-airi/electron-screen-capture/renderer'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { matchesMeetingMediaDeviceName, MEETING_MEDIA_COMPATIBILITY_NAMES, MEETING_MEDIA_DEVICE_NAMES } from '@proj-airi/stage-shared/meeting-media'
import { computed, onMounted, onUnmounted, readonly, shallowRef } from 'vue'

/** Browser-visible device inventory used only as supporting diagnostics for native preflight. */
export interface MeetingMediaBrowserDevices {
  all: readonly MediaDeviceInfo[]
  audioOutputs: readonly MediaDeviceInfo[]
  monitorOutputs: readonly MediaDeviceInfo[]
  virtualCameraDetected: boolean
  meetingSpeakerDetected: boolean
  virtualMicrophoneDetected: boolean
  obsVirtualCameraDetected: boolean
  blackHoleDetected: boolean
  labelsAvailable: boolean
}

/**
 * Enumerates browser-visible media devices and keeps the snapshot current across hot-plug events.
 * Native platform preflight remains authoritative because browser labels depend on media permission.
 */
export function useMeetingMediaDevices() {
  const devices = shallowRef<MediaDeviceInfo[]>([])
  const captureSources = shallowRef<SerializableDesktopCapturerSource[]>([])
  const error = shallowRef<string | null>(null)
  const refreshing = shallowRef(false)
  const authorizingVideoInput = shallowRef(false)
  const authorizingAudioOutput = shallowRef(false)
  let mediaDevices: MediaDevices | undefined
  const screenCapture = setupElectronScreenCapture(getElectronEventaContext())

  const inventory = computed<MeetingMediaBrowserDevices>(() => {
    const currentDevices = devices.value
    return {
      all: currentDevices,
      audioOutputs: currentDevices.filter(device => device.kind === 'audiooutput'),
      monitorOutputs: currentDevices.filter(device => (
        device.kind === 'audiooutput'
        && !matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_DEVICE_NAMES.meetingSpeaker)
      )),
      virtualCameraDetected: currentDevices.some(device => (
        device.kind === 'videoinput'
        && matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_DEVICE_NAMES.camera)
      )),
      meetingSpeakerDetected: currentDevices.some(device => (
        device.kind === 'audiooutput'
        && matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_DEVICE_NAMES.meetingSpeaker)
      )),
      virtualMicrophoneDetected: currentDevices.some(device => (
        device.kind === 'audioinput'
        && matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_DEVICE_NAMES.virtualMicrophone)
      )),
      obsVirtualCameraDetected: currentDevices.some(device => (
        device.kind === 'videoinput'
        && matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_COMPATIBILITY_NAMES.camera)
      )),
      blackHoleDetected: currentDevices.some(device => (
        device.kind === 'audiooutput'
        && matchesMeetingMediaDeviceName(device.label, MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone)
      )),
      labelsAvailable: currentDevices.some(device => device.label.length > 0),
    }
  })

  async function refresh(): Promise<void> {
    if (!mediaDevices?.enumerateDevices) {
      devices.value = []
      error.value = 'MEDIA_DEVICE_ENUMERATION_UNAVAILABLE'
      return
    }

    refreshing.value = true
    try {
      const [nextDevices, nextCaptureSources] = await Promise.all([
        mediaDevices.enumerateDevices(),
        screenCapture.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        }),
      ])
      devices.value = nextDevices
      captureSources.value = nextCaptureSources
      error.value = null
    }
    catch {
      devices.value = []
      captureSources.value = []
      error.value = 'MEDIA_DEVICE_ENUMERATION_FAILED'
    }
    finally {
      refreshing.value = false
    }
  }

  function handleDeviceChange(): void {
    void refresh()
  }

  /**
   * Requests camera consent and validates that the exact virtual camera can open.
   * Every temporary stream is stopped before the action resolves.
   */
  async function authorizeVideoInput(deviceName: string): Promise<MediaDeviceInfo> {
    if (!mediaDevices?.enumerateDevices || !mediaDevices.getUserMedia) {
      error.value = 'MEDIA_VIDEO_INPUT_AUTHORIZATION_UNAVAILABLE'
      throw new Error('The current Electron runtime cannot authorize a video input device.')
    }

    authorizingVideoInput.value = true
    let failureCode = 'MEDIA_VIDEO_INPUT_AUTHORIZATION_FAILED'
    try {
      let currentDevices = await mediaDevices.enumerateDevices()
      let matchingInput = currentDevices.find(device => (
        device.kind === 'videoinput'
        && matchesMeetingMediaDeviceName(device.label, deviceName)
      ))

      if (!matchingInput) {
        // macOS does not expose camera labels until the user approves an ordinary
        // camera request. This stream exists only for that permission transition.
        const permissionStream = await mediaDevices.getUserMedia({ audio: false, video: true })
        permissionStream.getTracks().forEach(track => track.stop())
        currentDevices = await mediaDevices.enumerateDevices()
        matchingInput = currentDevices.find(device => (
          device.kind === 'videoinput'
          && matchesMeetingMediaDeviceName(device.label, deviceName)
        ))
      }

      if (!matchingInput) {
        failureCode = 'MEDIA_MATCHING_VIDEO_INPUT_UNAVAILABLE'
        throw new Error(`The matching video input "${deviceName}" is unavailable.`)
      }

      const validationStream = await mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: matchingInput.deviceId } },
      })
      validationStream.getTracks().forEach(track => track.stop())

      const grantedDevices = await mediaDevices.enumerateDevices()
      const grantedInput = grantedDevices.find(device => (
        device.kind === 'videoinput'
        && device.deviceId === matchingInput.deviceId
        && matchesMeetingMediaDeviceName(device.label, deviceName)
      ))
      if (!grantedInput)
        throw new Error(`The matching video input "${deviceName}" was not granted.`)

      devices.value = grantedDevices
      error.value = null
      return grantedInput
    }
    catch (authorizationError) {
      error.value = failureCode
      throw authorizationError
    }
    finally {
      authorizingVideoInput.value = false
    }
  }

  /**
   * Grants access to an exact non-default output through its same-group audio input.
   * Chromium then permits the returned device to be used with `setSinkId()` without
   * changing the operating system's default output.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Audio_Output_Devices_API
   */
  async function authorizeAudioOutput(deviceName: string): Promise<MediaDeviceInfo> {
    if (!mediaDevices?.enumerateDevices || !mediaDevices.getUserMedia) {
      error.value = 'MEDIA_AUDIO_OUTPUT_AUTHORIZATION_UNAVAILABLE'
      throw new Error('The current Electron runtime cannot authorize an audio output device.')
    }

    authorizingAudioOutput.value = true
    let failureCode = 'MEDIA_AUDIO_OUTPUT_AUTHORIZATION_FAILED'
    try {
      let currentDevices = await mediaDevices.enumerateDevices()
      let matchingInput = currentDevices.find(device => (
        device.kind === 'audioinput'
        && matchesMeetingMediaDeviceName(device.label, deviceName)
      ))

      if (!matchingInput) {
        // Device labels are hidden until the app has ordinary microphone permission.
        // The permission stream is closed immediately and is never used as meeting input.
        const permissionStream = await mediaDevices.getUserMedia({ audio: true, video: false })
        permissionStream.getTracks().forEach(track => track.stop())
        currentDevices = await mediaDevices.enumerateDevices()
        matchingInput = currentDevices.find(device => (
          device.kind === 'audioinput'
          && matchesMeetingMediaDeviceName(device.label, deviceName)
        ))
      }

      if (!matchingInput) {
        failureCode = 'MEDIA_MATCHING_AUDIO_INPUT_UNAVAILABLE'
        throw new Error(`The matching audio input "${deviceName}" is unavailable.`)
      }

      const permissionStream = await mediaDevices.getUserMedia({
        audio: { deviceId: { exact: matchingInput.deviceId } },
        video: false,
      })
      permissionStream.getTracks().forEach(track => track.stop())

      const grantedDevices = await mediaDevices.enumerateDevices()
      const output = grantedDevices.find(device => (
        device.kind === 'audiooutput'
        && matchesMeetingMediaDeviceName(device.label, deviceName)
        && (!matchingInput.groupId || !device.groupId || device.groupId === matchingInput.groupId)
      ))
      if (!output)
        throw new Error(`The matching audio output "${deviceName}" was not granted.`)

      devices.value = grantedDevices
      error.value = null
      return output
    }
    catch (authorizationError) {
      error.value = failureCode
      throw authorizationError
    }
    finally {
      authorizingAudioOutput.value = false
    }
  }

  onMounted(() => {
    mediaDevices = navigator.mediaDevices
    mediaDevices?.addEventListener('devicechange', handleDeviceChange)
    void refresh()
  })

  onUnmounted(() => {
    mediaDevices?.removeEventListener('devicechange', handleDeviceChange)
    mediaDevices = undefined
  })

  return {
    inventory: readonly(inventory),
    captureSources: readonly(captureSources),
    error: readonly(error),
    refreshing: readonly(refreshing),
    authorizingVideoInput: readonly(authorizingVideoInput),
    authorizingAudioOutput: readonly(authorizingAudioOutput),
    refresh,
    authorizeVideoInput,
    authorizeAudioOutput,
  }
}
