import { matchesMeetingMediaDeviceName } from '@proj-airi/stage-shared/meeting-media'

/** Active compatibility output selected for one meeting session. */
export interface MeetingAgentAudioOutputOptions {
  sessionId: string
  outputDeviceId: string
  outputDeviceName: string
  localMonitor: boolean
  onFailure: (error: Error) => void
}

interface MeetingAgentAudioOutputRuntime extends MeetingAgentAudioOutputOptions {
  sink: {
    context: AudioContext
    destination: MediaStreamAudioDestinationNode
    element: HTMLAudioElement
  } | null
}

export interface MeetingAgentAudioRouteResult {
  routed: boolean
  localMonitor: boolean
}

let activeOutput: MeetingAgentAudioOutputRuntime | null = null

function disposeSink(runtime: MeetingAgentAudioOutputRuntime): void {
  if (!runtime.sink)
    return

  runtime.sink.element.pause()
  runtime.sink.element.srcObject = null
  runtime.sink.destination.disconnect()
  runtime.sink = null
}

/**
 * Reserves one exact browser audio output for AIRI speech sent to the meeting client.
 * The sink is created lazily in the Stage AudioContext so TTS is decoded only once.
 */
export async function startMeetingAgentAudioOutput(options: MeetingAgentAudioOutputOptions): Promise<void> {
  if (activeOutput && activeOutput.sessionId !== options.sessionId)
    throw new Error(`Meeting agent audio output is already owned by session "${activeOutput.sessionId}".`)

  if (!('setSinkId' in HTMLMediaElement.prototype))
    throw new Error('The current Electron runtime cannot route a media element to a selected audio output.')

  const devices = await navigator.mediaDevices.enumerateDevices()
  const device = devices.find(item => item.kind === 'audiooutput' && item.deviceId === options.outputDeviceId)
  if (!device)
    throw new Error('The selected meeting audio output is no longer available.')
  if (options.outputDeviceName && device.label && !matchesMeetingMediaDeviceName(device.label, options.outputDeviceName))
    throw new Error('The selected meeting audio output ID now resolves to a different device.')

  if (activeOutput)
    disposeSink(activeOutput)

  activeOutput = {
    ...options,
    sink: null,
  }
}

/** Stops only the correlated meeting output and releases its media-element sink. */
export function stopMeetingAgentAudioOutput(sessionId: string): void {
  if (activeOutput?.sessionId !== sessionId)
    return

  disposeSink(activeOutput)
  activeOutput = null
}

async function ensureSink(runtime: MeetingAgentAudioOutputRuntime, context: AudioContext) {
  if (runtime.sink?.context === context)
    return runtime.sink

  disposeSink(runtime)
  const destination = context.createMediaStreamDestination()
  const element = new Audio()
  element.autoplay = true
  element.srcObject = destination.stream
  await element.setSinkId(runtime.outputDeviceId)

  runtime.sink = { context, destination, element }
  return runtime.sink
}

/**
 * Connects one decoded TTS source to the active compatibility output.
 * Callers use the returned `localMonitor` decision for the physical speaker branch.
 */
export async function routeMeetingAgentAudioSource(
  source: AudioBufferSourceNode,
  context: AudioContext,
): Promise<MeetingAgentAudioRouteResult> {
  const runtime = activeOutput
  if (!runtime)
    return { routed: false, localMonitor: true }

  try {
    const sink = await ensureSink(runtime, context)
    if (activeOutput?.sessionId !== runtime.sessionId)
      throw new Error('The meeting audio output session changed while preparing its sink.')

    source.connect(sink.destination)
    try {
      if (sink.element.paused)
        await sink.element.play()
    }
    catch (error) {
      source.disconnect(sink.destination)
      throw error
    }

    return { routed: true, localMonitor: runtime.localMonitor }
  }
  catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    runtime.onFailure(normalized)
    throw normalized
  }
}
