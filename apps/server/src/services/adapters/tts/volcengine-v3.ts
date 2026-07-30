import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import { errorMessageFrom } from '@moeru/std'
import { number, object, optional, safeParse, string } from 'valibot'

import { createBadGatewayError, createBadRequestError } from '../../../utils/error'
import { audioMimeFromFormat } from './audio-format'

const VOLCENGINE_V3_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const VOLCENGINE_AUDIO_CHUNK_CODE = 0
const VOLCENGINE_FINISHED_CODE = 20000000

const VolcengineStreamChunkSchema = object({
  code: number(),
  message: optional(string()),
  data: optional(string()),
})

export type VolcengineV3ResponseFormat = 'mp3' | 'ogg_opus' | 'pcm' | 'wav'

interface VolcengineV3SpeechOptions {
  abortSignal?: AbortSignal
  apiKey: string
  fetchImpl: typeof fetch
  resourceId: string
  responseFormat: VolcengineV3ResponseFormat
  speed: number
  text: string
  voice: string
}

interface VolcengineV3SpeechResult {
  audio: Uint8Array<ArrayBuffer>
  contentType: string
}

/**
 * Synthesizes one complete utterance through Volcengine's V3 unidirectional
 * HTTP protocol.
 *
 * The upstream responds as newline-delimited JSON containing base64 audio
 * chunks. This boundary accepts a complete text input, verifies that the
 * terminal success frame arrived, and only then returns concatenated audio;
 * truncated upstream responses never become apparently successful playback.
 */
export async function synthesizeVolcengineV3Speech(options: VolcengineV3SpeechOptions): Promise<VolcengineV3SpeechResult> {
  const requestId = randomUUID()
  const speechRate = toVolcengineSpeechRate(options.speed)

  let response: Response
  try {
    response = await options.fetchImpl(VOLCENGINE_V3_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': options.apiKey,
        'X-Api-Request-Id': requestId,
        'X-Api-Resource-Id': options.resourceId,
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      body: JSON.stringify({
        req_params: {
          text: options.text,
          speaker: options.voice,
          audio_params: {
            format: options.responseFormat,
            sample_rate: 24000,
            ...(options.responseFormat === 'mp3' ? { bit_rate: 64000 } : {}),
            speech_rate: speechRate,
          },
        },
      }),
      signal: options.abortSignal,
    })
  }
  catch (error) {
    throw Object.assign(
      createBadGatewayError('Volcengine V3 speech request failed'),
      { cause: error },
    )
  }

  const logId = response.headers.get('X-Tt-Logid') ?? undefined
  let responseText: string
  try {
    responseText = await response.text()
  }
  catch (error) {
    throw Object.assign(
      createBadGatewayError('Volcengine V3 response body could not be read', { logId }),
      { cause: error },
    )
  }

  if (!response.ok) {
    throw Object.assign(
      createBadGatewayError('Volcengine V3 rejected the speech request', {
        lastStatusCode: response.status,
        logId,
      }),
      { cause: new Error(`Volcengine V3 upstream ${response.status}: ${responseText.slice(0, 256)}`) },
    )
  }

  const audioChunks: Buffer[] = []
  let finished = false

  for (const rawLine of responseText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line)
      continue

    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    }
    catch (error) {
      throw malformedResponseError('Volcengine V3 returned malformed stream JSON', logId, error)
    }

    const parsed = safeParse(VolcengineStreamChunkSchema, decoded)
    if (!parsed.success)
      throw malformedResponseError('Volcengine V3 returned an invalid stream frame', logId, parsed.issues)

    if (parsed.output.code === VOLCENGINE_AUDIO_CHUNK_CODE) {
      if (parsed.output.data)
        audioChunks.push(Buffer.from(parsed.output.data, 'base64'))
      continue
    }

    if (parsed.output.code === VOLCENGINE_FINISHED_CODE) {
      finished = true
      continue
    }

    throw Object.assign(
      createBadGatewayError('Volcengine V3 failed to synthesize speech', {
        logId,
        upstreamCode: parsed.output.code,
      }),
      { cause: new Error(parsed.output.message ?? `Volcengine V3 upstream code ${parsed.output.code}`) },
    )
  }

  if (!finished)
    throw malformedResponseError('Volcengine V3 response ended before its completion frame', logId)

  const audio = Buffer.concat(audioChunks)
  if (audio.byteLength === 0)
    throw malformedResponseError('Volcengine V3 completed without audio data', logId)

  return {
    audio: Uint8Array.from(audio),
    contentType: audioMimeFromFormat(options.responseFormat),
  }
}

/**
 * Converts AIRI's speech multiplier to Volcengine's integer scale.
 *
 * Before:
 * - `0.5`, `1`, `2`
 *
 * After:
 * - `-50`, `0`, `100`
 */
function toVolcengineSpeechRate(speed: number): number {
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw createBadRequestError(
      'Volcengine speech speed must be between 0.5 and 2',
      'INVALID_SPEECH_SPEED',
    )
  }

  return Math.round((speed - 1) * 100)
}

function malformedResponseError(message: string, logId?: string, cause?: unknown) {
  return Object.assign(
    createBadGatewayError(message, { logId }),
    { cause: cause instanceof Error ? cause : new Error(errorMessageFrom(cause) ?? message) },
  )
}
