/** Main Stage voice-input lifecycle that must yield the shared ASR transport to a meeting session. */
export interface MeetingSpeechInputController {
  ownerId: string
  suspendForMeeting: () => Promise<void>
  resumeAfterMeeting: () => Promise<void>
}

let registeredController: MeetingSpeechInputController | null = null
let reservedSessionId: string | null = null

/** Registers the single ordinary voice-input lifecycle owned by the main Stage page. */
export function registerMeetingSpeechInputController(controller: MeetingSpeechInputController): () => void {
  if (registeredController && registeredController.ownerId !== controller.ownerId)
    throw new Error(`Meeting speech input controller is already owned by "${registeredController.ownerId}".`)

  registeredController = controller
  return () => {
    if (registeredController?.ownerId === controller.ownerId)
      registeredController = null
  }
}

/**
 * Reserves the shared ASR transport after the ordinary microphone consumers have stopped.
 * A second session cannot take ownership until the correlated session releases it.
 */
export async function reserveMeetingSpeechInput(sessionId: string): Promise<void> {
  if (reservedSessionId)
    throw new Error(`Meeting speech input is already owned by session "${reservedSessionId}".`)
  if (!registeredController)
    throw new Error('The main Stage voice-input lifecycle is unavailable.')

  const controller = registeredController
  reservedSessionId = sessionId
  try {
    await controller.suspendForMeeting()
  }
  catch (error) {
    reservedSessionId = null
    try {
      await controller.resumeAfterMeeting()
    }
    catch (resumeError) {
      throw new AggregateError(
        [error, resumeError],
        'Meeting speech input reservation failed and ordinary voice input could not be restored.',
      )
    }
    throw error
  }
}

/** Releases only the correlated session and restores ordinary microphone listening. */
export async function releaseMeetingSpeechInput(sessionId: string): Promise<void> {
  if (reservedSessionId !== sessionId)
    return

  reservedSessionId = null
  await registeredController?.resumeAfterMeeting()
}
