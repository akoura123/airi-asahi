import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { CommonRequestOptions } from '@xsai/shared'
import type { StreamTranscriptionDelta, StreamTranscriptionResult } from '@xsai/stream-transcription'

import { errorMessageFrom } from '@moeru/std'

type AudioChunk = ArrayBuffer | ArrayBufferView

export interface VolcengineRealtimeSpeechExtraOptions {
  abortSignal?: AbortSignal
  inputAudioStream?: ReadableStream<AudioChunk>
}

interface VolcengineStreamTranscriptionOptions extends VolcengineRealtimeSpeechExtraOptions {
  apiKey?: CommonRequestOptions['apiKey']
  baseURL?: CommonRequestOptions['baseURL']
  file?: Blob
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function parseSseLine(line: string): StreamTranscriptionDelta | undefined {
  if (!line || !line.startsWith('data:'))
    return undefined

  const content = line.slice('data:'.length)
  const data = content.startsWith(' ') ? content.slice(1) : content
  if (!data)
    return undefined

  return JSON.parse(data) as StreamTranscriptionDelta
}

function resolveAudioStream(options: VolcengineStreamTranscriptionOptions): ReadableStream<AudioChunk> {
  const stream = options.inputAudioStream ?? options.file?.stream()
  if (!stream)
    throw new TypeError('Audio stream is required for Volcengine realtime transcription.')
  return stream as ReadableStream<AudioChunk>
}

/**
 * Consumes the server-side Volcengine BYOK relay over WebSocket as an xsAI-compatible stream.
 *
 * The relay owns the upstream binary WebSocket because the browser WebSocket
 * API cannot attach Volcengine's required authentication headers. The provider
 * key is sent in the first WebSocket frame, never in the URL.
 */
export function streamVolcengineTranscription(options: VolcengineStreamTranscriptionOptions): StreamTranscriptionResult {
  const audioStream = resolveAudioStream(options)
  const apiKey = options.apiKey?.trim()
  if (!apiKey)
    throw new TypeError('Volcengine API key is required for realtime transcription.')

  const deferredText = createDeferred<string>()
  let text = ''
  let textStreamController: ReadableStreamDefaultController<string> | undefined
  let fullStreamController: ReadableStreamDefaultController<StreamTranscriptionDelta> | undefined
  let audioReader: ReadableStreamDefaultReader<AudioChunk> | undefined
  let streamsClosed = false

  const fullStream = new ReadableStream<StreamTranscriptionDelta>({
    start(controller) {
      fullStreamController = controller
    },
  })
  const textStream = new ReadableStream<string>({
    start(controller) {
      textStreamController = controller
    },
  })

  let resolveCompletion!: () => void
  let rejectCompletion!: (reason?: unknown) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  const websocketURL = (() => {
    const url = options.baseURL instanceof URL
      ? new URL(options.baseURL)
      : new URL(typeof options.baseURL === 'string' ? options.baseURL : 'http://localhost')
    if (url.protocol === 'https:')
      url.protocol = 'wss:'
    else if (url.protocol === 'http:')
      url.protocol = 'ws:'
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
      throw new TypeError(`Unsupported Volcengine transcription relay protocol: ${url.protocol}`)
    return url
  })()

  const websocket = new WebSocket(websocketURL)
  websocket.binaryType = 'arraybuffer'
  let websocketOpened = false
  let websocketOpenSettled = false
  let resolveWebsocketOpen!: () => void
  let rejectWebsocketOpen!: (reason?: unknown) => void
  const websocketOpen = new Promise<void>((resolve, reject) => {
    resolveWebsocketOpen = resolve
    rejectWebsocketOpen = reject
  })
  const responseDecoder = new TextDecoder()
  let sseBuffer = ''

  function settleWebsocketOpen(error?: unknown) {
    if (websocketOpenSettled)
      return
    websocketOpenSettled = true
    if (error)
      rejectWebsocketOpen(error)
    else
      resolveWebsocketOpen()
  }

  function closeWebSocket(reason: string) {
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)
      websocket.close(1000, reason)
  }

  function closeStreams() {
    if (streamsClosed)
      return
    streamsClosed = true
    fullStreamController?.close()
    textStreamController?.close()
    deferredText.resolve(text)
    resolveCompletion()
  }

  function failStreams(error: unknown) {
    if (streamsClosed)
      return
    streamsClosed = true
    const normalized = error instanceof Error ? error : new Error(errorMessageFrom(error) ?? String(error))
    fullStreamController?.error(normalized)
    textStreamController?.error(normalized)
    deferredText.reject(normalized)
    rejectCompletion(normalized)
    void audioReader?.cancel()
    closeWebSocket('relay_failed')
  }

  function handleDelta(chunk: StreamTranscriptionDelta) {
    if (streamsClosed)
      return
    fullStreamController?.enqueue(chunk)
    if (chunk.type === 'transcript.text.delta') {
      text += chunk.delta
      textStreamController?.enqueue(chunk.delta)
      return
    }
    if (chunk.type === 'transcript.text.done') {
      closeStreams()
      closeWebSocket('completed')
    }
  }

  function handleSseText(chunk: string) {
    if (streamsClosed)
      return
    sseBuffer += chunk
    const lines = sseBuffer.split('\n')
    sseBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseSseLine(line.trimEnd())
      if (parsed)
        handleDelta(parsed)
    }
  }

  function handleControlFrame(data: string): boolean {
    const trimmed = data.trim()
    if (!trimmed.startsWith('{'))
      return false
    try {
      const frame: unknown = JSON.parse(trimmed)
      if (!frame || typeof frame !== 'object' || (frame as Record<string, unknown>).event !== 'error')
        return false
      const message = (frame as Record<string, unknown>).message
      throw new Error(typeof message === 'string' ? message : 'Volcengine ASR relay failed.')
    }
    catch (error) {
      if (error instanceof SyntaxError)
        return false
      throw error
    }
  }

  async function handleServerMessage(data: unknown) {
    if (typeof data === 'string') {
      if (!handleControlFrame(data))
        handleSseText(data)
      return
    }
    if (data instanceof ArrayBuffer) {
      const text = responseDecoder.decode(data, { stream: true })
      if (!handleControlFrame(text))
        handleSseText(text)
      return
    }
    if (data instanceof Blob) {
      const text = await data.text()
      if (!handleControlFrame(text))
        handleSseText(text)
      return
    }
    throw new Error('Volcengine ASR relay returned an unsupported WebSocket frame.')
  }

  websocket.onopen = () => {
    websocketOpened = true
    settleWebsocketOpen()
  }
  websocket.onerror = () => {
    const error = new Error('Volcengine ASR relay WebSocket failed.')
    if (!websocketOpened)
      settleWebsocketOpen(error)
    else
      failStreams(error)
  }
  websocket.onclose = (event) => {
    if (!websocketOpened)
      settleWebsocketOpen(new Error(`Volcengine ASR relay WebSocket closed before opening (${event.code}).`))
    else if (!streamsClosed)
      failStreams(new Error(event.reason || `Volcengine ASR relay WebSocket closed (${event.code}).`))
  }
  websocket.onmessage = (event) => {
    void handleServerMessage(event.data).catch(error => failStreams(error))
  }

  const abortHandler = () => {
    const reason = options.abortSignal?.reason ?? new DOMException('Aborted', 'AbortError')
    if (!websocketOpened)
      settleWebsocketOpen(reason)
    failStreams(reason)
  }
  options.abortSignal?.addEventListener('abort', abortHandler, { once: true })
  if (options.abortSignal?.aborted)
    abortHandler()

  void (async () => {
    try {
      await websocketOpen
      websocket.send(JSON.stringify({ event: 'start', apiKey }))

      audioReader = audioStream.getReader()
      while (true) {
        const { done, value } = await audioReader.read()
        if (done) {
          websocket.send(JSON.stringify({ event: 'finish' }))
          break
        }
        if (value && !streamsClosed)
          websocket.send(toArrayBuffer(value))
      }

      await completion
    }
    catch (error) {
      failStreams(error)
    }
    finally {
      options.abortSignal?.removeEventListener('abort', abortHandler)
    }
  })()

  return { fullStream, text: deferredText.promise, textStream }
}

function toArrayBuffer(chunk: AudioChunk): ArrayBuffer {
  if (chunk instanceof ArrayBuffer)
    return chunk

  if (ArrayBuffer.isView(chunk)) {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    return bytes.slice().buffer
  }

  throw new TypeError('Unsupported audio chunk type for Volcengine streaming transcription.')
}

export function createVolcengineRealtimeTranscriptionProvider(
  apiKey: string,
  relayBaseURL: string,
): SpeechProviderWithExtraOptions<string, VolcengineRealtimeSpeechExtraOptions> {
  return {
    speech(model) {
      const baseURL = new URL('audio/transcriptions/ws', relayBaseURL)
      baseURL.searchParams.set('resource_id', model)
      return {
        apiKey,
        baseURL,
        model,
      }
    },
  }
}
