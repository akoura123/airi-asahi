import { boolean, check, finite, integer, literal, maxValue, minValue, nonEmpty, number, picklist, pipe, safeParse, strictObject, string, trim, union } from 'valibot'

/** Protocol version shared by the renderer, Electron main, and native media components. */
export const MEETING_MEDIA_PROTOCOL_VERSION = 1 as const

/** Stable media routes coordinated by one meeting session. */
export const MEETING_MEDIA_ROUTES = [
  'video-out',
  'remote-audio-in',
  'agent-audio-out',
] as const

/** Stable operating-system device names used by installation probes and user guidance. */
export const MEETING_MEDIA_DEVICE_NAMES = {
  camera: 'AIRI Virtual Camera',
  meetingSpeaker: 'AIRI Meeting Speaker',
  virtualMicrophone: 'AIRI Virtual Microphone',
} as const

/** External devices and capture surface used by the explicitly selected compatibility backend. */
export const MEETING_MEDIA_COMPATIBILITY_NAMES = {
  camera: 'OBS Virtual Camera',
  outputWindow: 'AIRI Meeting Output',
  virtualMicrophone: 'BlackHole 2ch',
} as const

const CHROMIUM_CORE_AUDIO_VIRTUAL_DEVICE_SUFFIX = ' (Virtual)'

/**
 * Matches a browser media-device label against its stable operating-system name.
 *
 * Chromium's macOS CoreAudio adapter appends the transport annotation ` (Virtual)`
 * to virtual audio devices. The exact `deviceId` remains the runtime identity; this
 * matcher is only used for discovery and name-drift validation at browser boundaries.
 *
 * @see https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/audio/mac/core_audio_util_mac.cc
 */
export function matchesMeetingMediaDeviceName(browserLabel: string, stableName: string): boolean {
  const normalizedLabel = browserLabel.trim()
  const normalizedStableName = stableName.trim()
  return normalizedLabel === normalizedStableName
    || normalizedLabel === `${normalizedStableName}${CHROMIUM_CORE_AUDIO_VIRTUAL_DEVICE_SUFFIX}`
}

export type MeetingMediaRoute = typeof MEETING_MEDIA_ROUTES[number]
export type MeetingMediaPlatform = 'darwin' | 'win32' | 'linux'
export type MeetingMediaBackend = 'native' | 'compatibility'
export type MeetingMediaSessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'error'
export type MeetingMediaRouteState = 'idle' | 'starting' | 'running' | 'stopping' | 'error'
export type MeetingMediaErrorCategory = 'INSTALLATION' | 'PERMISSION' | 'DEVICE' | 'TRANSPORT' | 'PROCESSING' | 'PROVIDER' | 'OUTPUT'
export type MeetingMediaErrorPhase = 'preflight' | 'start' | 'run' | 'stop'
export type MeetingMediaRecoveryAction = 'install-native-component' | 'approve-system-extension' | 'open-media-permissions' | 'select-device' | 'configure-speech-recognition' | 'restart-client' | 'retry' | 'update-os'

/** Background source composited behind transparent character pixels. */
export type MeetingMediaVideoBackground
  = | { kind: 'stage' }
    | { kind: 'color', value: string }
    | { kind: 'image', backgroundId: string }

/** Persisted video output choices. */
export interface MeetingMediaVideoProfile {
  enabled: boolean
  width: 1280 | 1920
  height: 720 | 1080
  fps: 30
  fit: 'contain' | 'cover'
  background: MeetingMediaVideoBackground
  /** Mirrors the source sent to clients; conferencing-client preview mirroring remains separate. */
  mirrorSource: boolean
}

/** Persisted meeting receive-bus choices. */
export interface MeetingMediaReceiveAudioProfile {
  enabled: boolean
  /** Exact desktop-capture source used by the compatibility backend. */
  captureSourceId: string
  /** Human-readable source name retained for diagnostics; it never replaces exact ID matching. */
  captureSourceName: string
  /** Exact physical output selected for local monitoring; an empty value means not configured. */
  monitorDeviceId: string
  /** Linear monitor gain in the supported 0-2 range. */
  monitorGain: number
}

/** VAD settings frozen when a meeting session starts. */
export interface MeetingMediaVadProfile {
  threshold: number
  minSilenceDurationMs: number
  speechPadMs: number
  minSpeechDurationMs: number
}

/** Persisted speech-recognition choices for meeting audio. */
export interface MeetingMediaSpeechProfile {
  locale: string
  providerId: string
  model: string
  mode: 'streaming' | 'batch'
  vad: MeetingMediaVadProfile
}

/** Persisted speech-output choices used only while the meeting media session is active. */
export interface MeetingMediaTtsProfile {
  providerId: string
  model: string
  voiceId: string
  voiceName: string
}

/** Persisted AIRI speech-output choices. */
export interface MeetingMediaAgentAudioProfile {
  enabled: boolean
  localMonitor: boolean
  /** Exact browser audio-output device used as the compatibility virtual microphone. */
  outputDeviceId: string
  /** Human-readable output name retained for diagnostics; it never replaces exact ID matching. */
  outputDeviceName: string
}

/**
 * Complete persisted configuration frozen into one meeting-media session.
 *
 * `schemaVersion` only versions this serialized profile. Native transport compatibility uses
 * {@link MEETING_MEDIA_PROTOCOL_VERSION} independently.
 */
export interface MeetingMediaProfile {
  schemaVersion: 3
  /** Explicit session implementation; no runtime fallback occurs between backends. */
  backend: MeetingMediaBackend
  video: MeetingMediaVideoProfile
  receiveAudio: MeetingMediaReceiveAudioProfile
  speech: MeetingMediaSpeechProfile
  tts: MeetingMediaTtsProfile
  agentAudio: MeetingMediaAgentAudioProfile
  duplexPolicy: 'full-duplex' | 'half-duplex'
}

/** Machine-readable failure retained in runtime state and safe diagnostics. */
export interface MeetingMediaError {
  code: string
  category: MeetingMediaErrorCategory
  route?: MeetingMediaRoute
  phase: MeetingMediaErrorPhase
  sessionId?: string
  occurredAtMs: number
  message: string
  /** Stable action key localized by the renderer. */
  action?: MeetingMediaRecoveryAction
  /** Sanitized underlying reason; raw media and credentials are forbidden. */
  cause?: string
}

export type MeetingMediaDeviceKind = 'camera' | 'meeting-speaker' | 'virtual-microphone' | 'monitor'

/** Device identity resolved by the active platform adapter. */
export interface MeetingMediaDevice {
  id: string
  name: string
  kind: MeetingMediaDeviceKind
  backend: string
  version?: string
}

export type MeetingMediaSupportState = 'supported' | 'unsupported'
export type MeetingMediaComponentState = 'ready' | 'not-bundled' | 'not-installed' | 'unverified' | 'not-required'
export type MeetingMediaPermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unavailable' | 'not-required'

/** Result of checking one route without allocating media resources. */
export interface MeetingMediaRoutePreflight {
  route: MeetingMediaRoute
  required: boolean
  ready: boolean
  support: MeetingMediaSupportState
  component: MeetingMediaComponentState
  permission: MeetingMediaPermissionState
  devices: MeetingMediaDevice[]
  issues: MeetingMediaError[]
}

/** Immutable capability snapshot produced immediately before a start attempt. */
export interface MeetingMediaPreflight {
  protocolVersion: typeof MEETING_MEDIA_PROTOCOL_VERSION
  platform: MeetingMediaPlatform
  systemVersion: string
  checkedAtMs: number
  ready: boolean
  routes: Record<MeetingMediaRoute, MeetingMediaRoutePreflight>
}

/** Runtime state for a single media route. */
export interface MeetingMediaRouteRuntime {
  route: MeetingMediaRoute
  required: boolean
  state: MeetingMediaRouteState
  lastError: MeetingMediaError | null
}

/** Low-frequency metrics safe to expose to renderer diagnostics. */
export interface MeetingMediaMetrics {
  video: {
    requestedFrames: number
    deliveredFrames: number
    repeatedFrames: number
    droppedFrames: number
    actualFps: number
    compositorLatencyMs: number
    transportLatencyMs: number
    occupiedSlots: number
  }
  remoteAudio: {
    sampleRate: number
    channels: number
    callbackDelayMs: number
    bufferedFrames: number
    inputLevel: number
    monitorLevel: number
    vadInferenceMs: number
    speechSegments: number
    asrFirstPartialMs: number
    asrFinalMs: number
    staleResults: number
    backpressureFailures: number
  }
  agentAudio: {
    writeLatencyMs: number
    underruns: number
    localMonitorActive: boolean
  }
}

/** Correlated renderer snapshot used to refresh process-owned session diagnostics. */
export interface MeetingMediaRendererMetricsUpdate {
  /** Active process session that produced this snapshot. */
  sessionId: string
  /** Renderer wall-clock time when the snapshot was measured, in milliseconds. */
  measuredAtMs: number
  /** Complete low-frequency snapshot; transcript text and credentials are never included. */
  metrics: MeetingMediaMetrics
}

/** Read-only session snapshot shared with every renderer window. */
export interface MeetingMediaRuntime {
  sessionId: string | null
  state: MeetingMediaSessionState
  /** Configuration snapshot owned by the active or failed session. */
  activeProfile: MeetingMediaProfile | null
  startedAtMs: number | null
  endedAtMs: number | null
  updatedAtMs: number
  routes: Record<MeetingMediaRoute, MeetingMediaRouteRuntime>
  devices: MeetingMediaDevice[]
  metrics: MeetingMediaMetrics
  preflight: MeetingMediaPreflight | null
  lastError: MeetingMediaError | null
}

/** Result of a start or stop command, including rejected stale/re-entrant requests. */
export interface MeetingMediaCommandResult {
  accepted: boolean
  runtime: MeetingMediaRuntime
  error: MeetingMediaError | null
}

/** Main-to-renderer allocation request for the compatibility media data plane. */
export interface MeetingMediaRendererStartRequest {
  sessionId: string
  profile: MeetingMediaProfile
}

/** Main-to-renderer readiness probe for profile-owned processing such as VAD and ASR. */
export interface MeetingMediaRendererPreflightRequest {
  profile: MeetingMediaProfile
  /** Present during start so a rejected profile remains correlated with its process session. */
  sessionId?: string
}

/** Renderer readiness result produced without allocating meeting media resources. */
export type MeetingMediaRendererPreflightResult
  = | { ready: true }
    | { ready: false, error: MeetingMediaError }

/** Renderer allocation acknowledgement used before Main may publish `running`. */
export type MeetingMediaRendererStartResult
  = | { ready: true, devices: MeetingMediaDevice[] }
    | { ready: false, devices: MeetingMediaDevice[], error: MeetingMediaError }

/** Correlated renderer cleanup request that cannot stop a newer session. */
export interface MeetingMediaRendererStopRequest {
  sessionId: string
}

/** Header stored next to a complete BGRA frame in the bounded native transport. */
export interface MeetingMediaVideoFrameHeader {
  protocolVersion: typeof MEETING_MEDIA_PROTOCOL_VERSION
  sessionId: string
  sequence: number
  capturedAtMs: number
  width: number
  height: number
  stride: number
  pixelFormat: 'bgra8'
}

/** Interleaved native PCM chunk before meeting-mode downmix and resampling. */
export interface MeetingMediaPcmChunk {
  sessionId: string
  sequence: number
  capturedAtMs: number
  sampleRate: number
  channelCount: number
  layout: 'interleaved'
  samples: Float32Array
}

/** Canonical VAD input frame: 16 kHz mono Float32 with exactly 512 samples. */
export interface MeetingMediaPcmFrame {
  sessionId: string
  sequence: number
  capturedAtMs: number
  sampleRate: 16000
  channelCount: 1
  samples: Float32Array
}

interface MeetingMediaSpeechEventBase {
  sessionId: string
  segmentId: string
  sequence: number
  capturedAtMs: number
}

/** VAD-authoritative speech events consumed by either recognition adapter. */
export type MeetingMediaSpeechEvent
  = | (MeetingMediaSpeechEventBase & { type: 'speech-start' })
    | (MeetingMediaSpeechEventBase & { type: 'speech-frame', samples: Float32Array, sampleRate: 16000 })
    | (MeetingMediaSpeechEventBase & { type: 'speech-end', endedAtMs: number })

interface MeetingMediaTranscriptEventBase {
  sessionId: string
  segmentId: string
  sequence: number
  capturedAtMs: number
  text: string
}

/** Transcript lifecycle where only `turn-end` may enter the chat ingestion boundary. */
export type MeetingMediaTranscriptEvent
  = | (MeetingMediaTranscriptEventBase & { type: 'partial' })
    | (MeetingMediaTranscriptEventBase & { type: 'final' })
    | (MeetingMediaTranscriptEventBase & { type: 'turn-end', endedAtMs: number })

const finiteNumberSchema = pipe(number(), finite())
const nonNegativeIntegerSchema = pipe(number(), finite(), integer(), minValue(0))
const positiveDurationSchema = pipe(number(), finite(), integer(), minValue(1))
const nonEmptyStringSchema = pipe(string(), trim(), nonEmpty())

const MeetingMediaVideoBackgroundSchema = union([
  strictObject({ kind: literal('stage') }),
  strictObject({ kind: literal('color'), value: nonEmptyStringSchema }),
  strictObject({ kind: literal('image'), backgroundId: nonEmptyStringSchema }),
])

const MeetingMediaVideoProfileSchema = pipe(
  strictObject({
    enabled: boolean(),
    width: picklist([1280, 1920]),
    height: picklist([720, 1080]),
    fps: literal(30),
    fit: picklist(['contain', 'cover']),
    background: MeetingMediaVideoBackgroundSchema,
    mirrorSource: boolean(),
  }),
  check(
    profile => (profile.width === 1280 && profile.height === 720)
      || (profile.width === 1920 && profile.height === 1080),
    'Meeting video resolution must be 1280x720 or 1920x1080.',
  ),
)

const MeetingMediaReceiveAudioProfileSchema = strictObject({
  enabled: boolean(),
  captureSourceId: string(),
  captureSourceName: string(),
  monitorDeviceId: string(),
  monitorGain: pipe(finiteNumberSchema, minValue(0), maxValue(2)),
})

const MeetingMediaVadProfileSchema = strictObject({
  threshold: pipe(finiteNumberSchema, minValue(0), maxValue(1)),
  minSilenceDurationMs: positiveDurationSchema,
  speechPadMs: nonNegativeIntegerSchema,
  minSpeechDurationMs: positiveDurationSchema,
})

const MeetingMediaSpeechProfileSchema = strictObject({
  locale: string(),
  providerId: string(),
  model: string(),
  mode: picklist(['streaming', 'batch']),
  vad: MeetingMediaVadProfileSchema,
})

const MeetingMediaTtsProfileSchema = strictObject({
  providerId: string(),
  model: string(),
  voiceId: string(),
  voiceName: string(),
})

const MeetingMediaAgentAudioProfileSchema = strictObject({
  enabled: boolean(),
  localMonitor: boolean(),
  outputDeviceId: string(),
  outputDeviceName: string(),
})

export const MeetingMediaProfileSchema = pipe(
  strictObject({
    schemaVersion: literal(3),
    backend: picklist(['native', 'compatibility']),
    video: MeetingMediaVideoProfileSchema,
    receiveAudio: MeetingMediaReceiveAudioProfileSchema,
    speech: MeetingMediaSpeechProfileSchema,
    tts: MeetingMediaTtsProfileSchema,
    agentAudio: MeetingMediaAgentAudioProfileSchema,
    duplexPolicy: picklist(['full-duplex', 'half-duplex']),
  }),
  check(
    profile => profile.video.enabled || profile.receiveAudio.enabled || profile.agentAudio.enabled,
    'At least one meeting media route must be enabled.',
  ),
  check(
    profile => profile.backend !== 'compatibility' || profile.duplexPolicy === 'full-duplex',
    'The isolated compatibility audio routes require full-duplex operation.',
  ),
)

/** Returns a fresh default profile suitable for persistence and later explicit configuration. */
export function createDefaultMeetingMediaProfile(): MeetingMediaProfile {
  return {
    schemaVersion: 3,
    backend: 'compatibility',
    video: {
      enabled: true,
      width: 1280,
      height: 720,
      fps: 30,
      fit: 'contain',
      background: { kind: 'stage' },
      mirrorSource: false,
    },
    receiveAudio: {
      enabled: true,
      captureSourceId: '',
      captureSourceName: '',
      monitorDeviceId: '',
      monitorGain: 1,
    },
    speech: {
      locale: 'zh-CN',
      providerId: 'volcengine-transcription',
      model: 'volc.seedasr.sauc.duration',
      mode: 'streaming',
      vad: {
        threshold: 0.52,
        minSilenceDurationMs: 600,
        speechPadMs: 360,
        minSpeechDurationMs: 300,
      },
    },
    tts: {
      providerId: 'volcengine',
      model: 'seed-tts-2.0',
      voiceId: '',
      voiceName: '',
    },
    agentAudio: {
      enabled: true,
      localMonitor: true,
      outputDeviceId: '',
      outputDeviceName: '',
    },
    duplexPolicy: 'full-duplex',
  }
}

const MeetingMediaProfileV2Schema = pipe(
  strictObject({
    schemaVersion: literal(2),
    backend: picklist(['native', 'compatibility']),
    video: MeetingMediaVideoProfileSchema,
    receiveAudio: MeetingMediaReceiveAudioProfileSchema,
    speech: MeetingMediaSpeechProfileSchema,
    agentAudio: MeetingMediaAgentAudioProfileSchema,
    duplexPolicy: picklist(['full-duplex', 'half-duplex']),
  }),
  check(
    profile => profile.video.enabled || profile.receiveAudio.enabled || profile.agentAudio.enabled,
    'At least one meeting media route must be enabled.',
  ),
  check(
    profile => profile.backend !== 'compatibility' || profile.duplexPolicy === 'full-duplex',
    'The isolated compatibility audio routes require full-duplex operation.',
  ),
)

/**
 * Migrates the persisted v2 meeting profile to the v3 ASR/TTS profile shape.
 *
 * This is a storage migration only. Eventa and runtime boundaries accept v3
 * profiles through {@link parseMeetingMediaProfile}; unsupported persisted
 * values are discarded by the caller instead of entering the media session.
 */
export function migrateMeetingMediaProfile(profile: unknown): MeetingMediaProfile | undefined {
  const result = safeParse(MeetingMediaProfileV2Schema, profile)
  if (!result.success)
    return undefined

  const previous = result.output
  const locale = previous.speech.locale.trim() || 'zh-CN'
  const speech = previous.speech.providerId === 'alibaba-cloud-model-studio-transcription'
    ? {
        ...previous.speech,
        locale,
        providerId: 'volcengine-transcription',
        model: 'volc.seedasr.sauc.duration',
        mode: 'streaming' as const,
        vad: {
          ...previous.speech.vad,
          minSilenceDurationMs: previous.speech.vad.minSilenceDurationMs === 1200
            ? 600
            : previous.speech.vad.minSilenceDurationMs,
        },
      }
    : {
        ...previous.speech,
        locale,
        vad: {
          ...previous.speech.vad,
          // v2's 1200 ms value was the shipped default. Lower only that
          // untouched default; preserve an explicitly tuned user value.
          minSilenceDurationMs: previous.speech.vad.minSilenceDurationMs === 1200
            ? 600
            : previous.speech.vad.minSilenceDurationMs,
        },
      }

  return {
    ...previous,
    schemaVersion: 3,
    speech,
    tts: createDefaultMeetingMediaProfile().tts,
  }
}

/** Validates an untrusted persisted or Eventa profile and returns an isolated object. */
export function parseMeetingMediaProfile(profile: unknown): MeetingMediaProfile {
  const result = safeParse(MeetingMediaProfileSchema, profile)
  if (!result.success)
    throw new TypeError('Invalid meeting media profile.')

  return result.output
}

/** Resolves which routes must be ready before the session can enter `running`. */
export function resolveRequiredMeetingMediaRoutes(profile: MeetingMediaProfile): MeetingMediaRoute[] {
  return MEETING_MEDIA_ROUTES.filter((route) => {
    if (route === 'video-out')
      return profile.video.enabled
    if (route === 'remote-audio-in')
      return profile.receiveAudio.enabled
    return profile.agentAudio.enabled
  })
}

/** Creates zeroed metrics without sharing nested mutable objects between sessions. */
export function createInitialMeetingMediaMetrics(): MeetingMediaMetrics {
  return {
    video: {
      requestedFrames: 0,
      deliveredFrames: 0,
      repeatedFrames: 0,
      droppedFrames: 0,
      actualFps: 0,
      compositorLatencyMs: 0,
      transportLatencyMs: 0,
      occupiedSlots: 0,
    },
    remoteAudio: {
      sampleRate: 0,
      channels: 0,
      callbackDelayMs: 0,
      bufferedFrames: 0,
      inputLevel: 0,
      monitorLevel: 0,
      vadInferenceMs: 0,
      speechSegments: 0,
      asrFirstPartialMs: 0,
      asrFinalMs: 0,
      staleResults: 0,
      backpressureFailures: 0,
    },
    agentAudio: {
      writeLatencyMs: 0,
      underruns: 0,
      localMonitorActive: false,
    },
  }
}

/** Creates the canonical idle runtime snapshot. */
export function createInitialMeetingMediaRuntime(nowMs: number = Date.now()): MeetingMediaRuntime {
  return {
    sessionId: null,
    state: 'idle',
    activeProfile: null,
    startedAtMs: null,
    endedAtMs: null,
    updatedAtMs: nowMs,
    routes: {
      'video-out': { route: 'video-out', required: false, state: 'idle', lastError: null },
      'remote-audio-in': { route: 'remote-audio-in', required: false, state: 'idle', lastError: null },
      'agent-audio-out': { route: 'agent-audio-out', required: false, state: 'idle', lastError: null },
    },
    devices: [],
    metrics: createInitialMeetingMediaMetrics(),
    preflight: null,
    lastError: null,
  }
}
