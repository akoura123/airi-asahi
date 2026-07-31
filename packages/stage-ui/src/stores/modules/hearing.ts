import type { Span } from '@opentelemetry/api'
import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { WithUnknown } from '@xsai/shared'
import type { StreamTranscriptionResult, StreamTranscriptionOptions as XSAIStreamTranscriptionOptions } from '@xsai/stream-transcription'

import { errorMessageFrom, tryCatch } from '@moeru/std'
import { errorMessageFromValue, IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { generateTranscription } from '@xsai/generate-transcription'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import vadWorkletUrl from '../../workers/vad/process.worklet?worker&url'

import { useAnalytics } from '../../composables/use-analytics'
import { activeTurnSpan, startSpan } from '../../composables/use-io-tracer'
import { OFFICIAL_TRANSCRIPTION_PROVIDER_ID } from '../../libs/providers'
import { useProvidersStore } from '../providers'
import { streamAliyunTranscription } from '../providers/aliyun/stream-transcription'
import { streamWebSpeechAPITranscription } from '../providers/web-speech-api'

function errorMessage(err: unknown): string {
  const msg = errorMessageFromValue(err)
  // Browsers hide the real reason (CORS, timeout, DNS, …) behind this generic string.
  if (msg === 'Failed to fetch' || msg === 'Load failed') {
    return `${msg} — check the browser console (Network tab) for the exact reason (e.g. CORS, network timeout, DNS failure).`
  }
  return msg
}

// NOTICE: Realtime transcription intentionally uses `AbortError` as a control-flow signal when the
// current stream session is being stopped on purpose.
//
// This happens in `stopStreamingTranscription()`,
// which aborts the session with one of the DOMException messages below when the user disables the mic,
// the page tears down audio interaction, callbacks are intentionally rebound, or the idle timeout closes
// an inactive stream. Those cases should not be surfaced as provider failures because the session was
// explicitly asked to stop. If a future abort is noisy or unexpected, inspect the abort source first:
// `stopStreamingTranscription()` in this file is the primary origin, and provider-specific teardown
// bridges such as `packages/stage-ui/src/stores/providers/aliyun/stream-transcription.ts` propagate the
// same reason through the transport. Only treat an abort as "expected" if it is one of these known
// shutdown paths; any other `AbortError` should still be investigated as a real lifecycle bug or a
// provider/runtime failure.
function isExpectedStreamStopError(err: unknown): boolean {
  return err instanceof DOMException
    && err.name === 'AbortError'
    && (err.message === 'Stopped' || err.message === 'Aborted' || err.message === 'Closed' || err.message === 'Idle timeout')
}

type TranscriptionAnalyticsErrorCode = 'permission_denied' | 'device_unavailable' | 'input_unavailable' | 'provider_error' | 'unknown'

/**
 * Normalizes transcription failures into bounded analytics error codes.
 */
function transcriptionAnalyticsErrorCode(err: unknown): TranscriptionAnalyticsErrorCode {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      return 'permission_denied'

    if (err.name === 'NotFoundError' || err.name === 'NotReadableError')
      return 'device_unavailable'
  }

  const message = (errorMessageFrom(err) ?? '').toLowerCase()
  if (message.includes('permission') || message.includes('notallowed'))
    return 'permission_denied'

  if (message.includes('microphone') || message.includes('audio track') || message.includes('device'))
    return 'device_unavailable'

  if (message.includes('file input') || message.includes('compatible input'))
    return 'input_unavailable'

  return message ? 'provider_error' : 'unknown'
}

function haveStreamingCallbacksChanged(
  previous: { onSentenceEnd?: (delta: string) => void, onSpeechEnd?: (text: string) => void } | undefined,
  next: { onSentenceEnd?: (delta: string) => void, onSpeechEnd?: (text: string) => void },
): boolean {
  return (next.onSentenceEnd !== undefined && next.onSentenceEnd !== previous?.onSentenceEnd)
    || (next.onSpeechEnd !== undefined && next.onSpeechEnd !== previous?.onSpeechEnd)
}

export interface StreamTranscriptionFileInputOptions extends Omit<XSAIStreamTranscriptionOptions, 'file' | 'fileName'> {
  file: Blob
  fileName?: string
}

export interface StreamTranscriptionStreamInputOptions extends Omit<XSAIStreamTranscriptionOptions, 'file' | 'fileName'> {
  inputAudioStream: ReadableStream<Uint8Array>
}

export type StreamTranscription = (options: WithUnknown<StreamTranscriptionFileInputOptions | StreamTranscriptionStreamInputOptions>) => StreamTranscriptionResult

type GenerateTranscriptionResponse = Awaited<ReturnType<typeof generateTranscription>>
type HearingTranscriptionGenerateResult = GenerateTranscriptionResponse & { mode: 'generate' }
type HearingTranscriptionStreamResult = StreamTranscriptionResult & { mode: 'stream' }
export type HearingTranscriptionResult = HearingTranscriptionGenerateResult | HearingTranscriptionStreamResult

type HearingTranscriptionInput = File | {
  file?: File
  fileName?: string
  inputAudioStream?: ReadableStream<Uint8Array>
}

interface HearingTranscriptionInvokeOptions {
  providerOptions?: Record<string, unknown>
}

/** Identifies the transcription runtime selected for one request or frozen session. */
export interface HearingTranscriptionSelection {
  /** Provider registry ID that owns the transcription request. */
  providerId: string
  /** Provider model ID sent with the transcription request. */
  model: string
}

/** Per-request overrides applied after the selected transcription provider's persisted options. */
export interface RecordingTranscriptionOptions {
  /** Explicit request owner; when omitted, the current Hearing selection is used. */
  selection?: HearingTranscriptionSelection
  /** Provider options such as the meeting session's frozen recognition language. */
  providerOptions?: Record<string, unknown>
}

/** Per-request controls for transcription from a caller-owned media stream. */
export interface MediaStreamTranscriptionOptions {
  /** Explicit request owner; when omitted, the current Hearing selection is used. */
  selection?: HearingTranscriptionSelection
  /** PCM sample rate produced for providers that accept caller-owned streams. @default 16000 */
  sampleRate?: number
  /** Provider-specific request options merged after persisted provider configuration. */
  providerOptions?: Record<string, unknown>
  /** Inactivity timeout in milliseconds; `0` disables automatic closure. @default 15000 */
  idleTimeoutMs?: number
  /** Receives each final sentence fragment emitted before stream completion. */
  onSentenceEnd?: (delta: string) => void
  /** Receives the complete recognized text when the provider stream closes. */
  onSpeechEnd?: (text: string) => void
}

/**
 * Owns one streaming transcription request independently from later requests.
 * Calling `finish` closes or aborts only this request and always returns the same completion.
 */
export interface HearingStreamingTranscriptionSession {
  /** Closes the PCM input gracefully, or aborts the transport when `abort` is true. */
  finish: (abort?: boolean) => Promise<string | undefined>
}

export const CONFIDENCE_THRESHOLD_DISABLED = -3

export function filterTranscriptionByConfidence(
  segments: Array<{ text?: string, avg_logprob?: number }>,
  threshold: number,
): string {
  if (!segments.some(s => s?.avg_logprob != null && s?.text != null)) {
    return ''
  }

  return segments.filter(s => (s?.avg_logprob ?? -Infinity) >= threshold).map(s => s?.text ?? '').join('').trim()
}

/**
 * Reads a string field from an unknown response object.
 */
function stringField(value: unknown, key: string, options: { trim?: boolean } = {}) {
  if (!value || typeof value !== 'object')
    return ''

  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== 'string')
    return ''

  return options.trim === false ? field : field.trim()
}

/**
 * Reads a nested object field from an unknown response object.
 */
function objectField(value: unknown, key: string) {
  if (!value || typeof value !== 'object')
    return undefined

  const field = (value as Record<string, unknown>)[key]
  return field && typeof field === 'object' ? field : undefined
}

/**
 * Normalizes generated transcription text from OpenAI-compatible response variants.
 *
 * Before:
 * - `{ result: { text: "你好" } }`
 * - `{ segments: [{ text: "你" }, { text: "好" }] }`
 *
 * After:
 * - `"你好"`
 */
export function normalizeGeneratedTranscriptionText(response: unknown) {
  const directText = stringField(response, 'text')
  if (directText)
    return directText

  for (const envelopeKey of ['result', 'data', 'output']) {
    const nested = objectField(response, envelopeKey)
    const nestedText = stringField(nested, 'text')
    if (nestedText)
      return nestedText
  }

  const segments = objectField(response, 'segments') ?? (response && typeof response === 'object' ? (response as Record<string, unknown>).segments : undefined)
  if (Array.isArray(segments)) {
    const text = segments
      .map(segment => stringField(segment, 'text', { trim: false }))
      .join('')
      .trim()
    if (text)
      return text
  }

  return ''
}

/**
 * Builds a compact diagnostic summary for an empty transcription response.
 */
export function describeEmptyTranscriptionResponse(response: unknown) {
  if (!response || typeof response !== 'object')
    return `response=${String(response)}`

  const keys = Object.keys(response as Record<string, unknown>)
  const nestedKeys = keys
    .map((key) => {
      const nested = objectField(response, key)
      return nested ? `${key}.{${Object.keys(nested as Record<string, unknown>).join(',')}}` : ''
    })
    .filter(Boolean)

  return [
    `keys=${keys.join(',') || '(none)'}`,
    ...(nestedKeys.length ? [`nested=${nestedKeys.join(';')}`] : []),
  ].join(' ')
}

/**
 * Resolves the upload filename for transcription requests.
 *
 * Use when:
 * - OpenAI-compatible providers infer audio format from multipart filenames.
 *
 * Expects:
 * - `file.name` may carry the recorder-generated extension.
 *
 * Returns:
 * - A stable filename with an audio extension.
 */
export function resolveTranscriptionFileName(file: File, explicitFileName?: string) {
  const explicit = explicitFileName?.trim()
  if (explicit)
    return explicit

  const fileName = file.name.trim()
  if (fileName)
    return fileName

  return 'recording.wav'
}

const STREAM_TRANSCRIPTION_EXECUTORS: Record<string, StreamTranscription> = {
  'aliyun-nls-transcription': streamAliyunTranscription,
  [OFFICIAL_TRANSCRIPTION_PROVIDER_ID]: streamAliyunTranscription,
  // Web Speech API is handled specially in transcribeForMediaStream since it works directly with MediaStream
}

export function resolveStreamTranscriptionExecutor(providerId: string): StreamTranscription | undefined {
  return STREAM_TRANSCRIPTION_EXECUTORS[providerId]
}

/**
 * Resolves the setup error for the selected transcription provider.
 *
 * Use when:
 * - A speech pipeline entry point needs to fail before provider instantiation.
 * - User-facing diagnostics should explain the missing Hearing selection.
 *
 * Expects:
 * - `providerId` is the current `settings/hearing/active-provider` value.
 *
 * Returns:
 * - A setup error when no provider is selected, otherwise `undefined`.
 */
export function resolveActiveTranscriptionProviderError(providerId: string): string | undefined {
  if (providerId)
    return undefined

  return 'No active transcription provider selected. Select a provider in Settings > Hearing.'
}

/**
 * Resolves the transcription model from Hearing state with provider config fallback.
 *
 * Use when:
 * - OpenAI-compatible transcription stores the model in provider settings.
 * - The Hearing module has not yet synchronized that model into its active model state.
 *
 * Expects:
 * - `activeModel` is the current Hearing model value.
 * - `providerConfig.model` may contain a provider-scoped model name.
 *
 * Returns:
 * - The explicit Hearing model first, then the provider config model, otherwise an empty string.
 */
export function resolveActiveTranscriptionModel(activeModel: string, providerConfig?: Record<string, unknown>) {
  const modelFromHearing = activeModel.trim()
  if (modelFromHearing)
    return modelFromHearing

  const modelFromProviderConfig = typeof providerConfig?.model === 'string' ? providerConfig.model.trim() : ''
  return modelFromProviderConfig
}

/**
 * Resolves extra transcription request options from provider config and UI locale.
 *
 * Use when:
 * - Short ASR recordings need a language hint to avoid multilingual auto-detection drift.
 * - Provider-specific transcription prompts are configured outside the Hearing active model field.
 *
 * Expects:
 * - `uiLocale` uses a BCP-47-like language tag such as `zh-Hans` or `en-US`.
 *
 * Returns:
 * - OpenAI-compatible transcription options that can be merged into the provider request.
 */
export function resolveTranscriptionProviderOptions(providerConfig?: Record<string, unknown>, uiLocale = globalThis.navigator?.language ?? '') {
  const configuredLanguage = typeof providerConfig?.language === 'string' ? providerConfig.language.trim() : ''
  const localeLanguage = uiLocale.split(/[-_]/)[0]?.trim().toLowerCase() ?? ''
  const language = configuredLanguage || localeLanguage
  const prompt = typeof providerConfig?.prompt === 'string' ? providerConfig.prompt.trim() : ''

  return {
    ...(language ? { language } : {}),
    ...(prompt ? { prompt } : {}),
  }
}

export const useHearingStore = defineStore('hearing-store', () => {
  const providersStore = useProvidersStore()
  const { allAudioTranscriptionProvidersMetadata } = storeToRefs(providersStore)
  const {
    trackAudioDeviceUnavailable,
    trackMicrophonePermissionDenied,
    trackSttFailed,
    trackSttStarted,
    trackSttSucceeded,
    trackVoiceInputStarted,
  } = useAnalytics()

  // State
  const activeTranscriptionProvider = useLocalStorageManualReset('settings/hearing/active-provider', '')
  const activeTranscriptionModel = useLocalStorageManualReset('settings/hearing/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset('settings/hearing/active-custom-model', '')
  const transcriptionModelSearchQuery = refManualReset<string>('')
  const autoSendEnabled = useLocalStorageManualReset<boolean>('settings/hearing/auto-send-enabled', false)
  const autoSendDelay = useLocalStorageManualReset<number>('settings/hearing/auto-send-delay', 2000) // Default 2 seconds
  const confidenceThreshold = useLocalStorageManualReset<number>('settings/hearing/confidence-threshold', CONFIDENCE_THRESHOLD_DISABLED)
  const verboseJsonNotSupported = ref(false)

  watch(activeTranscriptionProvider, () => {
    verboseJsonNotSupported.value = false
  })

  // Computed properties
  const availableProvidersMetadata = computed(() => allAudioTranscriptionProvidersMetadata.value)

  // Computed properties
  const supportsModelListing = computed(() => {
    return providersStore.findProviderMetadata(activeTranscriptionProvider.value)?.capabilities.listModels !== undefined
  })

  const providerModels = computed(() => {
    return providersStore.getModelsForProvider(activeTranscriptionProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    return providersStore.isLoadingModels[activeTranscriptionProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    return providersStore.modelLoadError[activeTranscriptionProvider.value] || null
  })

  async function loadModelsForProvider(provider: string) {
    if (providersStore.findProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (providersStore.findProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  const configured = computed(() => {
    if (!activeTranscriptionProvider.value)
      return false

    // Web Speech API doesn't strictly need a model selected (it has a default)
    // but we still check to maintain consistency
    if (activeTranscriptionProvider.value === 'browser-web-speech-api') {
      return true // Web Speech API is ready if provider is selected and available
    }

    // For OpenAI Compatible providers, check provider config as fallback
    let hasProviderModel = false
    if (activeTranscriptionProvider.value === 'openai-compatible-audio-transcription') {
      const providerConfig = providersStore.getProviderConfig(activeTranscriptionProvider.value)
      hasProviderModel = !!providerConfig?.model
    }

    return !!activeTranscriptionModel.value || hasProviderModel
  })

  function resetState() {
    activeTranscriptionProvider.reset()
    activeTranscriptionModel.reset()
    activeCustomModelName.reset()
    transcriptionModelSearchQuery.reset()
    autoSendEnabled.reset()
    autoSendDelay.reset()
    confidenceThreshold.reset()
  }

  async function transcription(
    providerId: string,
    provider: TranscriptionProviderWithExtraOptions<string, any>,
    model: string,
    input: HearingTranscriptionInput,
    format?: 'json' | 'verbose_json',
    options?: HearingTranscriptionInvokeOptions,
  ): Promise<HearingTranscriptionResult> {
    const normalizedInput = (input instanceof File ? { file: input } : input ?? {}) as {
      file?: File
      fileName?: string
      inputAudioStream?: ReadableStream<Uint8Array>
    }
    const features = providersStore.getTranscriptionFeatures(providerId)
    const streamExecutor = resolveStreamTranscriptionExecutor(providerId)

    const sttStartedAt = performance.now()
    trackVoiceInputStarted({ stt_provider_id: providerId })
    trackSttStarted(providerId)

    function emitSucceeded(charCount: number, stream: boolean) {
      trackSttSucceeded({
        provider: providerId,
        latency_ms: Math.round(performance.now() - sttStartedAt),
        char_count: charCount,
        stream,
      })
    }
    function emitFailed(err: unknown) {
      const errorCode = transcriptionAnalyticsErrorCode(err)
      trackSttFailed({ provider: providerId, error_code: errorCode })
      if (errorCode === 'permission_denied') {
        trackMicrophonePermissionDenied({
          stt_provider_id: providerId,
          error_code: errorCode,
        })
      }
      if (errorCode === 'device_unavailable') {
        trackAudioDeviceUnavailable({
          stt_provider_id: providerId,
          error_code: errorCode,
        })
      }
    }

    try {
      if (features.supportsStreamOutput && streamExecutor) {
        // TODO: integrate VAD-driven silence detection to stop and restart realtime sessions based on silence thresholds.
        const request = provider.transcription(model, options?.providerOptions)

        // Stream branches: emit succeeded with char_count=0 once the
        // executor returns successfully — char count is only known by
        // the downstream consumer of the stream, which lives outside
        // this store. Latency here = "time to start of stream".
        if (features.supportsStreamInput && normalizedInput.inputAudioStream) {
          const streamResult = streamExecutor({
            ...request,
            inputAudioStream: normalizedInput.inputAudioStream,
          } as Parameters<typeof streamExecutor>[0])
          emitSucceeded(0, true)
          return {
            mode: 'stream',
            ...streamResult,
          }
        }

        if (!features.supportsStreamInput && normalizedInput.file) {
          const streamResult = streamExecutor({
            ...request,
            file: normalizedInput.file,
          } as Parameters<typeof streamExecutor>[0])
          emitSucceeded(0, true)
          return {
            mode: 'stream',
            ...streamResult,
          }
        }

        if (features.supportsStreamInput && !normalizedInput.inputAudioStream && normalizedInput.file) {
          const streamResult = streamExecutor({
            ...request,
            file: normalizedInput.file,
          } as Parameters<typeof streamExecutor>[0])
          emitSucceeded(0, true)
          return {
            mode: 'stream',
            ...streamResult,
          }
        }

        if (!features.supportsGenerate || !normalizedInput.file) {
          throw new Error('No compatible input provided for streaming transcription.')
        }
      }

      if (!normalizedInput.file) {
        throw new Error('File input is required for transcription.')
      }

      const useVerboseJson = !format && confidenceThreshold.value > CONFIDENCE_THRESHOLD_DISABLED
      const response = await generateTranscription({
        ...provider.transcription(model, options?.providerOptions),
        file: normalizedInput.file,
        fileName: resolveTranscriptionFileName(normalizedInput.file, normalizedInput.fileName),
        responseFormat: useVerboseJson ? 'verbose_json' : format,
      })

      if (useVerboseJson) {
        if (response.segments) {
          verboseJsonNotSupported.value = false
          const filteredText = filterTranscriptionByConfidence(response.segments, confidenceThreshold.value)
          emitSucceeded(filteredText.length, false)
          return {
            mode: 'generate',
            ...response,
            text: filteredText,
          }
        }
        else {
          verboseJsonNotSupported.value = true
          console.warn('[Hearing] Confidence filter is enabled but the provider did not return verbose_json segments. Filtering has no effect.')
        }
      }

      const fallbackText = normalizeGeneratedTranscriptionText(response)
      emitSucceeded(fallbackText.length, false)
      return {
        mode: 'generate',
        ...response,
        text: fallbackText,
      }
    }
    catch (err) {
      emitFailed(err)
      throw err
    }
  }

  return {
    activeTranscriptionProvider,
    activeTranscriptionModel,
    availableProvidersMetadata,
    activeCustomModelName,
    transcriptionModelSearchQuery,
    autoSendEnabled,
    autoSendDelay,
    confidenceThreshold,
    verboseJsonNotSupported,

    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    configured,

    transcription,
    loadModelsForProvider,
    getModelsForProvider,
    resetState,
  }
})

export const useHearingSpeechInputPipeline = defineStore('modules:hearing:speech:audio-input-pipeline', () => {
  const error = ref<string>()

  const hearingStore = useHearingStore()
  const { activeTranscriptionProvider, activeTranscriptionModel } = storeToRefs(hearingStore)
  const providersStore = useProvidersStore()
  const {
    trackAudioDeviceUnavailable,
    trackVoiceInputCancelled,
    trackVoiceInputStarted,
  } = useAnalytics()
  interface StreamingAsrTrace {
    span: Span
    ended: boolean
  }

  interface ActiveStreamingTranscriptionSession {
    audioContext: AudioContext | Record<string, never>
    workletNode: AudioWorkletNode | Record<string, never>
    mediaStreamSource: MediaStreamAudioSourceNode | Record<string, never>
    audioStreamController?: ReadableStreamDefaultController<Uint8Array>
    abortController: AbortController
    result?: HearingTranscriptionResult & { recognition?: any }
    idleTimer?: ReturnType<typeof setTimeout>
    providerId?: string
    callbacks?: {
      onSentenceEnd?: (delta: string) => void
      onSpeechEnd?: (text: string) => void
    }
    finish?: () => void
    trace: StreamingAsrTrace
    completion?: Promise<string | undefined>
  }

  const streamingSession = shallowRef<ActiveStreamingTranscriptionSession>()
  let streamingStartupTail = Promise.resolve()

  function startStreamingAsrTrace(providerId: string): StreamingAsrTrace {
    activeTurnSpan.value?.end()
    const turnSpan = startSpan(IOSpanNames.InteractionTurn)
    activeTurnSpan.value = turnSpan
    return {
      span: startSpan(IOSpanNames.SpeechRecognition, turnSpan, {
        [IOAttributes.Subsystem]: IOSubsystems.ASR,
        [IOAttributes.GenAIRequestModel]: providerId,
      }),
      ended: false,
    }
  }

  function endStreamingAsrTrace(trace: StreamingAsrTrace, text?: string) {
    if (trace.ended)
      return

    if (text !== undefined)
      trace.span.setAttribute(IOAttributes.ASRText, text)
    trace.span.end()
    trace.ended = true
  }

  const supportsStreamInput = computed(() => {
    const providerId = activeTranscriptionProvider.value
    return providerSupportsStreamInput(providerId)
  })

  const DEFAULT_SAMPLE_RATE = 16000
  const DEFAULT_STREAM_IDLE_TIMEOUT = 15000

  function providerSupportsStreamInput(providerId: string): boolean {
    if (!providerId)
      return false

    // Web Speech API is a browser-owned microphone source rather than a provider that accepts
    // caller-supplied PCM. Preserve its existing Hearing behavior while meeting preflight rejects it.
    if (providerId === 'browser-web-speech-api') {
      return typeof window !== 'undefined'
        && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
    }

    return providersStore.getTranscriptionFeatures(providerId).supportsStreamInput
  }

  function resolveTranscriptionRequest(selection?: HearingTranscriptionSelection) {
    const providerId = selection
      ? selection.providerId.trim()
      : activeTranscriptionProvider.value
    const providerConfig = providersStore.getProviderConfig(providerId)
    const model = selection
      ? selection.model.trim()
      : resolveActiveTranscriptionModel(activeTranscriptionModel.value, providerConfig)

    return { providerId, providerConfig, model }
  }

  function float32ToInt16(buffer: Float32Array) {
    const output = new Int16Array(buffer.length)
    for (let i = 0; i < buffer.length; i++) {
      const value = Math.max(-1, Math.min(1, buffer[i]))
      output[i] = value < 0 ? value * 0x8000 : value * 0x7FFF
    }

    return output
  }

  async function createAudioStreamFromMediaStream(stream: MediaStream, sampleRate = DEFAULT_SAMPLE_RATE, onActivity?: () => void) {
    const audioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    await audioContext.audioWorklet.addModule(vadWorkletUrl)
    const workletNode = new AudioWorkletNode(audioContext, 'vad-audio-worklet-processor')

    let audioStreamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        audioStreamController = controller
      },
      cancel: () => {
        audioStreamController = undefined
      },
    })

    workletNode.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
      const buffer = data?.buffer
      if (!buffer || !audioStreamController)
        return

      const pcm16 = float32ToInt16(buffer)
      // Fetch request streams accept byte chunks. Clone the worklet-owned PCM
      // buffer so Chromium can consume it after this message handler returns.
      audioStreamController.enqueue(
        new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).slice(),
      )
      onActivity?.()
    }

    const mediaStreamSource = audioContext.createMediaStreamSource(stream)
    mediaStreamSource.connect(workletNode)

    // Sink to avoid feedback/echo
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    workletNode.connect(silentGain)
    silentGain.connect(audioContext.destination)

    return {
      audioContext,
      workletNode,
      mediaStreamSource,
      audioStream,
      get controller() {
        return audioStreamController
      },
    }
  }

  function finishStreamingSession(
    session: ActiveStreamingTranscriptionSession,
    abort = false,
    disposeProviderId?: string,
  ): Promise<string | undefined> {
    const reason = new DOMException(abort ? 'Aborted' : 'Stopped', 'AbortError')

    // A later abort is allowed to cancel a graceful finalization that is still waiting
    // for the provider. This lets renderer teardown terminate every request it owns.
    if (session.completion) {
      if (abort && !session.abortController.signal.aborted)
        session.abortController.abort(reason)
      return session.completion
    }

    session.trace.span.setAttribute(IOAttributes.ASRAbort, abort)
    if (session.idleTimer)
      clearTimeout(session.idleTimer)

    // Release global ownership before awaiting provider output. A new VAD segment may
    // start while this request is still returning its final transcript.
    if (streamingSession.value === session)
      streamingSession.value = undefined

    let closeAudioContext = Promise.resolve()
    try {
      if (session.providerId === 'browser-web-speech-api') {
        if (abort && !session.abortController.signal.aborted) {
          session.abortController.abort(reason)
        }
        else if (!abort) {
          if (!session.finish)
            throw new Error('Web Speech API streaming session does not expose graceful completion.')
          session.finish()
        }
      }
      else {
        if (abort && !session.abortController.signal.aborted)
          session.abortController.abort(reason)

        // Closing PCM is the protocol-level end-of-segment signal. Aborting instead
        // cancels the transport and intentionally discards its final transcript.
        if (abort)
          session.audioStreamController?.error(reason)
        else
          session.audioStreamController?.close()

        session.mediaStreamSource.disconnect()
        session.workletNode.port.onmessage = null
        session.workletNode.disconnect()
        closeAudioContext = (async () => {
          await tryCatch(() => session.audioContext.close())
        })()
      }
    }
    catch (err) {
      if (!isExpectedStreamStopError(err))
        console.error('Error stopping streaming transcription session:', err)
    }

    session.completion = (async () => {
      await closeAudioContext

      try {
        const text = session.result?.mode === 'stream'
          ? await session.result.text
          : session.result?.text
        endStreamingAsrTrace(session.trace, text)
        return text
      }
      catch (err) {
        endStreamingAsrTrace(session.trace)
        if (isExpectedStreamStopError(err))
          return

        error.value = errorMessage(err)
        console.error('Error generating transcription:', error.value)
      }
      finally {
        if (disposeProviderId)
          await providersStore.disposeProviderInstance(disposeProviderId)
      }
    })()

    return session.completion
  }

  function handleForStreamingSession(session: ActiveStreamingTranscriptionSession): HearingStreamingTranscriptionSession {
    return {
      finish: abort => finishStreamingSession(session, abort),
    }
  }

  function resetStreamingIdleTimer(session: ActiveStreamingTranscriptionSession, idleTimeoutMs: number): void {
    if (session.idleTimer)
      clearTimeout(session.idleTimer)
    if (idleTimeoutMs <= 0) {
      session.idleTimer = undefined
      return
    }

    session.idleTimer = setTimeout(() => {
      void finishStreamingSession(session, false, session.providerId)
    }, idleTimeoutMs)
  }

  function stopStreamingTranscription(abort?: boolean, disposeProviderId?: string) {
    const session = streamingSession.value
    if (!session)
      return Promise.resolve(undefined)

    return finishStreamingSession(session, abort, disposeProviderId)
  }

  async function startStreamingTranscriptionSession(
    stream: MediaStream,
    options?: MediaStreamTranscriptionOptions,
  ): Promise<HearingStreamingTranscriptionSession | undefined> {
    const request = resolveTranscriptionRequest(options?.selection)
    console.info('[Hearing Pipeline] transcribeForMediaStream called', {
      supportsStreamInput: providerSupportsStreamInput(request.providerId),
      hasStream: !!stream,
      providerId: request.providerId,
      hasCallbacks: !!(options?.onSentenceEnd || options?.onSpeechEnd),
    })

    if (!providerSupportsStreamInput(request.providerId)) {
      console.warn('[Hearing Pipeline] Stream input not supported')
      return
    }

    error.value = undefined
    let startupTrace: StreamingAsrTrace | undefined

    try {
      const { model, providerConfig, providerId } = request
      const providerError = resolveActiveTranscriptionProviderError(providerId)
      if (providerError) {
        error.value = providerError
        console.error('[Hearing Pipeline]', providerError)
        return
      }

      console.info('[Hearing Pipeline] Using provider:', providerId)

      // Special handling for Web Speech API - it works directly with MediaStream
      if (providerId === 'browser-web-speech-api') {
        trackVoiceInputStarted({ stt_provider_id: providerId })

        // Check if Web Speech API is available
        const isAvailable = typeof window !== 'undefined'
          && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)

        if (!isAvailable) {
          error.value = 'Web Speech API is not available in this browser'
          console.error('Web Speech API is not available')
          return
        }

        // Check if session already exists and reuse it
        const existingSession = streamingSession.value
        if (existingSession && existingSession.providerId === 'browser-web-speech-api') {
          const nextCallbacks = {
            onSentenceEnd: options?.onSentenceEnd,
            onSpeechEnd: options?.onSpeechEnd,
          }
          // For Web Speech API, if callbacks are provided and different, we need to restart
          // because recognition instance callbacks are set once and can't be changed
          const hasNewCallbacks = haveStreamingCallbacksChanged(existingSession.callbacks, nextCallbacks)

          if (hasNewCallbacks) {
            console.info('Web Speech API: New callbacks provided, restarting session to use them')
            void finishStreamingSession(existingSession, false)
          }
          else {
            const idleTimeout = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT
            resetStreamingIdleTimer(existingSession, idleTimeout)

            console.info('Web Speech API session already active, reusing existing session (no callback changes)')
            return handleForStreamingSession(existingSession)
          }
        }

        const trace = startStreamingAsrTrace(providerId)
        startupTrace = trace

        // Auto-select default model if not selected
        if (!options?.selection && !activeTranscriptionModel.value) {
          // Try to get models for the provider and select the first one
          const models = await providersStore.getModelsForProvider(providerId)
          if (models.length > 0) {
            activeTranscriptionModel.value = models[0].id
            console.info('Auto-selected Web Speech API model:', models[0].id)
          }
          else {
            // Fallback to default model ID
            activeTranscriptionModel.value = 'web-speech-api'
            console.info('Auto-selected Web Speech API default model')
          }
        }

        const abortController = new AbortController()

        // Get provider config for language settings
        const language = (options?.providerOptions?.language as string)
          || (providerConfig?.language as string)
          || 'en-US'

        // Web Speech API in continuous mode should run indefinitely - no idle timeout
        // Only stop when explicitly requested (e.g., microphone disabled)
        const idleTimeout = options?.idleTimeoutMs ?? 0 // 0 = disabled
        let ownedSession: ActiveStreamingTranscriptionSession | undefined
        const bumpIdle = () => {
          if (ownedSession)
            resetStreamingIdleTimer(ownedSession, idleTimeout)
        }

        const result = streamWebSpeechAPITranscription(stream, {
          language,
          continuous: (options?.providerOptions?.continuous as boolean) ?? (providerConfig?.continuous as boolean) ?? true,
          interimResults: (options?.providerOptions?.interimResults as boolean) ?? (providerConfig?.interimResults as boolean) ?? true,
          maxAlternatives: (options?.providerOptions?.maxAlternatives as number) ?? (providerConfig?.maxAlternatives as number) ?? 1,
          abortSignal: abortController.signal,
          onSentenceEnd: (delta) => {
            bumpIdle() // Bump idle timer on activity (only if enabled)
            if (!trace.ended)
              trace.span.addEvent(IOEvents.ASRSentenceEnd, { [IOAttributes.ASRText]: delta })
            // Call the options callback
            options?.onSentenceEnd?.(delta)
          },
          onSpeechEnd: (text) => {
            endStreamingAsrTrace(trace, text)
            // Call the options callback
            options?.onSpeechEnd?.(text)
          },
        })

        // Store session info for cleanup
        const activeSession: ActiveStreamingTranscriptionSession = {
          audioContext: {} as AudioContext, // Not used for Web Speech API
          workletNode: {} as AudioWorkletNode, // Not used for Web Speech API
          mediaStreamSource: {} as MediaStreamAudioSourceNode, // Not used for Web Speech API
          audioStreamController: undefined,
          abortController,
          result: { ...result, mode: 'stream' as const, recognition: result.recognition },
          providerId,
          finish: result.finish,
          callbacks: {
            onSentenceEnd: options?.onSentenceEnd,
            onSpeechEnd: options?.onSpeechEnd,
          },
          trace,
        }
        ownedSession = activeSession
        streamingSession.value = activeSession
        startupTrace = undefined

        // Initial idle timer (only if enabled)
        bumpIdle()

        // Stream out text deltas
        if (result.textStream) {
          void (async () => {
            try {
              const reader = result.textStream.getReader()

              while (true) {
                const { done } = await reader.read()
                if (done)
                  break
                // onSentenceEnd is already called from the recognition.onresult handler
                // Note: onSpeechEnd is called from web-speech-api/index.ts recognition.onend handler
                // (line 332 for non-continuous mode, line 271 for errors)
                // We don't call it here to avoid duplicate calls
              }
            }
            catch (err) {
              if (!isExpectedStreamStopError(err))
                console.error('Error reading text stream:', err)
            }
          })()
        }

        return handleForStreamingSession(activeSession)
      }

      const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, any>>(providerId)
      if (!provider) {
        throw new Error('Failed to initialize speech provider')
      }

      const idleTimeout = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT

      // If a session exists, reuse it unless new callbacks are provided.
      // The stream reader captures callbacks at creation time, so updated callbacks
      // require restarting the session to create a new reader.
      const existingSession = streamingSession.value
      if (existingSession) {
        const hasNewCallbacks = haveStreamingCallbacksChanged(existingSession.callbacks, {
          onSentenceEnd: options?.onSentenceEnd,
          onSpeechEnd: options?.onSpeechEnd,
        })

        if (hasNewCallbacks) {
          console.info('[Hearing Pipeline] New callbacks provided, restarting session')
          // Detaching is synchronous; the prior provider response may finish in parallel.
          void finishStreamingSession(existingSession, false)
        }
        else {
          resetStreamingIdleTimer(existingSession, idleTimeout)
          return handleForStreamingSession(existingSession)
        }
      }

      const trace = startStreamingAsrTrace(providerId)
      startupTrace = trace

      const abortController = new AbortController()
      let ownedSession: ActiveStreamingTranscriptionSession | undefined
      const bumpIdle = () => {
        if (ownedSession)
          resetStreamingIdleTimer(ownedSession, idleTimeout)
      }

      const audioSession = await createAudioStreamFromMediaStream(
        stream,
        options?.sampleRate ?? DEFAULT_SAMPLE_RATE,
        () => bumpIdle(),
      )

      if (audioSession.audioContext.state === 'suspended')
        await audioSession.audioContext.resume()

      const result = await hearingStore.transcription(
        providerId,
        provider,
        model,
        { inputAudioStream: audioSession.audioStream },
        undefined,
        {
          providerOptions: {
            abortSignal: abortController.signal,
            ...options?.providerOptions,
          },
        },
      )

      const activeSession: ActiveStreamingTranscriptionSession = {
        audioContext: audioSession.audioContext,
        workletNode: audioSession.workletNode,
        mediaStreamSource: audioSession.mediaStreamSource,
        audioStreamController: audioSession.controller,
        abortController,
        result,
        providerId,
        callbacks: {
          onSentenceEnd: options?.onSentenceEnd,
          onSpeechEnd: options?.onSpeechEnd,
        },
        trace,
      }
      ownedSession = activeSession
      streamingSession.value = activeSession
      startupTrace = undefined
      bumpIdle()

      // Stream out text deltas to caller without tearing down the session.
      if (result.mode === 'stream' && result.textStream) {
        void (async () => {
          let fullText = ''
          try {
            const reader = result.textStream.getReader()

            while (true) {
              const { done, value } = await reader.read()
              if (done)
                break
              if (value) {
                fullText += value
                if (!trace.ended)
                  trace.span.addEvent(IOEvents.ASRSentenceEnd, { [IOAttributes.ASRText]: value })
                activeSession.callbacks?.onSentenceEnd?.(value)
              }
            }
          }
          catch (err) {
            if (!isExpectedStreamStopError(err))
              console.error('Error reading text stream:', err)
          }
          finally {
            endStreamingAsrTrace(trace, fullText)
            activeSession.callbacks?.onSpeechEnd?.(fullText)
          }
        })()
      }

      return handleForStreamingSession(activeSession)
    }
    catch (err) {
      if (startupTrace)
        endStreamingAsrTrace(startupTrace)

      if (isExpectedStreamStopError(err))
        return

      error.value = errorMessage(err)
      console.error('Error generating transcription:', error.value)
    }
  }

  async function transcribeForMediaStream(
    stream: MediaStream,
    options?: MediaStreamTranscriptionOptions,
  ): Promise<HearingStreamingTranscriptionSession | undefined> {
    const previousStartup = streamingStartupTail
    let releaseStartup: () => void = () => undefined
    streamingStartupTail = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })

    await previousStartup
    try {
      return await startStreamingTranscriptionSession(stream, options)
    }
    finally {
      releaseStartup()
    }
  }

  async function transcribeForRecording(
    recording: Blob | null | undefined,
    options: RecordingTranscriptionOptions = {},
  ): Promise<string | undefined> {
    error.value = undefined
    const request = resolveTranscriptionRequest(options.selection)

    if (!recording) {
      error.value = 'No recording captured from microphone'
      trackVoiceInputCancelled({ stt_provider_id: request.providerId || 'unknown' })
      return
    }

    if (recording.size <= 0) {
      error.value = 'Recording captured from microphone is empty'
      trackAudioDeviceUnavailable({
        stt_provider_id: request.providerId || 'unknown',
        error_code: 'device_unavailable',
      })
      return
    }

    try {
      const { model, providerConfig, providerId } = request
      const providerError = resolveActiveTranscriptionProviderError(providerId)
      if (providerError) {
        error.value = providerError
        console.error('[Hearing Pipeline]', providerError)
        return
      }

      const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, any>>(providerId)
      if (!provider) {
        throw new Error('Failed to initialize speech provider')
      }

      const providerOptions = {
        ...resolveTranscriptionProviderOptions(providerConfig),
        ...options.providerOptions,
      }
      console.info('[Hearing Pipeline] Transcribing recording', {
        providerId,
        language: providerOptions.language,
        model,
        recordingSize: recording.size,
        recordingType: recording.type,
      })
      const result = await hearingStore.transcription(
        providerId,
        provider,
        model,
        new File([recording], 'recording.wav', { type: recording.type || 'audio/wav' }),
        undefined,
        { providerOptions },
      )
      const text = result.mode === 'stream' ? await result.text : result.text
      // A provider may successfully recognize no speech after VAD captures noise, music, or an
      // incomplete utterance. This completes the segment without creating a dialogue turn; only
      // transport, protocol, or provider exceptions fail the hearing pipeline.
      if (!text || !text.trim())
        return ''

      return text
    }
    catch (err) {
      error.value = errorMessage(err)
      console.error('Error generating transcription:', error.value)
    }
  }

  return {
    error,

    transcribeForRecording,
    transcribeForMediaStream,
    stopStreamingTranscription,
    supportsStreamInput,
  }
})
