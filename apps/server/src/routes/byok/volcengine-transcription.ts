import type { WSContext, WSEvents } from 'hono/ws'

import { useLogger } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'

import { createVolcengineAsrStreamResponse } from '../../services/adapters/asr/volcengine-v3'

const log = useLogger('volcengine-transcription-ws').useGlobalConfig()

interface VolcengineTranscriptionStartFrame {
  event: 'start'
  apiKey: string
}

interface VolcengineTranscriptionControlFrame {
  event: 'finish' | 'cancel'
}

/**
 * Creates the per-connection WebSocket setup for the Volcengine BYOK ASR relay.
 *
 * The browser sends the provider key in the first WebSocket message instead of
 * putting it in the URL. The relay converts later binary messages into the
 * existing server-side audio stream, so the Volcengine protocol and transcript
 * semantics remain owned by the ASR adapter.
 */
export function createVolcengineByokTranscriptionWsHandlers() {
  return function setupPeer(resourceId?: string): WSEvents {
    const abortController = new AbortController()
    let audioController: ReadableStreamDefaultController<Uint8Array> | undefined
    const audioStream = new ReadableStream<Uint8Array>({
      start(controller) {
        audioController = controller
      },
    })

    let audioStreamClosed = false
    let clientWs: WSContext | undefined
    let started = false
    let closed = false

    function closeAudioStream() {
      if (audioStreamClosed)
        return
      audioStreamClosed = true
      try {
        audioController?.close()
      }
      catch {}
    }

    function errorAudioStream(error: unknown) {
      if (audioStreamClosed)
        return
      audioStreamClosed = true
      try {
        audioController?.error(error)
      }
      catch {}
    }

    function terminate(error: unknown, code: number, reason: string, closeSocket: boolean) {
      if (closed)
        return
      closed = true
      abortController.abort(error)
      errorAudioStream(error)

      if (closeSocket) {
        try {
          clientWs?.close(code, reason)
        }
        catch {}
      }
    }

    function complete() {
      if (closed)
        return
      closed = true
      closeAudioStream()
      try {
        clientWs?.close(1000, 'completed')
      }
      catch {}
    }

    function sendError(error: unknown, code: string) {
      if (closed)
        return

      const message = errorMessageFrom(error) ?? code
      try {
        clientWs?.send(JSON.stringify({
          event: 'error',
          code,
          message,
        }))
      }
      catch {}

      terminate(error, 1011, code, true)
    }

    function sendResponseChunk(text: string) {
      if (closed)
        return
      if (text)
        clientWs?.send(text)
    }

    async function forwardResponse(response: Response) {
      if (!response.body)
        throw new Error('Volcengine ASR relay response has no readable body.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done)
            break
          if (value?.byteLength)
            sendResponseChunk(decoder.decode(value, { stream: true }))
        }

        if (!closed) {
          const tail = decoder.decode()
          if (tail)
            clientWs?.send(tail)
          complete()
        }
      }
      finally {
        reader.releaseLock()
      }
    }

    function startRelay(frame: VolcengineTranscriptionStartFrame) {
      let response: Response
      try {
        response = createVolcengineAsrStreamResponse({
          abortSignal: abortController.signal,
          apiKey: frame.apiKey,
          audioStream,
          resourceId,
        })
      }
      catch (error) {
        sendError(error, 'relay_start_failed')
        return
      }

      void forwardResponse(response).catch((error) => {
        if (!closed)
          sendError(error, 'relay_stream_failed')
      })
    }

    function parseStartFrame(data: string): VolcengineTranscriptionStartFrame | undefined {
      try {
        const parsed: unknown = JSON.parse(data)
        if (!parsed || typeof parsed !== 'object')
          return undefined
        const frame = parsed as Record<string, unknown>
        const apiKey = typeof frame.apiKey === 'string' ? frame.apiKey.trim() : ''
        if (frame.event !== 'start' || !apiKey)
          return undefined
        return { apiKey, event: 'start' }
      }
      catch {
        return undefined
      }
    }

    function parseControlFrame(data: string): VolcengineTranscriptionControlFrame | undefined {
      try {
        const parsed: unknown = JSON.parse(data)
        if (!parsed || typeof parsed !== 'object')
          return undefined
        const event = (parsed as Record<string, unknown>).event
        return event === 'finish' || event === 'cancel' ? { event } : undefined
      }
      catch {
        return undefined
      }
    }

    function normalizeAudioData(data: unknown): Uint8Array | undefined {
      if (data instanceof Uint8Array)
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      if (data instanceof ArrayBuffer)
        return new Uint8Array(data)
      if (!Array.isArray(data))
        return undefined

      const chunks: Uint8Array[] = []
      for (const part of data) {
        if (!(part instanceof Uint8Array))
          return undefined
        chunks.push(part)
      }
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const output = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      return output
    }

    function handleClientMessage(message: { data: unknown }, ws: WSContext) {
      if (closed)
        return
      clientWs = ws

      if (!started) {
        if (typeof message.data !== 'string') {
          sendError(new Error('Volcengine ASR start frame must be JSON text.'), 'invalid_start_frame')
          return
        }

        const frame = parseStartFrame(message.data)
        if (!frame) {
          sendError(new Error('Volcengine ASR start frame is invalid.'), 'invalid_start_frame')
          return
        }

        started = true
        startRelay(frame)
        return
      }

      if (typeof message.data === 'string') {
        const frame = parseControlFrame(message.data)
        if (!frame) {
          sendError(new Error('Volcengine ASR control frame is invalid.'), 'invalid_control_frame')
          return
        }

        if (frame.event === 'finish')
          closeAudioStream()
        else
          terminate(new Error('Volcengine ASR session cancelled by client.'), 1000, 'cancelled', true)
        return
      }

      const audio = normalizeAudioData(message.data)
      if (!audio) {
        sendError(new Error('Volcengine ASR audio frame must be binary.'), 'invalid_audio_frame')
        return
      }

      try {
        audioController?.enqueue(audio)
      }
      catch (error) {
        sendError(error, 'audio_stream_failed')
      }
    }

    function handleClientClose() {
      if (closed)
        return
      terminate(new Error('Volcengine ASR client disconnected.'), 1000, 'client_closed', false)
    }

    function handleClientError(event: unknown, ws: WSContext) {
      clientWs = ws
      log.withFields({ event: String(event) }).warn('Volcengine ASR client WebSocket error')
      sendError(new Error('Volcengine ASR client WebSocket error.'), 'client_ws_error')
    }

    return {
      onOpen(_event, ws) {
        clientWs = ws
      },
      onMessage(message, ws) {
        handleClientMessage(message, ws)
      },
      onClose() {
        handleClientClose()
      },
      onError(event, ws) {
        handleClientError(event, ws)
      },
    }
  }
}
