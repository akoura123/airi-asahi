import type {
  MeetingMediaDevice,
  MeetingMediaError,
  MeetingMediaMetrics,
  MeetingMediaPcmChunk,
  MeetingMediaProfile,
  MeetingMediaRendererMetricsUpdate,
  MeetingMediaRendererPreflightResult,
  MeetingMediaRendererStartResult,
  MeetingMediaRoute,
} from '@proj-airi/stage-shared/meeting-media'

import { errorMessageFrom } from '@moeru/std'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { createInitialMeetingMediaMetrics, MEETING_MEDIA_COMPATIBILITY_NAMES } from '@proj-airi/stage-shared/meeting-media'
import { startMeetingAgentAudioOutput, stopMeetingAgentAudioOutput } from '@proj-airi/stage-ui/services/meeting-audio'
import { MeetingPcmNormalizer } from '@proj-airi/stage-ui/services/meeting-speech'
import { useMeetingSpeechSession } from '@proj-airi/stage-ui/services/meeting-speech-session'
import {
  getMeetingStageFrameSource,
  getMeetingVideoOutputSurface,
  MeetingVideoCompositor,
} from '@proj-airi/stage-ui/services/meeting-video'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { watch } from 'vue'

import { electronMeetingMediaPcmChunk } from '../../shared/eventa'
import { useChatSyncStore } from '../stores/chat-sync'
import { releaseMeetingSpeechInput, reserveMeetingSpeechInput } from './meeting-speech-input-controller'

interface ActiveCompatibilitySession {
  sessionId: string
  profile: MeetingMediaProfile
  remoteAudioNormalizer: MeetingPcmNormalizer | null
  speechInputReserved: boolean
  metrics: MeetingMediaMetrics
  metricsTimerId: number | null
  partialSegmentIds: Set<string>
  video: {
    compositor: MeetingVideoCompositor
    animationFrameId: number
    stopped: boolean
    metricsSampleStartedAt: number
    deliveredFramesAtSampleStart: number
  } | null
}

export interface MeetingMediaRendererHostOptions {
  reportRouteFailure: (error: MeetingMediaError) => void
  reportMetrics: (update: MeetingMediaRendererMetricsUpdate) => void
}

function routeError(params: {
  code: string
  category: MeetingMediaError['category']
  route: MeetingMediaRoute
  phase: MeetingMediaError['phase']
  sessionId?: string
  message: string
  action?: MeetingMediaError['action']
  cause?: string
}): MeetingMediaError {
  return {
    code: params.code,
    category: params.category,
    route: params.route,
    phase: params.phase,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    occurredAtMs: Date.now(),
    message: params.message,
    action: params.action ?? 'retry',
    ...(params.cause ? { cause: params.cause } : {}),
  }
}

function errorCause(error: unknown): string {
  return errorMessageFrom(error) ?? String(error)
}

/**
 * Owns the renderer data plane for one compatibility meeting session.
 * Main remains authoritative for session state and calls this host through Eventa.
 */
export function createMeetingMediaRendererHost(options: MeetingMediaRendererHostOptions) {
  const chatSyncStore = useChatSyncStore()
  const providersStore = useProvidersStore()
  const speechOutputControlStore = useSpeechOutputControlStore()
  const eventaContext = getElectronEventaContext()
  let active: ActiveCompatibilitySession | null = null

  function resolveAgentSpeechOutputError(
    phase: MeetingMediaError['phase'],
    sessionId?: string,
    profile: MeetingMediaProfile | undefined = active?.profile,
  ): MeetingMediaError | null {
    if (speechOutputControlStore.speechMuted) {
      return routeError({
        code: 'MEETING_MEDIA_AGENT_SPEECH_MUTED',
        category: 'OUTPUT',
        route: 'agent-audio-out',
        phase,
        sessionId,
        message: 'AIRI speech output is muted.',
        cause: 'Unmute AIRI speech output before using the meeting virtual microphone.',
      })
    }

    const providerId = profile?.tts.providerId
    const tts = profile?.tts
    const providerMetadata = providerId ? providersStore.findProviderMetadata(providerId) : undefined
    const providerConfigured = providerId ? providersStore.configuredProviders[providerId] : false
    if (!tts?.providerId || !tts.model || !tts.voiceId || providerMetadata?.category !== 'speech' || !providerConfigured) {
      return routeError({
        code: 'MEETING_MEDIA_TTS_PROVIDER_NOT_READY',
        category: 'PROVIDER',
        route: 'agent-audio-out',
        phase,
        sessionId,
        message: 'The meeting TTS provider is not ready to synthesize meeting audio.',
        cause: 'Select a configured meeting TTS provider, model, and voice before using the meeting virtual microphone.',
      })
    }

    return null
  }

  const stopSpeechOutputReadinessWatch = watch(
    [
      () => speechOutputControlStore.speechMuted,
      () => active?.profile.tts.providerId
        ? providersStore.configuredProviders[active.profile.tts.providerId]
        : undefined,
    ],
    () => {
      const session = active
      if (!session?.profile.agentAudio.enabled)
        return

      const error = resolveAgentSpeechOutputError('run', session.sessionId, session.profile)
      if (error)
        options.reportRouteFailure(error)
    },
  )

  function reportRuntimeFailure(
    sessionId: string,
    route: MeetingMediaRoute,
    category: MeetingMediaError['category'],
    code: string,
    message: string,
    error: unknown,
  ): void {
    if (active?.sessionId !== sessionId)
      return
    options.reportRouteFailure(routeError({
      code,
      category,
      route,
      phase: 'run',
      sessionId,
      message,
      cause: errorCause(error),
    }))
  }

  const speech = useMeetingSpeechSession({
    onPartial(event) {
      const session = active
      if (!session || session.sessionId !== event.sessionId || session.partialSegmentIds.has(event.segmentId))
        return

      session.partialSegmentIds.add(event.segmentId)
      session.metrics.remoteAudio.asrFirstPartialMs = Math.max(0, Date.now() - event.capturedAtMs)
    },
    async onTurnEnd(event) {
      const session = active
      if (!session || session.sessionId !== event.sessionId)
        return
      session.partialSegmentIds.delete(event.segmentId)
      session.metrics.remoteAudio.speechSegments += 1
      session.metrics.remoteAudio.asrFinalMs = Math.max(0, Date.now() - event.endedAtMs)
      try {
        await chatSyncStore.requestIngest({ text: event.text })
      }
      catch (error) {
        reportRuntimeFailure(
          event.sessionId,
          'remote-audio-in',
          'PROCESSING',
          'MEETING_MEDIA_DIALOGUE_INGEST_FAILED',
          'The recognized meeting turn could not be delivered to AIRI.',
          error,
        )
      }
    },
    onFailure(error) {
      const sessionId = active?.sessionId
      if (sessionId) {
        reportRuntimeFailure(
          sessionId,
          'remote-audio-in',
          'PROVIDER',
          'MEETING_MEDIA_SPEECH_PIPELINE_FAILED',
          'The meeting VAD or ASR pipeline failed.',
          error,
        )
      }
    },
    onVadInference(durationMs) {
      const session = active
      if (session)
        session.metrics.remoteAudio.vadInferenceMs = durationMs
    },
    onBufferedFrames(frames) {
      const session = active
      if (session)
        session.metrics.remoteAudio.bufferedFrames = frames
    },
  })

  const stopPcmSubscription = eventaContext.on(electronMeetingMediaPcmChunk, (event) => {
    const chunk: MeetingMediaPcmChunk | undefined = event.body
    const session = active
    // Session ID is the ownership boundary. Late native callbacks from an older helper are ignored
    // and can never enter a newly started VAD/ASR pipeline.
    if (!chunk
      || !session
      || chunk.sessionId !== session.sessionId
      || !session.remoteAudioNormalizer) {
      return
    }

    session.metrics.remoteAudio.sampleRate = chunk.sampleRate
    session.metrics.remoteAudio.channels = chunk.channelCount
    session.metrics.remoteAudio.callbackDelayMs = Math.max(0, Date.now() - chunk.capturedAtMs)
    let sampleEnergy = 0
    for (const sample of chunk.samples)
      sampleEnergy += sample * sample
    session.metrics.remoteAudio.inputLevel = Math.sqrt(sampleEnergy / chunk.samples.length)
    try {
      for (const frame of session.remoteAudioNormalizer.push(chunk))
        speech.push(frame)
    }
    catch (error) {
      reportRuntimeFailure(
        session.sessionId,
        'remote-audio-in',
        'PROCESSING',
        'MEETING_MEDIA_PCM_PIPELINE_FAILED',
        'The application-filtered meeting PCM stream could not be normalized or processed.',
        error,
      )
    }
  })

  async function startVideo(session: ActiveCompatibilitySession): Promise<MeetingMediaDevice> {
    const source = getMeetingStageFrameSource()
    const output = getMeetingVideoOutputSurface()
    if (!source || !output)
      throw new Error('The main Stage frame source or clean output canvas is unavailable.')

    const firstSourceFrame = source.read()
    if (!firstSourceFrame)
      throw new Error('The active Stage renderer has no complete canvas frame.')

    const compositor = new MeetingVideoCompositor(output.canvas)
    const initialComposeStartedAt = performance.now()
    session.metrics.video.requestedFrames += 1
    await compositor.compose({ source: firstSourceFrame, profile: session.profile.video })
    session.metrics.video.deliveredFrames += 1
    session.metrics.video.compositorLatencyMs = performance.now() - initialComposeStartedAt

    const video = {
      compositor,
      animationFrameId: 0,
      stopped: false,
      metricsSampleStartedAt: performance.now(),
      deliveredFramesAtSampleStart: session.metrics.video.deliveredFrames,
    }
    session.video = video
    const frameIntervalMs = 1000 / session.profile.video.fps
    let lastFrameAt = performance.now()
    let composing = false

    const render = (now: number) => {
      if (video.stopped || active?.sessionId !== session.sessionId)
        return
      video.animationFrameId = requestAnimationFrame(render)
      const elapsedSinceFrameMs = now - lastFrameAt
      if (composing || elapsedSinceFrameMs < frameIntervalMs)
        return

      session.metrics.video.requestedFrames += 1
      const frame = source.read()
      if (!frame) {
        session.metrics.video.droppedFrames += 1
        reportRuntimeFailure(
          session.sessionId,
          'video-out',
          'PROCESSING',
          'MEETING_MEDIA_STAGE_FRAME_UNAVAILABLE',
          'The active Stage stopped providing meeting frames.',
          new Error('Stage frame source returned no frame.'),
        )
        return
      }

      // Preserve the fixed output cadence instead of resetting it to each rAF timestamp.
      // Otherwise sub-millisecond rAF jitter repeatedly pushes a nominal 30 fps frame to
      // the third 60 Hz callback, producing a visibly lower long-run frame rate.
      lastFrameAt = now - (elapsedSinceFrameMs % frameIntervalMs)
      composing = true
      session.metrics.video.occupiedSlots = 1
      const composeStartedAt = performance.now()
      void compositor.compose({ source: frame, profile: session.profile.video })
        .then(() => {
          session.metrics.video.deliveredFrames += 1
          session.metrics.video.compositorLatencyMs = performance.now() - composeStartedAt
        })
        .catch(error => reportRuntimeFailure(
          session.sessionId,
          'video-out',
          'PROCESSING',
          'MEETING_MEDIA_VIDEO_COMPOSITION_FAILED',
          'The clean meeting video surface could not be updated.',
          error,
        ))
        .finally(() => {
          composing = false
          session.metrics.video.occupiedSlots = 0
        })
    }
    video.animationFrameId = requestAnimationFrame(render)

    return {
      id: 'airi-meeting-output-window',
      name: MEETING_MEDIA_COMPATIBILITY_NAMES.outputWindow,
      kind: 'camera',
      backend: 'obs-window-capture',
    }
  }

  async function startRemoteAudio(session: ActiveCompatibilitySession): Promise<MeetingMediaDevice> {
    const sourceId = session.profile.receiveAudio.captureSourceId
    const sourceName = session.profile.receiveAudio.captureSourceName
    await speech.start({
      sessionId: session.sessionId,
      profile: session.profile.speech,
    })
    session.remoteAudioNormalizer = new MeetingPcmNormalizer({
      sessionId: session.sessionId,
      maxFramesPerPush: 64,
    })

    return {
      id: sourceId,
      name: sourceName,
      kind: 'meeting-speaker',
      backend: 'screencapturekit-application-audio',
    }
  }

  async function startAgentAudio(session: ActiveCompatibilitySession): Promise<MeetingMediaDevice> {
    await startMeetingAgentAudioOutput({
      sessionId: session.sessionId,
      outputDeviceId: session.profile.agentAudio.outputDeviceId,
      outputDeviceName: session.profile.agentAudio.outputDeviceName,
      localMonitor: session.profile.agentAudio.localMonitor,
      onFailure: error => reportRuntimeFailure(
        session.sessionId,
        'agent-audio-out',
        'OUTPUT',
        'MEETING_MEDIA_AGENT_OUTPUT_FAILED',
        'AIRI speech could not be synthesized or written to the selected virtual audio output.',
        error,
      ),
    })

    return {
      id: session.profile.agentAudio.outputDeviceId,
      name: session.profile.agentAudio.outputDeviceName,
      kind: 'virtual-microphone',
      backend: 'html-media-sink',
    }
  }

  async function preflight(profile: MeetingMediaProfile, sessionId?: string): Promise<MeetingMediaRendererPreflightResult> {
    if (profile.receiveAudio.enabled) {
      try {
        await speech.preflight(profile.speech)
      }
      catch (error) {
        return {
          ready: false,
          error: routeError({
            code: 'MEETING_MEDIA_SPEECH_PROVIDER_NOT_READY',
            category: 'PROVIDER',
            route: 'remote-audio-in',
            phase: 'preflight',
            sessionId,
            message: 'The selected meeting ASR provider is not ready for this recognition mode.',
            action: 'configure-speech-recognition',
            cause: errorCause(error),
          }),
        }
      }
    }

    if (profile.agentAudio.enabled) {
      const error = resolveAgentSpeechOutputError('preflight', sessionId, profile)
      if (error)
        return { ready: false, error }
    }

    return { ready: true }
  }

  async function stop(sessionId: string): Promise<void> {
    const session = active
    if (!session || session.sessionId !== sessionId)
      return

    active = null
    if (session.metricsTimerId !== null) {
      window.clearInterval(session.metricsTimerId)
      session.metricsTimerId = null
    }
    let cleanupError: unknown

    try {
      await speech.stop(sessionId)
    }
    catch (error) {
      cleanupError = error
    }

    if (session.remoteAudioNormalizer) {
      session.remoteAudioNormalizer.dispose()
      session.remoteAudioNormalizer = null
    }
    stopMeetingAgentAudioOutput(sessionId)
    if (session.video) {
      session.video.stopped = true
      cancelAnimationFrame(session.video.animationFrameId)
      session.video.compositor.dispose()
      session.video = null
    }

    if (session.speechInputReserved) {
      session.speechInputReserved = false
      try {
        await releaseMeetingSpeechInput(sessionId)
      }
      catch (error) {
        cleanupError ??= error
      }
    }

    if (cleanupError)
      throw cleanupError
  }

  async function start(sessionId: string, profile: MeetingMediaProfile): Promise<MeetingMediaRendererStartResult> {
    if (active)
      throw new Error(`Meeting renderer host is already owned by session "${active.sessionId}".`)
    if (profile.backend !== 'compatibility')
      throw new Error(`Renderer compatibility host cannot start backend "${profile.backend}".`)

    const session: ActiveCompatibilitySession = {
      sessionId,
      profile: structuredClone(profile),
      remoteAudioNormalizer: null,
      speechInputReserved: false,
      metrics: createInitialMeetingMediaMetrics(),
      metricsTimerId: null,
      partialSegmentIds: new Set(),
      video: null,
    }
    session.metrics.agentAudio.localMonitorActive = profile.agentAudio.enabled && profile.agentAudio.localMonitor
    active = session
    const devices: MeetingMediaDevice[] = []
    let startingRoute: MeetingMediaRoute | null = null

    try {
      if (profile.video.enabled) {
        startingRoute = 'video-out'
        devices.push(await startVideo(session))
      }
      if (profile.receiveAudio.enabled) {
        startingRoute = 'remote-audio-in'
        await reserveMeetingSpeechInput(sessionId)
        session.speechInputReserved = true
        devices.push(await startRemoteAudio(session))
      }
      if (profile.agentAudio.enabled) {
        startingRoute = 'agent-audio-out'
        devices.push(await startAgentAudio(session))
      }
      session.metricsTimerId = window.setInterval(() => {
        if (active?.sessionId !== session.sessionId)
          return

        const now = performance.now()
        if (session.video) {
          const elapsedMs = now - session.video.metricsSampleStartedAt
          const deliveredFrames = session.metrics.video.deliveredFrames - session.video.deliveredFramesAtSampleStart
          session.metrics.video.actualFps = elapsedMs > 0 ? deliveredFrames * 1000 / elapsedMs : 0
          session.video.metricsSampleStartedAt = now
          session.video.deliveredFramesAtSampleStart = session.metrics.video.deliveredFrames
        }
        options.reportMetrics({
          sessionId: session.sessionId,
          measuredAtMs: Date.now(),
          metrics: structuredClone(session.metrics),
        })
      }, 1000)
      return { ready: true, devices }
    }
    catch (error) {
      if (!startingRoute)
        throw error

      const resultError = routeError({
        code: 'MEETING_MEDIA_RENDERER_ROUTE_START_FAILED',
        category: startingRoute === 'agent-audio-out' ? 'OUTPUT' : 'PROCESSING',
        route: startingRoute,
        phase: 'start',
        sessionId,
        message: 'A required compatibility media route could not be started.',
        cause: errorCause(error),
      })
      await stop(sessionId)
      return { ready: false, devices, error: resultError }
    }
  }

  async function dispose(): Promise<void> {
    stopPcmSubscription()
    stopSpeechOutputReadinessWatch()
    if (active)
      await stop(active.sessionId)
  }

  return { preflight, start, stop, dispose }
}
