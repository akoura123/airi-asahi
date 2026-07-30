import type {
  MeetingMediaPcmChunk,
  MeetingMediaPcmFrame,
  MeetingMediaSpeechEvent,
  MeetingMediaTranscriptEvent,
} from '@proj-airi/stage-shared/meeting-media'

const MEETING_PCM_SAMPLE_RATE = 16000 as const
const MEETING_PCM_FRAME_SAMPLES = 512

/** Explicit PCM contract failure that must stop the remote-audio route. */
export class MeetingPcmPipelineError extends Error {
  constructor(
    public readonly code: 'PCM_SESSION_STALE' | 'PCM_SEQUENCE_DISCONTINUITY' | 'PCM_FORMAT_INVALID' | 'PCM_INPUT_TOO_LARGE',
    message: string,
  ) {
    super(message)
    this.name = 'MeetingPcmPipelineError'
  }
}

/**
 * Downmixes interleaved native PCM, resamples it to 16 kHz, and emits exact 512-sample frames.
 * Sequence gaps and oversized callbacks fail explicitly because continuing would corrupt speech.
 */
export class MeetingPcmNormalizer {
  private sourceSamples = new Float32Array(0)
  private sourcePosition = 0
  private readonly frameSamples = new Float32Array(MEETING_PCM_FRAME_SAMPLES)
  private frameOffset = 0
  private inputSampleRate: number | null = null
  private expectedInputSequence: number | null = null
  private outputSequence = 0
  private nextFrameCapturedAtMs: number | null = null
  private disposed = false

  constructor(private readonly options: {
    sessionId: string
    /** Maximum normalized frames accepted from one native callback. */
    maxFramesPerPush: number
  }) {
    if (!Number.isInteger(options.maxFramesPerPush) || options.maxFramesPerPush < 1)
      throw new TypeError('maxFramesPerPush must be a positive integer.')
  }

  /** Returns complete normalized frames and retains only the bounded partial frame. */
  push(chunk: MeetingMediaPcmChunk): MeetingMediaPcmFrame[] {
    this.assertChunk(chunk)

    const mono = this.downmix(chunk)
    const estimatedFrames = Math.ceil(
      (this.frameOffset + ((this.sourceSamples.length + mono.length) * MEETING_PCM_SAMPLE_RATE / chunk.sampleRate))
      / MEETING_PCM_FRAME_SAMPLES,
    )
    if (estimatedFrames > this.options.maxFramesPerPush) {
      throw new MeetingPcmPipelineError(
        'PCM_INPUT_TOO_LARGE',
        `Native PCM callback would produce ${estimatedFrames} frames; limit is ${this.options.maxFramesPerPush}.`,
      )
    }

    this.appendSource(mono)
    this.inputSampleRate = chunk.sampleRate
    this.expectedInputSequence = chunk.sequence + 1
    this.nextFrameCapturedAtMs ??= chunk.capturedAtMs

    const output: MeetingMediaPcmFrame[] = []
    const sourceStep = chunk.sampleRate / MEETING_PCM_SAMPLE_RATE
    while (this.sourcePosition + 1 < this.sourceSamples.length) {
      const leftIndex = Math.floor(this.sourcePosition)
      const fraction = this.sourcePosition - leftIndex
      const left = this.sourceSamples[leftIndex] ?? 0
      const right = this.sourceSamples[leftIndex + 1] ?? left
      this.frameSamples[this.frameOffset] = left + ((right - left) * fraction)
      this.frameOffset += 1
      this.sourcePosition += sourceStep

      if (this.frameOffset !== MEETING_PCM_FRAME_SAMPLES)
        continue

      this.outputSequence += 1
      output.push({
        sessionId: this.options.sessionId,
        sequence: this.outputSequence,
        capturedAtMs: Math.round(this.nextFrameCapturedAtMs),
        sampleRate: MEETING_PCM_SAMPLE_RATE,
        channelCount: 1,
        samples: this.frameSamples.slice(),
      })
      this.frameOffset = 0
      this.nextFrameCapturedAtMs += (MEETING_PCM_FRAME_SAMPLES / MEETING_PCM_SAMPLE_RATE) * 1000
    }

    const consumedSamples = Math.floor(this.sourcePosition)
    if (consumedSamples > 0) {
      this.sourceSamples = this.sourceSamples.slice(consumedSamples)
      this.sourcePosition -= consumedSamples
    }

    return output
  }

  /** Clears buffered audio and rejects subsequent input. */
  dispose(): void {
    this.disposed = true
    this.sourceSamples = new Float32Array(0)
    this.sourcePosition = 0
    this.frameSamples.fill(0)
    this.frameOffset = 0
  }

  private assertChunk(chunk: MeetingMediaPcmChunk): void {
    if (this.disposed)
      throw new Error('Meeting PCM normalizer is disposed.')
    if (chunk.sessionId !== this.options.sessionId) {
      throw new MeetingPcmPipelineError(
        'PCM_SESSION_STALE',
        `PCM chunk belongs to stale session "${chunk.sessionId}".`,
      )
    }
    if (this.expectedInputSequence !== null && chunk.sequence !== this.expectedInputSequence) {
      throw new MeetingPcmPipelineError(
        'PCM_SEQUENCE_DISCONTINUITY',
        `Expected PCM sequence ${this.expectedInputSequence}, received ${chunk.sequence}.`,
      )
    }
    if (!Number.isSafeInteger(chunk.sequence)
      || chunk.sequence < 0
      || !Number.isFinite(chunk.capturedAtMs)
      || chunk.capturedAtMs < 0
      || !Number.isSafeInteger(chunk.channelCount)
      || chunk.channelCount < 1
      || !Number.isSafeInteger(chunk.sampleRate)
      || chunk.sampleRate < MEETING_PCM_SAMPLE_RATE
      || chunk.layout !== 'interleaved'
      || !(chunk.samples instanceof Float32Array)
      || chunk.samples.length === 0
      || chunk.samples.length % chunk.channelCount !== 0
      || (this.inputSampleRate !== null && this.inputSampleRate !== chunk.sampleRate)) {
      throw new MeetingPcmPipelineError(
        'PCM_FORMAT_INVALID',
        'PCM chunks must use valid timestamps and sequences, retain one integer sample rate of at least 16 kHz, and contain complete finite interleaved Float32 frames.',
      )
    }
  }

  private downmix(chunk: MeetingMediaPcmChunk): Float32Array {
    const frameCount = chunk.samples.length / chunk.channelCount
    const mono = new Float32Array(frameCount)
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      let sum = 0
      const frameOffset = frameIndex * chunk.channelCount
      for (let channelIndex = 0; channelIndex < chunk.channelCount; channelIndex += 1) {
        const sample = chunk.samples[frameOffset + channelIndex]
        // Native NaN or Infinity values would poison every later interpolation result.
        if (!Number.isFinite(sample)) {
          throw new MeetingPcmPipelineError(
            'PCM_FORMAT_INVALID',
            `PCM chunk ${chunk.sequence} contains a non-finite sample.`,
          )
        }
        sum += sample
      }
      mono[frameIndex] = sum / chunk.channelCount
    }
    return mono
  }

  private appendSource(samples: Float32Array): void {
    const unread = this.sourceSamples.subarray(Math.floor(this.sourcePosition))
    const merged = new Float32Array(unread.length + samples.length)
    merged.set(unread)
    merged.set(samples, unread.length)
    this.sourcePosition -= Math.floor(this.sourcePosition)
    this.sourceSamples = merged
  }
}

interface PendingSpeechSegment {
  segmentId: string
  capturedAtMs: number
  lastSpeechSequence: number
  lastTranscriptSequence: number
  endedAtMs: number | null
  finalText: string | null
}

export type MeetingTurnAssemblerOutcome
  = | { status: 'accepted' }
    | { status: 'ignored-stale' }
    | { status: 'ignored-duplicate' }
    | { status: 'completed-empty' }
    | { status: 'turn-end', event: Extract<MeetingMediaTranscriptEvent, { type: 'turn-end' }> }

/**
 * Correlates VAD and ASR events and emits at most one turn for each completed segment.
 * ASR adapters must normalize partial/final text to the full current segment transcript.
 */
export class MeetingTurnAssembler {
  private readonly segments = new Map<string, PendingSpeechSegment>()
  private readonly completedSegmentIds = new Set<string>()
  private capturingSegmentId: string | null = null
  private stopped = false
  private staleResults = 0
  private duplicateResults = 0

  constructor(private readonly options: {
    sessionId: string
    maxPendingSegments: number
    maxCompletedSegmentIds: number
  }) {
    if (!Number.isInteger(options.maxPendingSegments) || options.maxPendingSegments < 1)
      throw new TypeError('maxPendingSegments must be a positive integer.')
    if (!Number.isInteger(options.maxCompletedSegmentIds) || options.maxCompletedSegmentIds < 1)
      throw new TypeError('maxCompletedSegmentIds must be a positive integer.')
  }

  acceptSpeech(event: MeetingMediaSpeechEvent): MeetingTurnAssemblerOutcome {
    if (!this.acceptsSession(event.sessionId))
      return this.stale()

    if (event.type === 'speech-start') {
      if (this.completedSegmentIds.has(event.segmentId))
        return this.duplicate()
      if (this.capturingSegmentId !== null || this.segments.has(event.segmentId))
        return this.duplicate()
      if (this.segments.size >= this.options.maxPendingSegments)
        throw new Error('Meeting speech segment queue is full.')

      this.segments.set(event.segmentId, {
        segmentId: event.segmentId,
        capturedAtMs: event.capturedAtMs,
        lastSpeechSequence: event.sequence,
        lastTranscriptSequence: -1,
        endedAtMs: null,
        finalText: null,
      })
      this.capturingSegmentId = event.segmentId
      return { status: 'accepted' }
    }

    const segment = this.segments.get(event.segmentId)
    if (!segment)
      return this.completedSegmentIds.has(event.segmentId) ? this.duplicate() : this.stale()
    if (this.capturingSegmentId !== event.segmentId || event.sequence <= segment.lastSpeechSequence)
      return this.duplicate()

    segment.lastSpeechSequence = event.sequence
    if (event.type === 'speech-frame')
      return { status: 'accepted' }

    segment.endedAtMs = event.endedAtMs
    this.capturingSegmentId = null
    return this.completeIfReady(segment)
  }

  acceptTranscript(
    event: Exclude<MeetingMediaTranscriptEvent, { type: 'turn-end' }>,
  ): MeetingTurnAssemblerOutcome {
    if (!this.acceptsSession(event.sessionId))
      return this.stale()

    const segment = this.segments.get(event.segmentId)
    if (!segment)
      return this.completedSegmentIds.has(event.segmentId) ? this.duplicate() : this.stale()
    if (event.sequence <= segment.lastTranscriptSequence)
      return this.duplicate()

    segment.lastTranscriptSequence = event.sequence
    if (event.type === 'partial')
      return { status: 'accepted' }

    segment.finalText = event.text.trim()
    return this.completeIfReady(segment)
  }

  /** Invalidates every pending segment so late provider results cannot enter a later session. */
  stop(): void {
    this.stopped = true
    this.capturingSegmentId = null
    this.segments.clear()
  }

  /** Returns bounded diagnostic counters without exposing transcript content. */
  metrics() {
    return {
      pendingSegments: this.segments.size,
      staleResults: this.staleResults,
      duplicateResults: this.duplicateResults,
    }
  }

  private acceptsSession(sessionId: string): boolean {
    return !this.stopped && sessionId === this.options.sessionId
  }

  private completeIfReady(segment: PendingSpeechSegment): MeetingTurnAssemblerOutcome {
    if (segment.endedAtMs === null || segment.finalText === null)
      return { status: 'accepted' }

    this.segments.delete(segment.segmentId)
    this.rememberCompleted(segment.segmentId)
    if (!segment.finalText)
      return { status: 'completed-empty' }

    return {
      status: 'turn-end',
      event: {
        type: 'turn-end',
        sessionId: this.options.sessionId,
        segmentId: segment.segmentId,
        sequence: segment.lastTranscriptSequence + 1,
        capturedAtMs: segment.capturedAtMs,
        text: segment.finalText,
        endedAtMs: segment.endedAtMs,
      },
    }
  }

  private rememberCompleted(segmentId: string): void {
    this.completedSegmentIds.add(segmentId)
    if (this.completedSegmentIds.size <= this.options.maxCompletedSegmentIds)
      return

    const oldest = this.completedSegmentIds.values().next().value
    if (typeof oldest === 'string')
      this.completedSegmentIds.delete(oldest)
  }

  private stale(): MeetingTurnAssemblerOutcome {
    this.staleResults += 1
    return { status: 'ignored-stale' }
  }

  private duplicate(): MeetingTurnAssemblerOutcome {
    this.duplicateResults += 1
    return { status: 'ignored-duplicate' }
  }
}
