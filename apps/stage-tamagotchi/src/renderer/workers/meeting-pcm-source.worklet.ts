interface MeetingPcmSourceMessage {
  type: 'push'
  samples: Float32Array
}

interface MeetingPcmSourceFailure {
  type: 'failure'
  message: string
}

/** Supplies normalized meeting PCM to a MediaStream without using a system loopback track. */
class MeetingPcmSourceProcessor extends AudioWorkletProcessor {
  // Two seconds absorbs renderer scheduling jitter while keeping speech latency and memory bounded.
  private readonly maxQueuedSamples = 16000 * 2
  private readonly queue: Float32Array[] = []
  private queuedSamples = 0
  private firstChunkOffset = 0
  private failed = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<MeetingPcmSourceMessage>) => {
      const message = event.data
      if (this.failed || message.type !== 'push' || !(message.samples instanceof Float32Array))
        return

      if (message.samples.length === 0)
        return
      if (this.queuedSamples + message.samples.length > this.maxQueuedSamples) {
        this.fail('The meeting PCM renderer queue exceeded its two-second bound.')
        return
      }

      this.queue.push(message.samples)
      this.queuedSamples += message.samples.length
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0]
    if (!output)
      return true

    output.fill(0)
    let outputOffset = 0
    while (outputOffset < output.length && this.queue.length > 0) {
      const chunk = this.queue[0]
      const availableSamples = chunk.length - this.firstChunkOffset
      const copiedSamples = Math.min(availableSamples, output.length - outputOffset)
      output.set(
        chunk.subarray(this.firstChunkOffset, this.firstChunkOffset + copiedSamples),
        outputOffset,
      )
      outputOffset += copiedSamples
      this.firstChunkOffset += copiedSamples
      this.queuedSamples -= copiedSamples

      if (this.firstChunkOffset === chunk.length) {
        this.queue.shift()
        this.firstChunkOffset = 0
      }
    }
    return true
  }

  private fail(message: string): void {
    if (this.failed)
      return
    this.failed = true
    this.queue.length = 0
    this.queuedSamples = 0
    this.firstChunkOffset = 0
    this.port.postMessage({ type: 'failure', message } satisfies MeetingPcmSourceFailure)
  }
}

registerProcessor('meeting-pcm-source', MeetingPcmSourceProcessor)
