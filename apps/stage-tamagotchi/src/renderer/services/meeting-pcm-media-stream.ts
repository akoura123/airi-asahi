import type { MeetingMediaPcmChunk } from '@proj-airi/stage-shared/meeting-media'

import { MeetingPcmNormalizer } from '@proj-airi/stage-ui/services/meeting-speech'

import meetingPcmSourceWorkletUrl from '../workers/meeting-pcm-source.worklet?worker&url'

interface MeetingPcmSourceFailure {
  type: 'failure'
  message: string
}

/** Renderer-owned 16 kHz mono stream fed by application-filtered native PCM. */
export interface MeetingPcmMediaStream {
  readonly stream: MediaStream
  push: (chunk: MeetingMediaPcmChunk) => void
  dispose: () => Promise<void>
}

/**
 * Creates the browser MediaStream consumed by the existing VAD and ASR pipeline.
 * Native chunk continuity remains authoritative; queue overflow and processor failure are fatal.
 */
export async function createMeetingPcmMediaStream(options: {
  /** Session correlation key shared by the native helper, Eventa, and renderer host. */
  sessionId: string
  /** Receives asynchronous AudioWorklet failures that invalidate the remote-audio route. */
  onFailure: (error: Error) => void
}): Promise<MeetingPcmMediaStream> {
  const normalizer = new MeetingPcmNormalizer({
    sessionId: options.sessionId,
    maxFramesPerPush: 64,
  })
  const audioContext = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: 16000,
  })
  let disposed = false

  try {
    if (audioContext.sampleRate !== 16000)
      throw new Error(`Meeting PCM AudioContext requires 16000 Hz, received ${audioContext.sampleRate} Hz.`)

    await audioContext.audioWorklet.addModule(meetingPcmSourceWorkletUrl)
    const source = new AudioWorkletNode(audioContext, 'meeting-pcm-source', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    const destination = audioContext.createMediaStreamDestination()
    source.connect(destination)

    const reportProcessorFailure = (error: Error) => {
      if (!disposed)
        options.onFailure(error)
    }
    source.addEventListener('processorerror', () => {
      reportProcessorFailure(new Error('The meeting PCM AudioWorklet processor stopped unexpectedly.'))
    })
    source.port.onmessage = (event: MessageEvent<MeetingPcmSourceFailure>) => {
      if (event.data.type === 'failure')
        reportProcessorFailure(new Error(event.data.message))
    }
    await audioContext.resume()

    return {
      stream: destination.stream,
      push(chunk) {
        if (disposed)
          throw new Error('Meeting PCM media stream is disposed.')

        for (const frame of normalizer.push(chunk)) {
          source.port.postMessage(
            { type: 'push', samples: frame.samples },
            [frame.samples.buffer],
          )
        }
      },
      async dispose() {
        if (disposed)
          return
        disposed = true
        normalizer.dispose()
        source.port.onmessage = null
        source.disconnect()
        destination.stream.getTracks().forEach(track => track.stop())
        await audioContext.close()
      },
    }
  }
  catch (error) {
    normalizer.dispose()
    await audioContext.close().catch(() => undefined)
    throw error
  }
}
