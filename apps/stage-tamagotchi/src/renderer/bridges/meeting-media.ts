import type { MeetingMediaControl } from '@proj-airi/stage-ui/stores/modules/meeting-media'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  electronMeetingMediaGetRuntime,
  electronMeetingMediaPreflight,
  electronMeetingMediaRuntimeChanged,
  electronMeetingMediaStart,
  electronMeetingMediaStop,
} from '../../shared/eventa'

/** Maps the shared renderer control contract onto the current Electron window's Eventa context. */
export function createMeetingMediaEventaControl(): MeetingMediaControl {
  const context = getElectronEventaContext()
  const invokePreflight = defineInvoke(context, electronMeetingMediaPreflight)
  const invokeStart = defineInvoke(context, electronMeetingMediaStart)
  const invokeStop = defineInvoke(context, electronMeetingMediaStop)
  const invokeGetRuntime = defineInvoke(context, electronMeetingMediaGetRuntime)

  return {
    preflight: profile => invokePreflight({ profile }),
    start: profile => invokeStart({ profile }),
    stop: sessionId => invokeStop({ sessionId }),
    getRuntime: () => invokeGetRuntime(),
    subscribeRuntime(listener) {
      return context.on(electronMeetingMediaRuntimeChanged, (event) => {
        if (event.body)
          listener(event.body)
      })
    },
  }
}
