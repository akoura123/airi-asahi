import type {
  MeetingMediaDevice,
  MeetingMediaError,
  MeetingMediaMetrics,
  MeetingMediaProfile,
  MeetingMediaRendererMetricsUpdate,
  MeetingMediaRendererStartResult,
  MeetingMediaRoute,
} from '@proj-airi/stage-shared/meeting-media'

import { errorMessageFrom } from '@moeru/std'
import { setupElectronScreenCapture } from '@proj-airi/electron-screen-capture/renderer'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { createInitialMeetingMediaMetrics, MEETING_MEDIA_COMPATIBILITY_NAMES } from '@proj-airi/stage-shared/meeting-media'
import { startMeetingAgentAudioOutput, stopMeetingAgentAudioOutput } from '@proj-airi/stage-ui/services/meeting-audio'
import { useMeetingSpeechSession } from '@proj-airi/stage-ui/services/meeting-speech-session'
import {
  getMeetingStageFrameSource,
  getMeetingVideoOutputSurface,
  MeetingVideoCompositor,
} from '@proj-airi/stage-ui/services/meeting-video'

import { useChatSyncStore } from '../stores/chat-sync'
import { releaseMeetingSpeechInput, reserveMeetingSpeechInput } from './meeting-speech-input-controller'

interface ActiveCompatibilitySession {
  sessionId: string
  profile: MeetingMediaProfile
  remoteAudioStream: MediaStream | null
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
  sessionId: string
  message: string
  cause?: string
}): MeetingMediaError {
  return {
    code: params.code,
    category: params.category,
    route: params.route,
    phase: params.phase,
    sessionId: params.sessionId,
    occurredAtMs: Date.now(),
    message: params.message,
    action: 'retry',
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
  const screenCapture = setupElectronScreenCapture(getElectronEventaContext())
  let active: ActiveCompatibilitySession | null = null

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
    const stream = await screenCapture.selectWithSource(
      (sources) => {
        const source = sources.find(item => item.id === sourceId && (!sourceName || item.name === sourceName))
        if (!source)
          throw new Error('The exact meeting capture source is no longer available.')
        return source.id
      },
      () => navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      }),
      {
        sourcesOptions: { types: ['window'] },
        request: { timeout: 15000 },
      },
    )

    for (const videoTrack of stream.getVideoTracks()) {
      videoTrack.stop()
      stream.removeTrack(videoTrack)
    }
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('The selected meeting source returned no audio track.')
    }

    session.remoteAudioStream = stream
    const audioTrack = stream.getAudioTracks()[0]
    const audioSettings = audioTrack?.getSettings()
    session.metrics.remoteAudio.sampleRate = audioSettings?.sampleRate ?? 0
    session.metrics.remoteAudio.channels = audioSettings?.channelCount ?? 0
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => reportRuntimeFailure(
        session.sessionId,
        'remote-audio-in',
        'DEVICE',
        'MEETING_MEDIA_CAPTURE_STREAM_ENDED',
        'The selected meeting audio capture stream ended.',
        new Error(`Audio track "${track.label}" ended.`),
      ), { once: true })
    }

    await speech.start({
      sessionId: session.sessionId,
      stream,
      profile: session.profile.speech,
    })

    return {
      id: sourceId,
      name: sourceName,
      kind: 'meeting-speaker',
      backend: 'electron-screencapturekit',
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
        'AIRI speech could not be written to the selected virtual audio output.',
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
    finally {
      session.remoteAudioStream?.getTracks().forEach(track => track.stop())
      session.remoteAudioStream = null
      stopMeetingAgentAudioOutput(sessionId)
      if (session.video) {
        session.video.stopped = true
        cancelAnimationFrame(session.video.animationFrameId)
        session.video.compositor.dispose()
        session.video = null
      }
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
      remoteAudioStream: null,
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

  return { start, stop }
}
