import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { MeetingMediaPcmChunk } from '@proj-airi/stage-shared/meeting-media'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { app } from 'electron'

const FRAME_MAGIC = Buffer.from('AIRI')
const FRAME_PROTOCOL_VERSION = 1
const FRAME_HEADER_BYTES = 40
const FLOAT32_SAMPLE_FORMAT = 1
const MAX_PCM_PAYLOAD_BYTES = 2 * 1024 * 1024
const START_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 3_000

interface CapturedPcmFrame {
  sequence: number
  capturedAtMs: number
  sampleRate: number
  channelCount: number
  samples: Float32Array
}

export interface MacOSApplicationAudioCaptureSession {
  sessionId: string
  stop: () => Promise<void>
}

export interface StartMacOSApplicationAudioCaptureOptions {
  sessionId: string
  captureSourceId: string
  onChunk: (chunk: MeetingMediaPcmChunk) => void
  onFailure: (error: Error) => void
}

/** Returns the bundled ScreenCaptureKit helper used by both preflight and session allocation. */
export function resolveMacOSApplicationAudioCaptureExecutable(): string {
  if (app.isPackaged)
    return join(process.resourcesPath, 'meeting-media', 'bin', 'airi-meeting-audio-capture')

  return join(
    app.getAppPath(),
    'native',
    'meeting-media',
    'bin',
    `darwin-${process.arch}`,
    'airi-meeting-audio-capture',
  )
}

/** Reports whether the current build contains an executable application-audio capture helper. */
export async function hasMacOSApplicationAudioCaptureExecutable(): Promise<boolean> {
  if (process.platform !== 'darwin')
    return false

  try {
    await access(resolveMacOSApplicationAudioCaptureExecutable(), fsConstants.X_OK)
    return true
  }
  catch {
    return false
  }
}

function captureWindowId(sourceId: string): number {
  const match = /^window:(\d+):/.exec(sourceId)
  const windowId = match ? Number.parseInt(match[1], 10) : Number.NaN
  if (!Number.isSafeInteger(windowId) || windowId <= 0)
    throw new Error(`Meeting capture source "${sourceId}" does not contain a valid macOS window identifier.`)
  return windowId
}

/** Parses the helper's bounded binary envelope without exposing raw PCM to logs. */
class ApplicationAudioFrameParser {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  push(chunk: Buffer<ArrayBufferLike>): CapturedPcmFrame[] {
    this.buffered = this.buffered.length === 0
      ? chunk
      : Buffer.concat([this.buffered, chunk], this.buffered.length + chunk.length)

    const frames: CapturedPcmFrame[] = []
    while (this.buffered.length >= FRAME_HEADER_BYTES) {
      if (!this.buffered.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC))
        throw new Error('Application-audio helper emitted an invalid PCM frame magic value.')

      const protocolVersion = this.buffered.readUInt16LE(4)
      const headerBytes = this.buffered.readUInt16LE(6)
      if (protocolVersion !== FRAME_PROTOCOL_VERSION || headerBytes !== FRAME_HEADER_BYTES)
        throw new Error('Application-audio helper PCM protocol version does not match AIRI.')

      const sequence = Number(this.buffered.readBigUInt64LE(8))
      const capturedAtMs = Number(this.buffered.readBigUInt64LE(16))
      const sampleRate = this.buffered.readUInt32LE(24)
      const channelCount = this.buffered.readUInt16LE(28)
      const sampleFormat = this.buffered.readUInt16LE(30)
      const frameCount = this.buffered.readUInt32LE(32)
      const payloadBytes = this.buffered.readUInt32LE(36)

      if (!Number.isSafeInteger(sequence)
        || !Number.isSafeInteger(capturedAtMs)
        || capturedAtMs <= 0
        || sampleRate < 8_000
        || sampleRate > 192_000
        || channelCount < 1
        || channelCount > 2
        || sampleFormat !== FLOAT32_SAMPLE_FORMAT
        || frameCount < 1
        || payloadBytes !== frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT
        || payloadBytes > MAX_PCM_PAYLOAD_BYTES) {
        throw new Error('Application-audio helper emitted an invalid PCM frame header.')
      }

      const envelopeBytes = FRAME_HEADER_BYTES + payloadBytes
      if (this.buffered.length < envelopeBytes)
        break

      const payload = this.buffered.subarray(FRAME_HEADER_BYTES, envelopeBytes)
      const copiedPayload = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      frames.push({
        sequence,
        capturedAtMs,
        sampleRate,
        channelCount,
        samples: new Float32Array(copiedPayload),
      })
      this.buffered = this.buffered.subarray(envelopeBytes)
    }

    if (this.buffered.length > FRAME_HEADER_BYTES + MAX_PCM_PAYLOAD_BYTES)
      throw new Error('Application-audio helper exceeded the bounded PCM transport buffer.')
    return frames
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true)

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const onExit = () => {
      if (timeout)
        clearTimeout(timeout)
      child.off('exit', onExit)
      resolve(true)
    }
    timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

/**
 * Starts one application-filtered ScreenCaptureKit audio session.
 *
 * The selected window identifies the owning meeting application. ScreenCaptureKit then captures
 * that application's audio only, so AIRI TTS and unrelated system output cannot enter meeting ASR.
 */
export async function startMacOSApplicationAudioCapture(
  options: StartMacOSApplicationAudioCaptureOptions,
): Promise<MacOSApplicationAudioCaptureSession> {
  if (process.platform !== 'darwin')
    throw new Error('Application-filtered ScreenCaptureKit audio capture is available only on macOS.')

  const log = useLogg('meeting-application-audio').useGlobalConfig()
  const executable = resolveMacOSApplicationAudioCaptureExecutable()
  const windowId = captureWindowId(options.captureSourceId)
  const parser = new ApplicationAudioFrameParser()
  const child = spawn(executable, ['--window-id', String(windowId)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stopping = false
  let failureReported = false
  let diagnosticBuffer = ''
  let settleStartup: ((error?: Error) => void) | null = null

  const startup = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      settleStartup?.(new Error('Application-audio helper did not become ready before the start timeout.'))
    }, START_TIMEOUT_MS)

    settleStartup = (error) => {
      if (!settleStartup)
        return
      settleStartup = null
      clearTimeout(timeout)
      if (error)
        reject(error)
      else
        resolve()
    }
  })

  function reportFailure(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    settleStartup?.(normalized)
    if (stopping || failureReported)
      return
    failureReported = true
    log.withError(normalized).error('Application-filtered meeting audio capture failed')
    options.onFailure(normalized)
  }

  child.stdout.on('data', (data: Buffer) => {
    try {
      for (const frame of parser.push(data)) {
        options.onChunk({
          sessionId: options.sessionId,
          sequence: frame.sequence,
          capturedAtMs: frame.capturedAtMs,
          sampleRate: frame.sampleRate,
          channelCount: frame.channelCount,
          layout: 'interleaved',
          samples: frame.samples,
        })
      }
    }
    catch (error) {
      reportFailure(error)
      child.kill('SIGTERM')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (data: string) => {
    diagnosticBuffer += data
    const lines = diagnosticBuffer.split('\n')
    diagnosticBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim())
        continue
      try {
        const diagnostic = JSON.parse(line) as { event?: string, message?: string }
        if (diagnostic.event === 'ready') {
          log.withFields({ sessionId: options.sessionId, windowId }).log('Application-filtered meeting audio capture started')
          settleStartup?.()
        }
        else if (diagnostic.event === 'error') {
          reportFailure(new Error(diagnostic.message || 'Application-audio helper reported an unknown error.'))
        }
      }
      catch (error) {
        reportFailure(new Error(`Application-audio helper emitted malformed diagnostics: ${errorMessageFrom(error) ?? line}`))
      }
    }
  })
  child.once('error', reportFailure)
  child.once('exit', (code, signal) => {
    if (!stopping) {
      reportFailure(new Error(
        `Application-audio helper exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
      ))
    }
  })

  try {
    await startup
  }
  catch (error) {
    stopping = true
    child.stdin.end()
    if (!await waitForExit(child, STOP_TIMEOUT_MS))
      child.kill('SIGKILL')
    throw error
  }

  return {
    sessionId: options.sessionId,
    async stop() {
      if (stopping)
        return
      stopping = true
      child.stdin.end()
      if (!await waitForExit(child, STOP_TIMEOUT_MS)) {
        child.kill('SIGKILL')
        await waitForExit(child, STOP_TIMEOUT_MS)
      }
      log.withFields({ sessionId: options.sessionId }).log('Application-filtered meeting audio capture stopped')
    },
  }
}
