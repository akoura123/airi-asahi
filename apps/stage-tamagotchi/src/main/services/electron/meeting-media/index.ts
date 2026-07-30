import type {
  MeetingMediaCommandResult,
  MeetingMediaError,
  MeetingMediaPreflight,
  MeetingMediaProfile,
  MeetingMediaRendererMetricsUpdate,
  MeetingMediaRoute,
  MeetingMediaRouteRuntime,
  MeetingMediaRuntime,
} from '@proj-airi/stage-shared/meeting-media'
import type { BrowserWindow, Rectangle } from 'electron'

import type { MeetingMediaPlatformProbe } from './platform'

import { randomUUID } from 'node:crypto'

import { useLogg } from '@guiiai/logg'
import { defineInvoke, defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { errorMessageFrom } from '@moeru/std'
import {
  createInitialMeetingMediaMetrics,
  createInitialMeetingMediaRuntime,
  MEETING_MEDIA_COMPATIBILITY_NAMES,
  MEETING_MEDIA_ROUTES,
  parseMeetingMediaProfile,
  resolveRequiredMeetingMediaRoutes,
} from '@proj-airi/stage-shared/meeting-media'
import { Mutex } from 'async-mutex'
import { ipcMain } from 'electron'

import {
  electronMeetingMediaGetRuntime,
  electronMeetingMediaPreflight,
  electronMeetingMediaRendererMetrics,
  electronMeetingMediaRendererRouteFailed,
  electronMeetingMediaRendererStart,
  electronMeetingMediaRendererStop,
  electronMeetingMediaRuntimeChanged,
  electronMeetingMediaStart,
  electronMeetingMediaStop,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

type EventaContext = ReturnType<typeof createContext>['context']

/** Electron-window registration needed for invoke handlers and runtime broadcasts. */
export interface MeetingMediaWindowRegistration {
  context: EventaContext
  window: BrowserWindow
  /** The main Stage renderer that owns compatibility media processing. */
  mediaHost?: boolean
}

/**
 * Electron-main owner of meeting media state and native lifecycle.
 *
 * Call stack:
 *
 * Renderer Eventa invoke
 *   -> {@link MeetingMediaService.start}
 *     -> platform preflight
 *       -> native session allocation (added by the platform implementation stage)
 */
export interface MeetingMediaService {
  registerWindow: (registration: MeetingMediaWindowRegistration) => void
  preflight: (profile: MeetingMediaProfile) => Promise<MeetingMediaPreflight>
  start: (profile: MeetingMediaProfile) => Promise<MeetingMediaCommandResult>
  stop: (sessionId: string) => Promise<MeetingMediaCommandResult>
  getRuntime: () => MeetingMediaRuntime
  dispose: () => Promise<void>
}

function cloneRuntime(runtime: MeetingMediaRuntime): MeetingMediaRuntime {
  return structuredClone(runtime)
}

function createSessionError(params: {
  code: string
  category: MeetingMediaError['category']
  phase: MeetingMediaError['phase']
  message: string
  sessionId?: string
  route?: MeetingMediaRoute
  action?: MeetingMediaError['action']
  cause?: string
}): MeetingMediaError {
  return {
    code: params.code,
    category: params.category,
    phase: params.phase,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.route ? { route: params.route } : {}),
    occurredAtMs: Date.now(),
    message: params.message,
    ...(params.action ? { action: params.action } : {}),
    ...(params.cause ? { cause: params.cause } : {}),
  }
}

function createRouteRuntime(
  route: MeetingMediaRoute,
  requiredRoutes: Set<MeetingMediaRoute>,
  state: MeetingMediaRouteRuntime['state'],
): MeetingMediaRouteRuntime {
  const required = requiredRoutes.has(route)
  return {
    route,
    required,
    state: required ? state : 'idle',
    lastError: null,
  }
}

function createStartingRuntime(profile: MeetingMediaProfile, sessionId: string, nowMs: number): MeetingMediaRuntime {
  const requiredRoutes = new Set(resolveRequiredMeetingMediaRoutes(profile))
  return {
    sessionId,
    state: 'starting',
    activeProfile: structuredClone(profile),
    startedAtMs: nowMs,
    endedAtMs: null,
    updatedAtMs: nowMs,
    routes: Object.fromEntries(
      MEETING_MEDIA_ROUTES.map(route => [route, createRouteRuntime(route, requiredRoutes, 'starting')]),
    ) as Record<MeetingMediaRoute, MeetingMediaRouteRuntime>,
    devices: [],
    metrics: createInitialMeetingMediaMetrics(),
    preflight: null,
    lastError: null,
  }
}

function runtimeWithStartFailure(
  current: MeetingMediaRuntime,
  preflight: MeetingMediaPreflight | null,
  error: MeetingMediaError,
): MeetingMediaRuntime {
  const routes = Object.fromEntries(MEETING_MEDIA_ROUTES.map((route) => {
    const routeRuntime = current.routes[route]
    if (!routeRuntime.required)
      return [route, routeRuntime]

    const routeError = preflight?.routes[route].issues[0] ?? error
    const routeFailed = !routeError.route || routeError.route === route
    return [route, {
      ...routeRuntime,
      state: routeFailed ? 'error' : 'idle',
      lastError: routeFailed ? routeError : null,
    } satisfies MeetingMediaRouteRuntime]
  })) as Record<MeetingMediaRoute, MeetingMediaRouteRuntime>

  const nowMs = Date.now()
  return {
    ...current,
    state: 'error',
    endedAtMs: nowMs,
    updatedAtMs: nowMs,
    routes,
    preflight,
    lastError: error,
  }
}

interface MeetingOutputWindowSnapshot {
  bounds: Rectangle
  title: string
  alwaysOnTop: boolean
  visible: boolean
}

function mergeDevices(...groups: MeetingMediaRuntime['devices'][]): MeetingMediaRuntime['devices'] {
  const devices = new Map<string, MeetingMediaRuntime['devices'][number]>()
  for (const device of groups.flat())
    devices.set(`${device.kind}:${device.id}`, device)
  return Array.from(devices.values())
}

/** Creates and registers the single process-wide meeting-media service. */
export function setupMeetingMediaService(options: {
  /** Authoritative operating-system capability probe supplied by the Electron composition root. */
  platformProbe: MeetingMediaPlatformProbe
}): MeetingMediaService {
  const log = useLogg('meeting-media').useGlobalConfig()
  const transitionMutex = new Mutex()
  const contexts = new Set<EventaContext>()
  const cleanupByContext = new Map<EventaContext, Array<() => void>>()
  // Meeting-media commands own process-wide state. Eventa's Electron adapter attaches one
  // inbound ipcMain listener per context, so registering these handlers on every window
  // would execute a single renderer command once for each open AIRI window.
  const { context: commandContext, dispose: disposeCommandContext } = createContext(ipcMain)
  const commandCleanups = [
    defineInvokeHandler(commandContext, electronMeetingMediaGetRuntime, () => getRuntime()),
    defineInvokeHandler(commandContext, electronMeetingMediaPreflight, payload => preflight(parseMeetingMediaProfile(payload.profile))),
    defineInvokeHandler(commandContext, electronMeetingMediaStart, payload => start(payload.profile)),
    defineInvokeHandler(commandContext, electronMeetingMediaStop, payload => stop(payload.sessionId)),
  ]
  let runtime = createInitialMeetingMediaRuntime()
  let disposed = false
  let mediaHostRegistration: MeetingMediaWindowRegistration | undefined
  let meetingOutputWindowSnapshot: MeetingOutputWindowSnapshot | undefined

  function getRuntime(): MeetingMediaRuntime {
    return cloneRuntime(runtime)
  }

  function publishRuntime(): void {
    const snapshot = getRuntime()
    for (const context of contexts) {
      try {
        context.emit(electronMeetingMediaRuntimeChanged, snapshot)
      }
      catch (error) {
        log.withError(error).warn('Failed to publish meeting media runtime state')
      }
    }
  }

  function updateRuntime(next: MeetingMediaRuntime): void {
    runtime = next
    log.withFields({ sessionId: runtime.sessionId, state: runtime.state }).log('Meeting media runtime changed')
    publishRuntime()
  }

  function prepareMeetingOutputWindow(profile: MeetingMediaProfile): void {
    if (!profile.video.enabled)
      return
    const window = mediaHostRegistration?.window
    if (!window || window.isDestroyed())
      throw new Error('The main Stage window is unavailable.')
    if (!meetingOutputWindowSnapshot) {
      meetingOutputWindowSnapshot = {
        bounds: window.getBounds(),
        title: window.getTitle(),
        alwaysOnTop: window.isAlwaysOnTop(),
        visible: window.isVisible(),
      }
    }

    // OBS captures this exact frameless content surface; window chrome and AIRI controls are
    // hidden by the renderer while the same Stage instance continues rendering underneath.
    window.setAlwaysOnTop(false)
    window.setTitle(MEETING_MEDIA_COMPATIBILITY_NAMES.outputWindow)
    window.setContentSize(profile.video.width, profile.video.height, false)
    window.center()
    window.show()
  }

  function restoreMeetingOutputWindow(): void {
    const snapshot = meetingOutputWindowSnapshot
    meetingOutputWindowSnapshot = undefined
    const window = mediaHostRegistration?.window
    if (!snapshot || !window || window.isDestroyed())
      return

    window.setTitle(snapshot.title)
    window.setBounds(snapshot.bounds, false)
    window.setAlwaysOnTop(snapshot.alwaysOnTop)
    if (!snapshot.visible)
      window.hide()
  }

  async function stopRendererSession(sessionId: string): Promise<void> {
    const host = mediaHostRegistration
    if (!host || host.window.isDestroyed())
      return
    await defineInvoke(host.context, electronMeetingMediaRendererStop)({ sessionId })
  }

  async function preflight(profile: MeetingMediaProfile): Promise<MeetingMediaPreflight> {
    const validatedProfile = parseMeetingMediaProfile(profile)
    return await options.platformProbe.preflight(validatedProfile)
  }

  async function start(profile: MeetingMediaProfile): Promise<MeetingMediaCommandResult> {
    return await transitionMutex.runExclusive(async () => {
      if (disposed) {
        const error = createSessionError({
          code: 'MEETING_MEDIA_SERVICE_DISPOSED',
          category: 'PROCESSING',
          phase: 'start',
          message: 'The meeting media service has already been disposed.',
        })
        return { accepted: false, runtime: getRuntime(), error }
      }

      if (runtime.state === 'starting' || runtime.state === 'running' || runtime.state === 'stopping') {
        const error = createSessionError({
          code: 'MEETING_MEDIA_SESSION_ALREADY_ACTIVE',
          category: 'PROCESSING',
          phase: 'start',
          message: 'Another meeting media session is already active.',
          ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
        })
        return { accepted: false, runtime: getRuntime(), error }
      }

      let validatedProfile: MeetingMediaProfile
      try {
        validatedProfile = parseMeetingMediaProfile(profile)
      }
      catch (error) {
        const commandError = createSessionError({
          code: 'MEETING_MEDIA_PROFILE_INVALID',
          category: 'PROCESSING',
          phase: 'start',
          message: 'The meeting media profile is invalid.',
          cause: errorMessageFrom(error) ?? 'Profile validation failed.',
        })
        return { accepted: false, runtime: getRuntime(), error: commandError }
      }

      const sessionId = randomUUID()
      updateRuntime(createStartingRuntime(validatedProfile, sessionId, Date.now()))

      let result: MeetingMediaPreflight
      try {
        result = await options.platformProbe.preflight(validatedProfile, sessionId)
      }
      catch (error) {
        const startError = createSessionError({
          code: 'MEETING_MEDIA_PREFLIGHT_FAILED',
          category: 'INSTALLATION',
          phase: 'preflight',
          sessionId,
          message: 'Meeting media preflight could not be completed.',
          action: 'retry',
          cause: errorMessageFrom(error) ?? 'Unknown platform preflight failure.',
        })
        updateRuntime(runtimeWithStartFailure(runtime, null, startError))
        return { accepted: true, runtime: getRuntime(), error: startError }
      }

      if (!result.ready) {
        const firstError = MEETING_MEDIA_ROUTES
          .filter(route => result.routes[route].required)
          .flatMap(route => result.routes[route].issues)[0]
          ?? createSessionError({
            code: 'MEETING_MEDIA_ROUTE_NOT_READY',
            category: 'INSTALLATION',
            phase: 'preflight',
            sessionId,
            message: 'At least one required meeting media route is not ready.',
            action: 'retry',
          })

        updateRuntime(runtimeWithStartFailure(runtime, result, firstError))
        return { accepted: true, runtime: getRuntime(), error: firstError }
      }

      if (validatedProfile.backend === 'compatibility') {
        const host = mediaHostRegistration
        if (!host || host.window.isDestroyed()) {
          const hostError = createSessionError({
            code: 'MEETING_MEDIA_RENDERER_HOST_UNAVAILABLE',
            category: 'PROCESSING',
            phase: 'start',
            sessionId,
            message: 'The main Stage renderer is unavailable for compatibility media processing.',
            action: 'retry',
          })
          updateRuntime(runtimeWithStartFailure(runtime, result, hostError))
          return { accepted: true, runtime: getRuntime(), error: hostError }
        }

        try {
          prepareMeetingOutputWindow(validatedProfile)
          const rendererResult = await defineInvoke(host.context, electronMeetingMediaRendererStart)({
            sessionId,
            profile: validatedProfile,
          })
          if (!rendererResult.ready) {
            restoreMeetingOutputWindow()
            updateRuntime(runtimeWithStartFailure(runtime, result, rendererResult.error))
            return { accepted: true, runtime: getRuntime(), error: rendererResult.error }
          }

          const runningAtMs = Date.now()
          updateRuntime({
            ...runtime,
            state: 'running',
            updatedAtMs: runningAtMs,
            routes: Object.fromEntries(MEETING_MEDIA_ROUTES.map((route) => {
              const routeRuntime = runtime.routes[route]
              return [route, {
                ...routeRuntime,
                state: routeRuntime.required ? 'running' : 'idle',
                lastError: null,
              } satisfies MeetingMediaRouteRuntime]
            })) as Record<MeetingMediaRoute, MeetingMediaRouteRuntime>,
            devices: mergeDevices(
              MEETING_MEDIA_ROUTES.flatMap(route => result.routes[route].devices),
              rendererResult.devices,
            ),
            metrics: {
              ...runtime.metrics,
              agentAudio: {
                ...runtime.metrics.agentAudio,
                localMonitorActive: validatedProfile.agentAudio.enabled && validatedProfile.agentAudio.localMonitor,
              },
            },
            preflight: result,
            lastError: null,
          })
          return { accepted: true, runtime: getRuntime(), error: null }
        }
        catch (error) {
          await stopRendererSession(sessionId).catch(() => {})
          restoreMeetingOutputWindow()
          const rendererError = createSessionError({
            code: 'MEETING_MEDIA_RENDERER_HOST_START_FAILED',
            category: 'PROCESSING',
            phase: 'start',
            sessionId,
            message: 'The compatibility media renderer could not be started.',
            action: 'retry',
            cause: errorMessageFrom(error) ?? 'Unknown renderer host failure.',
          })
          updateRuntime(runtimeWithStartFailure(runtime, result, rendererError))
          return { accepted: true, runtime: getRuntime(), error: rendererError }
        }
      }

      // TODO: The platform implementation stage replaces this boundary with atomic native
      // route allocation. Preflight cannot mark routes ready until that host is present.
      const nativeHostError = createSessionError({
        code: 'MEETING_MEDIA_NATIVE_HOST_UNAVAILABLE',
        category: 'INSTALLATION',
        phase: 'start',
        sessionId,
        message: 'The native meeting media session host is not available in this build.',
        action: 'install-native-component',
      })
      updateRuntime(runtimeWithStartFailure(runtime, result, nativeHostError))
      return { accepted: true, runtime: getRuntime(), error: nativeHostError }
    })
  }

  async function stop(sessionId: string): Promise<MeetingMediaCommandResult> {
    return await transitionMutex.runExclusive(async () => {
      if (runtime.state === 'idle')
        return { accepted: true, runtime: getRuntime(), error: null }

      if (runtime.sessionId !== sessionId) {
        const error = createSessionError({
          code: 'MEETING_MEDIA_SESSION_STALE',
          category: 'PROCESSING',
          phase: 'stop',
          message: 'The stop request belongs to a stale meeting media session.',
          sessionId,
        })
        return { accepted: false, runtime: getRuntime(), error }
      }

      const stoppingAtMs = Date.now()
      updateRuntime({
        ...runtime,
        state: 'stopping',
        updatedAtMs: stoppingAtMs,
        routes: Object.fromEntries(MEETING_MEDIA_ROUTES.map((route) => {
          const routeRuntime = runtime.routes[route]
          return [route, {
            ...routeRuntime,
            state: routeRuntime.required ? 'stopping' : 'idle',
          } satisfies MeetingMediaRouteRuntime]
        })) as Record<MeetingMediaRoute, MeetingMediaRouteRuntime>,
      })

      let stopError: MeetingMediaError | null = null
      if (runtime.activeProfile?.backend === 'compatibility') {
        try {
          await stopRendererSession(sessionId)
        }
        catch (error) {
          stopError = createSessionError({
            code: 'MEETING_MEDIA_RENDERER_HOST_STOP_FAILED',
            category: 'PROCESSING',
            phase: 'stop',
            sessionId,
            message: 'The compatibility renderer reported an error while stopping.',
            cause: errorMessageFrom(error) ?? 'Unknown renderer cleanup failure.',
          })
          log.withError(error).warn('Failed to stop meeting media renderer host')
        }
        finally {
          restoreMeetingOutputWindow()
        }
      }

      const stoppedAtMs = Date.now()
      updateRuntime({
        ...createInitialMeetingMediaRuntime(stoppedAtMs),
        endedAtMs: stoppedAtMs,
      })
      return { accepted: true, runtime: getRuntime(), error: stopError }
    })
  }

  function unregisterContext(context: EventaContext): void {
    for (const cleanup of cleanupByContext.get(context) ?? [])
      cleanup()
    cleanupByContext.delete(context)
    contexts.delete(context)
    if (mediaHostRegistration?.context === context)
      mediaHostRegistration = undefined
  }

  function handleRendererRouteFailure(error: MeetingMediaError): void {
    void transitionMutex.runExclusive(async () => {
      if (runtime.sessionId !== error.sessionId || runtime.state !== 'running')
        return

      const sessionId = runtime.sessionId
      const stoppingAtMs = Date.now()
      updateRuntime({
        ...runtime,
        state: 'stopping',
        updatedAtMs: stoppingAtMs,
        lastError: error,
        routes: Object.fromEntries(MEETING_MEDIA_ROUTES.map((route) => {
          const routeRuntime = runtime.routes[route]
          return [route, {
            ...routeRuntime,
            state: routeRuntime.required ? 'stopping' : 'idle',
            lastError: route === error.route ? error : routeRuntime.lastError,
          } satisfies MeetingMediaRouteRuntime]
        })) as Record<MeetingMediaRoute, MeetingMediaRouteRuntime>,
      })

      await stopRendererSession(sessionId).catch(stopError => log.withError(stopError).warn('Failed to clean up renderer after route failure'))
      restoreMeetingOutputWindow()
      const failedAtMs = Date.now()
      updateRuntime({
        ...runtime,
        state: 'error',
        endedAtMs: failedAtMs,
        updatedAtMs: failedAtMs,
        routes: Object.fromEntries(MEETING_MEDIA_ROUTES.map((route) => {
          const routeRuntime = runtime.routes[route]
          return [route, {
            ...routeRuntime,
            state: route === error.route ? 'error' : 'idle',
            lastError: route === error.route ? error : null,
          } satisfies MeetingMediaRouteRuntime]
        })) as Record<MeetingMediaRoute, MeetingMediaRouteRuntime>,
        lastError: error,
      })
    })
  }

  function handleRendererMetrics(update: MeetingMediaRendererMetricsUpdate): void {
    if (runtime.sessionId !== update.sessionId || runtime.state !== 'running')
      return

    runtime = {
      ...runtime,
      updatedAtMs: Math.max(runtime.updatedAtMs, update.measuredAtMs),
      metrics: structuredClone(update.metrics),
    }
    publishRuntime()
  }

  function registerWindow(registration: MeetingMediaWindowRegistration): void {
    const { context, window } = registration
    if (cleanupByContext.has(context))
      return

    if (registration.mediaHost) {
      if (mediaHostRegistration && mediaHostRegistration.context !== context)
        throw new Error('Meeting media renderer host is already registered by another window.')
      mediaHostRegistration = registration
    }

    contexts.add(context)
    const cleanups = [
      context.on(electronMeetingMediaRendererRouteFailed, (event) => {
        if (registration.mediaHost && event.body)
          handleRendererRouteFailure(event.body)
      }),
      context.on(electronMeetingMediaRendererMetrics, (event) => {
        if (registration.mediaHost && event.body)
          handleRendererMetrics(event.body)
      }),
    ]
    cleanupByContext.set(context, cleanups)
    window.once('closed', () => unregisterContext(context))
  }

  async function dispose(): Promise<void> {
    if (disposed)
      return

    if (runtime.sessionId)
      await stop(runtime.sessionId)

    disposed = true
    for (const context of Array.from(contexts))
      unregisterContext(context)
    for (const cleanup of commandCleanups)
      cleanup()
    disposeCommandContext()
  }

  const service: MeetingMediaService = {
    registerWindow,
    preflight,
    start,
    stop,
    getRuntime,
    dispose,
  }

  onAppBeforeQuit(() => service.dispose())
  return service
}
