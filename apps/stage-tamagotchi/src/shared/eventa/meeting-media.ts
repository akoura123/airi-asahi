import type {
  MeetingMediaCommandResult,
  MeetingMediaError,
  MeetingMediaPreflight,
  MeetingMediaProfile,
  MeetingMediaRendererMetricsUpdate,
  MeetingMediaRendererStartRequest,
  MeetingMediaRendererStartResult,
  MeetingMediaRendererStopRequest,
  MeetingMediaRuntime,
} from '@proj-airi/stage-shared/meeting-media'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/** Profile payload validated and frozen by Electron main before a preflight or start attempt. */
export interface ElectronMeetingMediaProfilePayload {
  profile: MeetingMediaProfile
}

/** Correlated stop request that cannot terminate a newer session accidentally. */
export interface ElectronMeetingMediaStopPayload {
  sessionId: string
}

export const electronMeetingMediaPreflight = defineInvokeEventa<MeetingMediaPreflight, ElectronMeetingMediaProfilePayload>('eventa:invoke:electron:meeting-media:preflight')
export const electronMeetingMediaStart = defineInvokeEventa<MeetingMediaCommandResult, ElectronMeetingMediaProfilePayload>('eventa:invoke:electron:meeting-media:start')
export const electronMeetingMediaStop = defineInvokeEventa<MeetingMediaCommandResult, ElectronMeetingMediaStopPayload>('eventa:invoke:electron:meeting-media:stop')
export const electronMeetingMediaGetRuntime = defineInvokeEventa<MeetingMediaRuntime>('eventa:invoke:electron:meeting-media:get-runtime')
export const electronMeetingMediaRuntimeChanged = defineEventa<MeetingMediaRuntime>('eventa:event:electron:meeting-media:runtime-changed')
export const electronMeetingMediaRendererStart = defineInvokeEventa<MeetingMediaRendererStartResult, MeetingMediaRendererStartRequest>('eventa:invoke:electron:meeting-media:renderer:start')
export const electronMeetingMediaRendererStop = defineInvokeEventa<void, MeetingMediaRendererStopRequest>('eventa:invoke:electron:meeting-media:renderer:stop')
export const electronMeetingMediaRendererRouteFailed = defineEventa<MeetingMediaError>('eventa:event:electron:meeting-media:renderer:route-failed')
export const electronMeetingMediaRendererMetrics = defineEventa<MeetingMediaRendererMetricsUpdate>('eventa:event:electron:meeting-media:renderer:metrics')
