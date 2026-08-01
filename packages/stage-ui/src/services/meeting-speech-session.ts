import type {
  MeetingMediaPcmFrame,
  MeetingMediaSpeechEvent,
  MeetingMediaSpeechProfile,
  MeetingMediaTranscriptEvent,
} from '@proj-airi/stage-shared/meeting-media'

import type { HearingPcmTranscriptionSession } from '../stores/modules/hearing'

import { toWav } from '@proj-airi/audio/encoding'
import { joinTranscriptFragments } from '@proj-airi/pipelines-audio'
import { shallowRef } from 'vue'

import vadWorkletUrl from '../workers/vad/process.worklet?worker&url'

import { useVAD } from '../stores/ai/models/vad'
import { useHearingSpeechInputPipeline } from '../stores/modules/hearing'
import { useProvidersStore } from '../stores/providers'
import { MeetingTurnAssembler } from './meeting-speech'

const MEETING_PCM_FRAME_DURATION_MS = 32

interface ActiveMeetingSpeechSegment {
  id: string
  capturedAtMs: number
  partialText: string
  streamingSession: Promise<HearingPcmTranscriptionSession> | null
  batchAbortController?: AbortController
}

interface ActiveMeetingSpeechSession {
  sessionId: string
  profile: MeetingMediaSpeechProfile
  assembler: MeetingTurnAssembler
  capturingSegment: ActiveMeetingSpeechSegment | null
  pendingSegments: Map<string, ActiveMeetingSpeechSegment>
  batchSegmentAwaitingAudio: ActiveMeetingSpeechSegment | null
  speechSequence: number
  transcriptSequence: number
  generation: number
  failed: boolean
  processingFrame: MeetingMediaPcmFrame | null
  processingTail: Promise<void>
  bufferedFrames: number
  preSpeechFrames: MeetingMediaPcmFrame[]
}

export interface MeetingSpeechSessionOptions {
  onPartial?: (event: Extract<MeetingMediaTranscriptEvent, { type: 'partial' }>) => void
  onTurnEnd: (event: Extract<MeetingMediaTranscriptEvent, { type: 'turn-end' }>) => void | Promise<void>
  onFailure: (error: Error) => void
  onVadInference?: (durationMs: number) => void
  onBufferedFrames?: (frames: number) => void
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Creates the VAD-authoritative meeting ASR lifecycle used by a renderer media host.
 * Batch and streaming providers share the same segment correlation and turn-end boundary.
 */
export function useMeetingSpeechSession(options: MeetingSpeechSessionOptions) {
  const hearingPipeline = useHearingSpeechInputPipeline()
  const providersStore = useProvidersStore()

  const vadThreshold = shallowRef(0.52)
  const vadMinSilenceDurationMs = shallowRef(1200)
  const vadSpeechPadMs = shallowRef(360)
  const vadMinSpeechDurationMs = shallowRef(300)

  let active: ActiveMeetingSpeechSession | null = null
  let generation = 0
  let finalization = Promise.resolve()

  /**
   * Verifies the exact provider/model frozen into a meeting profile without allocating audio resources.
   * The same boundary is used by renderer preflight and by `start`, so runtime never depends on a
   * later mutation of the global Hearing selection.
   */
  async function preflight(profile: MeetingMediaSpeechProfile): Promise<void> {
    const providerId = profile.providerId.trim()
    const model = profile.model.trim()
    if (!providerId || !model)
      throw new Error('The meeting ASR provider and model must be selected explicitly.')

    const metadata = providersStore.findProviderMetadata(providerId)
    if (!metadata)
      throw new Error(`The meeting ASR provider "${providerId}" is not registered.`)

    if (metadata.category !== 'transcription')
      throw new Error(`Provider "${providerId}" is not a transcription provider.`)

    const available = metadata.isAvailableBy ? await metadata.isAvailableBy() : true
    if (!available)
      throw new Error(`The meeting ASR provider "${providerId}" is unavailable in this runtime.`)

    const configured = metadata.requiresCredentials === false
      ? providersStore.configuredProviders[providerId] === true
      : await providersStore.validateProvider(providerId, { force: true })
    if (!configured)
      throw new Error(`The meeting ASR provider "${providerId}" is not configured or authenticated.`)

    const features = providersStore.getTranscriptionFeatures(providerId)
    if (profile.mode === 'batch' && !features.supportsGenerate)
      throw new Error(`The meeting ASR provider "${providerId}" does not support batch transcription.`)
    if (profile.mode === 'streaming' && !features.supportsStreamInput)
      throw new Error(`The meeting ASR provider "${providerId}" does not support streaming audio input.`)

    await providersStore.getProviderInstance(providerId)
  }

  function reportFailure(error: unknown): void {
    const session = active
    if (!session || session.failed)
      return
    session.failed = true
    options.onFailure(normalizedError(error))
  }

  function deliverOutcome(outcome: ReturnType<MeetingTurnAssembler['acceptSpeech']>): void {
    if (outcome.status !== 'turn-end')
      return
    void Promise.resolve(options.onTurnEnd(outcome.event)).catch(reportFailure)
  }

  function acceptPartial(session: ActiveMeetingSpeechSession, segment: ActiveMeetingSpeechSegment, delta: string): void {
    const text = delta.trim()
    if (!text
      || active?.generation !== session.generation
      || session.pendingSegments.get(segment.id) !== segment) {
      return
    }

    segment.partialText = joinTranscriptFragments(segment.partialText, text)
    const event: Extract<MeetingMediaTranscriptEvent, { type: 'partial' }> = {
      type: 'partial',
      sessionId: session.sessionId,
      segmentId: segment.id,
      sequence: ++session.transcriptSequence,
      capturedAtMs: segment.capturedAtMs,
      text: segment.partialText,
    }
    session.assembler.acceptTranscript(event)
    options.onPartial?.(event)
  }

  async function beginSegment(): Promise<void> {
    const session = active
    if (!session || session.failed)
      return
    if (session.capturingSegment) {
      reportFailure(new Error('VAD started a new speech segment before the previous segment finished.'))
      return
    }

    const segment: ActiveMeetingSpeechSegment = {
      id: crypto.randomUUID(),
      capturedAtMs: session.preSpeechFrames[0]?.capturedAtMs
        ?? session.processingFrame?.capturedAtMs
        ?? Date.now(),
      partialText: '',
      streamingSession: null,
    }
    const speechStart: MeetingMediaSpeechEvent = {
      type: 'speech-start',
      sessionId: session.sessionId,
      segmentId: segment.id,
      sequence: ++session.speechSequence,
      capturedAtMs: segment.capturedAtMs,
    }
    session.assembler.acceptSpeech(speechStart)
    session.capturingSegment = segment
    session.pendingSegments.set(segment.id, segment)

    if (session.profile.mode !== 'streaming')
      return

    segment.streamingSession = hearingPipeline.transcribeForPcmStream({
      selection: {
        providerId: session.profile.providerId,
        model: session.profile.model,
      },
      providerOptions: { language: session.profile.locale },
      onSentenceEnd: delta => acceptPartial(session, segment, delta),
    }).then((streamingSession) => {
      if (!streamingSession)
        throw new Error(hearingPipeline.error || 'The streaming transcription provider did not start a session.')
      return streamingSession
    })
    await segment.streamingSession
  }

  function enqueueFinalTranscript(
    session: ActiveMeetingSpeechSession,
    segment: ActiveMeetingSpeechSegment,
    transcription: Promise<string | undefined>,
    emptyResultMessage: string,
  ): void {
    const settledTranscription = transcription.then(
      text => ({ text } as const),
      error => ({ error } as const),
    )

    finalization = finalization.then(async () => {
      const result = await settledTranscription
      if ('error' in result)
        throw result.error
      if (active?.generation !== session.generation
        || session.pendingSegments.get(segment.id) !== segment) {
        return
      }
      const { text } = result
      if (typeof text !== 'string')
        throw new Error(hearingPipeline.error || emptyResultMessage)

      const outcome = session.assembler.acceptTranscript({
        type: 'final',
        sessionId: session.sessionId,
        segmentId: segment.id,
        sequence: ++session.transcriptSequence,
        capturedAtMs: segment.capturedAtMs,
        text,
      })
      session.pendingSegments.delete(segment.id)
      deliverOutcome(outcome)
    }).catch(reportFailure)
  }

  function finishStreamingSegment(session: ActiveMeetingSpeechSession, segment: ActiveMeetingSpeechSegment): void {
    const streamingSession = segment.streamingSession
    if (!streamingSession) {
      reportFailure(new Error('The streaming speech segment ended before its transcription session started.'))
      return
    }

    // Start transport finalization immediately. Only transcript delivery is ordered;
    // the next VAD segment does not wait for this provider response.
    enqueueFinalTranscript(
      session,
      segment,
      streamingSession.then(handle => handle.finish(false)),
      'The streaming transcription provider returned no final transcript.',
    )
  }

  function endSegment(): void {
    const session = active
    const segment = session?.capturingSegment
    if (!session || !segment || session.failed)
      return

    const outcome = session.assembler.acceptSpeech({
      type: 'speech-end',
      sessionId: session.sessionId,
      segmentId: segment.id,
      sequence: ++session.speechSequence,
      capturedAtMs: segment.capturedAtMs,
      endedAtMs: Date.now(),
    })
    deliverOutcome(outcome)
    session.capturingSegment = null

    if (session.profile.mode === 'streaming') {
      finishStreamingSegment(session, segment)
      return
    }

    if (session.batchSegmentAwaitingAudio) {
      reportFailure(new Error('VAD produced overlapping batch speech buffers.'))
      return
    }
    session.batchSegmentAwaitingAudio = segment
  }

  function transcribeBatch(buffer: Float32Array): void {
    const session = active
    const segment = session?.batchSegmentAwaitingAudio
    if (!session || !segment || session.failed || session.profile.mode !== 'batch')
      return
    session.batchSegmentAwaitingAudio = null

    const abortController = new AbortController()
    segment.batchAbortController = abortController
    const transcription = (async () => {
      const wav = toWav(buffer.slice().buffer, 16000)
      return hearingPipeline.transcribeForRecording(
        new Blob([wav], { type: 'audio/wav' }),
        {
          selection: {
            providerId: session.profile.providerId,
            model: session.profile.model,
          },
          providerOptions: {
            abortSignal: abortController.signal,
            language: session.profile.locale,
          },
        },
      )
    })()
    enqueueFinalTranscript(
      session,
      segment,
      transcription,
      'The batch transcription provider returned no final transcript.',
    )
  }

  const vad = useVAD(vadWorkletUrl, {
    threshold: vadThreshold,
    minSilenceDurationMs: vadMinSilenceDurationMs,
    speechPadMs: vadSpeechPadMs,
    minSpeechDurationMs: vadMinSpeechDurationMs,
    onSpeechStart: () => void beginSegment().catch(reportFailure),
    onSpeechEnd: endSegment,
    onSpeechReady: event => transcribeBatch(event.buffer),
  })

  function enqueueSegmentFrame(
    session: ActiveMeetingSpeechSession,
    segment: ActiveMeetingSpeechSegment,
    frame: MeetingMediaPcmFrame,
  ): void {
    const outcome = session.assembler.acceptSpeech({
      type: 'speech-frame',
      sessionId: session.sessionId,
      segmentId: segment.id,
      sequence: ++session.speechSequence,
      capturedAtMs: frame.capturedAtMs,
      samples: frame.samples,
      sampleRate: 16000,
    })
    deliverOutcome(outcome)

    if (session.profile.mode !== 'streaming' || !segment.streamingSession)
      return

    // Every handler is registered on the same startup promise, preserving PCM order even when
    // provider initialization overlaps the first frames of a speech segment.
    void segment.streamingSession
      .then(streamingSession => streamingSession.push(frame.samples))
      .catch(reportFailure)
  }

  async function processFrame(session: ActiveMeetingSpeechSession, frame: MeetingMediaPcmFrame): Promise<void> {
    if (active?.generation !== session.generation || session.failed)
      return

    session.processingFrame = frame
    const segmentBeforeInference = session.capturingSegment
    if (segmentBeforeInference) {
      enqueueSegmentFrame(session, segmentBeforeInference, frame)
    }
    else {
      session.preSpeechFrames.push(frame)
      const maxPreSpeechFrames = Math.max(1, Math.ceil(session.profile.vad.speechPadMs / MEETING_PCM_FRAME_DURATION_MS))
      if (session.preSpeechFrames.length > maxPreSpeechFrames)
        session.preSpeechFrames.shift()
    }

    const inferenceStartedAt = performance.now()
    try {
      await vad.processAudio(frame.samples)
    }
    finally {
      options.onVadInference?.(performance.now() - inferenceStartedAt)
      session.processingFrame = null
    }

    if (active?.generation !== session.generation || session.failed)
      return

    // The frame that crosses the VAD start threshold belongs to the new segment. Frames for an
    // already-active segment were queued before inference so a speech-end callback cannot close
    // the provider input ahead of its final silence frame.
    const segmentAfterInference = session.capturingSegment
    if (!segmentBeforeInference && segmentAfterInference) {
      for (const bufferedFrame of session.preSpeechFrames)
        enqueueSegmentFrame(session, segmentAfterInference, bufferedFrame)
      session.preSpeechFrames.length = 0
    }
  }

  function push(frame: MeetingMediaPcmFrame): void {
    const session = active
    if (!session || session.sessionId !== frame.sessionId)
      return
    if (frame.sampleRate !== 16000
      || frame.channelCount !== 1
      || !(frame.samples instanceof Float32Array)
      || frame.samples.length !== 512) {
      reportFailure(new Error('Meeting speech input requires canonical 16 kHz mono 512-sample PCM frames.'))
      return
    }

    session.bufferedFrames += 1
    options.onBufferedFrames?.(session.bufferedFrames)
    session.processingTail = session.processingTail
      .then(() => processFrame(session, frame))
      .catch(reportFailure)
      .finally(() => {
        session.bufferedFrames = Math.max(0, session.bufferedFrames - 1)
        options.onBufferedFrames?.(session.bufferedFrames)
      })
  }

  async function start(params: {
    sessionId: string
    profile: MeetingMediaSpeechProfile
  }): Promise<void> {
    if (active)
      throw new Error(`Meeting speech input is already owned by session "${active.sessionId}".`)
    await preflight(params.profile)

    vadThreshold.value = params.profile.vad.threshold
    vadMinSilenceDurationMs.value = params.profile.vad.minSilenceDurationMs
    vadSpeechPadMs.value = params.profile.vad.speechPadMs
    vadMinSpeechDurationMs.value = params.profile.vad.minSpeechDurationMs

    await vad.init()
    if (!vad.loaded.value)
      throw new Error(vad.inferenceError.value || 'The meeting VAD model could not be initialized.')

    const sessionGeneration = ++generation
    active = {
      sessionId: params.sessionId,
      profile: structuredClone(params.profile),
      assembler: new MeetingTurnAssembler({
        sessionId: params.sessionId,
        maxPendingSegments: 2,
        maxCompletedSegmentIds: 128,
      }),
      capturingSegment: null,
      pendingSegments: new Map(),
      batchSegmentAwaitingAudio: null,
      speechSequence: 0,
      transcriptSequence: 0,
      generation: sessionGeneration,
      failed: false,
      processingFrame: null,
      processingTail: Promise.resolve(),
      bufferedFrames: 0,
      preSpeechFrames: [],
    }
  }

  async function stop(sessionId: string): Promise<void> {
    const session = active
    if (!session || session.sessionId !== sessionId)
      return

    generation += 1
    active = null
    session.assembler.stop()
    await session.processingTail
    vad.dispose()

    const abortReason = new DOMException('Aborted', 'AbortError')
    const cancellations: Promise<unknown>[] = []
    for (const segment of session.pendingSegments.values()) {
      segment.batchAbortController?.abort(abortReason)
      if (segment.streamingSession) {
        cancellations.push(
          segment.streamingSession
            .then(streamingSession => streamingSession.finish(true))
            .catch(() => undefined),
        )
      }
    }
    await Promise.all(cancellations)
    await finalization
    finalization = Promise.resolve()
  }

  return { preflight, start, push, stop }
}
