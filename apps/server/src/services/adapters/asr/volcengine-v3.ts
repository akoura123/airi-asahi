import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import WebSocket from 'ws'

const VOLCENGINE_ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const VOLCENGINE_ASR_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'
const VOLCENGINE_SUCCESS_CODES = new Set([0, 1000, 20000000])

const MESSAGE_FULL_CLIENT_REQUEST = 0x1
const MESSAGE_AUDIO_ONLY_REQUEST = 0x2
const MESSAGE_FULL_SERVER_RESPONSE = 0x9
const MESSAGE_ERROR = 0xF
const FLAG_NO_SEQUENCE = 0x0
const FLAG_FINAL_NO_SEQUENCE = 0x2
const FLAG_NEGATIVE_SEQUENCE = 0x3
const SERIALIZATION_NONE = 0x0
const SERIALIZATION_JSON = 0x1
const COMPRESSION_GZIP = 0x1

interface VolcengineAsrStreamOptions {
  audioStream: ReadableStream<Uint8Array>
  apiKey: string
  resourceId?: string
  abortSignal?: AbortSignal
}

interface ParsedServerFrame {
  messageType: number
  flags: number
  payload: Uint8Array
  sequence: number | null
  errorCode: number
}

interface VolcengineAsrPayload {
  code?: number
  status_code?: number
  message?: string
  result?: {
    text?: string
    utterances?: Array<{ text?: string }>
  }
  text?: string
}

const encoder = new TextEncoder()

function buildHeader(messageType: number, flags: number, serialization: number, compression: number): Uint8Array {
  return Uint8Array.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function joinFrameParts(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  const frame = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    frame.set(part, offset)
    offset += part.byteLength
  }
  return frame
}

function uint32Bytes(value: number): Uint8Array {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value, false)
  return output
}

function buildFullClientRequest(payload: Record<string, unknown>): Uint8Array {
  const compressed = gzipSync(JSON.stringify(payload))
  return joinFrameParts([
    buildHeader(MESSAGE_FULL_CLIENT_REQUEST, FLAG_NO_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP),
    uint32Bytes(compressed.byteLength),
    compressed,
  ])
}

function buildAudioOnlyRequest(audio: Uint8Array, final: boolean): Uint8Array {
  const compressed = gzipSync(audio)
  return joinFrameParts([
    buildHeader(
      MESSAGE_AUDIO_ONLY_REQUEST,
      final ? FLAG_FINAL_NO_SEQUENCE : FLAG_NO_SEQUENCE,
      SERIALIZATION_NONE,
      COMPRESSION_GZIP,
    ),
    uint32Bytes(compressed.byteLength),
    compressed,
  ])
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false)
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, false)
}

function normalizeWebSocketData(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer)
    return new Uint8Array(data)

  if (data instanceof Uint8Array)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  if (Array.isArray(data)) {
    const size = data.reduce((total, part) => total + (part instanceof Uint8Array ? part.byteLength : 0), 0)
    const output = new Uint8Array(size)
    let offset = 0
    for (const part of data) {
      if (!(part instanceof Uint8Array))
        continue
      output.set(part, offset)
      offset += part.byteLength
    }
    return output
  }

  throw new TypeError('Volcengine ASR returned an unsupported WebSocket frame type.')
}

function parseServerFrame(raw: Uint8Array): ParsedServerFrame {
  if (raw.byteLength < 4)
    throw new Error('Volcengine ASR returned a frame shorter than its header.')

  const headerSize = (raw[0] & 0x0F) * 4
  if (headerSize < 4 || raw.byteLength < headerSize)
    throw new Error('Volcengine ASR returned an invalid frame header.')

  const messageType = (raw[1] >> 4) & 0x0F
  const flags = raw[1] & 0x0F
  const compression = raw[2] & 0x0F
  let offset = headerSize

  if (messageType === MESSAGE_ERROR) {
    if (raw.byteLength < offset + 8)
      throw new Error('Volcengine ASR returned an incomplete error frame.')

    const errorCode = readUint32(raw, offset)
    const payloadSize = readUint32(raw, offset + 4)
    offset += 8
    const payload = raw.slice(offset, offset + payloadSize)
    return {
      messageType,
      flags,
      payload: compression === COMPRESSION_GZIP ? new Uint8Array(gunzipSync(payload)) : payload,
      sequence: null,
      errorCode,
    }
  }

  let sequence: number | null = null
  if (flags === 0x1 || flags === FLAG_NEGATIVE_SEQUENCE) {
    if (raw.byteLength < offset + 8)
      throw new Error('Volcengine ASR returned a frame without sequence metadata.')
    sequence = readInt32(raw, offset)
    offset += 4
  }

  if (raw.byteLength < offset + 4)
    throw new Error('Volcengine ASR returned a frame without a payload size.')

  const payloadSize = readUint32(raw, offset)
  offset += 4
  const payload = raw.slice(offset, offset + payloadSize)
  return {
    messageType,
    flags,
    payload: compression === COMPRESSION_GZIP ? new Uint8Array(gunzipSync(payload)) : payload,
    sequence,
    errorCode: 0,
  }
}

function decodePayload(frame: ParsedServerFrame): VolcengineAsrPayload {
  if (frame.messageType === MESSAGE_ERROR) {
    const message = new TextDecoder().decode(frame.payload)
    throw new Error(`Volcengine ASR upstream error ${frame.errorCode}: ${message.slice(0, 256)}`)
  }

  if (frame.messageType !== MESSAGE_FULL_SERVER_RESPONSE)
    return {}

  if (!frame.payload.byteLength)
    return {}

  const parsed: unknown = JSON.parse(new TextDecoder().decode(frame.payload))
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Volcengine ASR returned a non-object response payload.')
  return parsed as VolcengineAsrPayload
}

function payloadCode(payload: VolcengineAsrPayload): number {
  if (typeof payload.code === 'number')
    return payload.code
  if (typeof payload.status_code === 'number')
    return payload.status_code
  return 0
}

function recognizedText(payload: VolcengineAsrPayload): string {
  const utterances = payload.result?.utterances
  if (Array.isArray(utterances)) {
    const text = utterances
      .map(utterance => typeof utterance.text === 'string' ? utterance.text : '')
      .join('')
      .trim()
    if (text)
      return text
  }

  const resultText = payload.result?.text
  if (typeof resultText === 'string' && resultText.trim())
    return resultText.trim()

  return typeof payload.text === 'string' ? payload.text.trim() : ''
}

function sse(payload: { delta: string, type: 'transcript.text.delta' | 'transcript.text.done' }): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * Relays one microphone PCM stream to Volcengine's binary WebSocket ASR API.
 *
 * The browser-facing response is xsAI-compatible SSE. Only the final
 * upstream recognition result is emitted as text: the provider can revise
 * interim text, while the existing meeting assembler accepts append-only
 * transcript fragments and cannot express replacement semantics.
 */
export function createVolcengineAsrStreamResponse(options: VolcengineAsrStreamOptions): Response {
  const resourceId = options.resourceId?.trim() || VOLCENGINE_ASR_DEFAULT_RESOURCE_ID
  let websocket: WebSocket | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let finished = false
  let latestText = ''
  let abortHandler: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const requestId = randomUUID()

      const close = (error?: unknown) => {
        if (finished)
          return
        finished = true
        if (abortHandler && options.abortSignal)
          options.abortSignal.removeEventListener('abort', abortHandler)
        void reader?.cancel()
        if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING))
          websocket.close(1000, 'AIRI ASR relay closed')

        if (error)
          controller.error(error)
        else
          controller.close()
      }

      const emitFinalAndClose = () => {
        if (finished)
          return
        if (latestText)
          controller.enqueue(sse({ delta: latestText, type: 'transcript.text.delta' }))
        controller.enqueue(sse({ delta: '', type: 'transcript.text.done' }))
        close()
      }

      const pumpAudio = async () => {
        reader = options.audioStream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done)
              break
            if (!value?.byteLength || finished)
              continue
            if (!websocket || websocket.readyState !== WebSocket.OPEN)
              throw new Error('Volcengine ASR WebSocket closed before audio upload completed.')
            websocket.send(buildAudioOnlyRequest(value, false))
          }

          if (!finished && websocket?.readyState === WebSocket.OPEN)
            websocket.send(buildAudioOnlyRequest(new Uint8Array(0), true))
        }
        catch (error) {
          close(error)
        }
      }

      websocket = new WebSocket(VOLCENGINE_ASR_ENDPOINT, {
        headers: {
          'X-Api-Key': options.apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': requestId,
          'X-Api-Sequence': '-1',
          'X-Api-Connect-Id': requestId,
        },
      })
      websocket.binaryType = 'arraybuffer'

      websocket.on('open', () => {
        websocket?.send(buildFullClientRequest({
          user: { uid: requestId },
          audio: {
            format: 'pcm',
            codec: 'raw',
            rate: 16000,
            bits: 16,
            channel: 1,
          },
          request: {
            model_name: 'bigmodel',
            enable_nonstream: true,
            enable_itn: true,
            enable_punc: true,
            enable_accelerate_text: true,
            show_utterances: true,
          },
        }))
        void pumpAudio()
      })

      websocket.on('message', (data, isBinary) => {
        if (!isBinary)
          return
        try {
          const frame = parseServerFrame(normalizeWebSocketData(data))
          const payload = decodePayload(frame)
          const code = payloadCode(payload)
          if (!VOLCENGINE_SUCCESS_CODES.has(code))
            throw new Error(`Volcengine ASR returned code ${code}: ${payload.message ?? 'unknown error'}`)

          const text = recognizedText(payload)
          if (text)
            latestText = text

          if (frame.flags === FLAG_FINAL_NO_SEQUENCE
            || frame.flags === FLAG_NEGATIVE_SEQUENCE
            || (frame.sequence !== null && frame.sequence < 0)) {
            emitFinalAndClose()
          }
        }
        catch (error) {
          close(error)
        }
      })

      websocket.on('error', error => close(error))
      websocket.on('close', () => {
        if (!finished)
          close(new Error('Volcengine ASR WebSocket closed before the final transcript.'))
      })

      abortHandler = () => close(options.abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'))
      options.abortSignal?.addEventListener('abort', abortHandler, { once: true })
      if (options.abortSignal?.aborted)
        abortHandler()
    },
    cancel() {
      if (!finished) {
        finished = true
        void reader?.cancel()
        websocket?.close(1000, 'AIRI ASR response cancelled')
      }
    },
  })

  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream',
    },
  })
}
