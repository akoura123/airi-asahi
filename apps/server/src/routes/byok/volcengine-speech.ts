import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { literal, maxValue, minValue, nonEmpty, number, object, optional, picklist, pipe, safeParse, string } from 'valibot'

import { synthesizeVolcengineV3Speech } from '../../services/adapters/tts/volcengine-v3'
import { createBadRequestError, createUnauthorizedError } from '../../utils/error'

const SpeechRequestSchema = object({
  input: pipe(string(), nonEmpty('input must not be empty')),
  model: literal('seed-tts-2.0'),
  response_format: optional(picklist(['mp3', 'opus', 'pcm', 'wav']), 'mp3'),
  speed: optional(pipe(number(), minValue(0.5), maxValue(2)), 1),
  voice: pipe(string(), nonEmpty('voice must not be empty')),
})

/**
 * Creates the browser-safe Volcengine BYOK relay.
 *
 * The route accepts OpenAI-shaped speech requests from xsAI and forwards the
 * caller's own API key to a fixed Volcengine V3 endpoint. It does not use AIRI
 * provider credentials, Flux billing, or fallback routing.
 */
export function createVolcengineByokSpeechRoutes(fetchImpl: typeof fetch = globalThis.fetch) {
  return new Hono<HonoEnv>()
    .use('/audio/speech', bodyLimit({ maxSize: 64 * 1024 }))
    .post('/audio/speech', async (c) => {
      const apiKey = readBearerCredential(c.req.header('Authorization'))
      let body: unknown
      try {
        body = await c.req.json()
      }
      catch (error) {
        throw Object.assign(
          createBadRequestError('Invalid Volcengine speech request body', 'INVALID_REQUEST'),
          { cause: error },
        )
      }

      const parsed = safeParse(SpeechRequestSchema, body)
      if (!parsed.success)
        throw createBadRequestError('Invalid Volcengine speech request', 'INVALID_REQUEST', parsed.issues)

      const responseFormat = parsed.output.response_format === 'opus'
        ? 'ogg_opus'
        : parsed.output.response_format
      const result = await synthesizeVolcengineV3Speech({
        abortSignal: c.req.raw.signal,
        apiKey,
        fetchImpl,
        resourceId: parsed.output.model,
        responseFormat,
        speed: parsed.output.speed,
        text: parsed.output.input,
        voice: parsed.output.voice,
      })

      return c.body(result.audio.buffer, 200, {
        'Content-Type': result.contentType,
        'X-Content-Type-Options': 'nosniff',
      })
    })
}

function readBearerCredential(authorization?: string): string {
  if (!authorization?.startsWith('Bearer '))
    throw createUnauthorizedError('Volcengine API key is required')

  const apiKey = authorization.slice(7).trim()
  if (!apiKey)
    throw createUnauthorizedError('Volcengine API key is required')

  return apiKey
}
