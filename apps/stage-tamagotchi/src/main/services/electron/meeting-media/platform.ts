import type {
  MeetingMediaComponentState,
  MeetingMediaDevice,
  MeetingMediaError,
  MeetingMediaPlatform,
  MeetingMediaPreflight,
  MeetingMediaProfile,
  MeetingMediaRoute,
  MeetingMediaRoutePreflight,
} from '@proj-airi/stage-shared/meeting-media'

import process from 'node:process'

import { access, readFile } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { join, parse } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { MEETING_MEDIA_COMPATIBILITY_NAMES, MEETING_MEDIA_PROTOCOL_VERSION, MEETING_MEDIA_ROUTES, resolveRequiredMeetingMediaRoutes } from '@proj-airi/stage-shared/meeting-media'
import { app, desktopCapturer, systemPreferences } from 'electron'
import { array, literal, nonEmpty, picklist, pipe, safeParse, strictObject, string, trim } from 'valibot'

type NativeComponentKind = 'virtual-camera' | 'meeting-audio'

interface NativeComponentManifest {
  protocolVersion: typeof MEETING_MEDIA_PROTOCOL_VERSION
  platform: MeetingMediaPlatform
  components: Array<{
    kind: NativeComponentKind
    backend: string
    version: string
  }>
}

type NativeComponentManifestResult
  = | { state: 'missing' }
    | { state: 'invalid', cause: string }
    | { state: 'valid', manifest: NativeComponentManifest }

const NativeComponentManifestSchema = strictObject({
  protocolVersion: literal(MEETING_MEDIA_PROTOCOL_VERSION),
  platform: picklist(['darwin', 'win32', 'linux']),
  components: array(strictObject({
    kind: picklist(['virtual-camera', 'meeting-audio']),
    backend: pipe(string(), trim(), nonEmpty()),
    version: pipe(string(), trim(), nonEmpty()),
  })),
})

/** Read-only platform boundary used before native media resources are allocated. */
export interface MeetingMediaPlatformProbe {
  preflight: (profile: MeetingMediaProfile, sessionId?: string) => Promise<MeetingMediaPreflight>
}

function resolvePlatform(): MeetingMediaPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux')
    return process.platform

  throw new Error(`Meeting media is unsupported on platform "${process.platform}".`)
}

function resolveSystemVersion(): string {
  return typeof process.getSystemVersion === 'function'
    ? process.getSystemVersion()
    : release()
}

function versionParts(systemVersion: string): number[] {
  return systemVersion.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
}

function isPlatformVersionSupported(platform: MeetingMediaPlatform, systemVersion: string): boolean {
  const [major = 0, minor = 0, build = 0] = versionParts(systemVersion)

  if (platform === 'darwin')
    return major > 12 || (major === 12 && minor >= 3)

  if (platform === 'win32')
    return major > 10 || (major === 10 && build >= 22000)

  return true
}

function resolveManifestPath(platform: MeetingMediaPlatform): string {
  const componentRoot = app.isPackaged
    ? join(process.resourcesPath, 'meeting-media')
    : join(app.getAppPath(), 'native', 'meeting-media')

  return join(componentRoot, `${platform}.json`)
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function loadNativeComponentManifest(platform: MeetingMediaPlatform): Promise<NativeComponentManifestResult> {
  try {
    const text = await readFile(resolveManifestPath(platform), 'utf8')
    const result = safeParse(NativeComponentManifestSchema, JSON.parse(text))
    if (!result.success || result.output.platform !== platform) {
      return { state: 'invalid', cause: 'Native component manifest does not match the current protocol or platform.' }
    }

    return { state: 'valid', manifest: result.output }
  }
  catch (error) {
    if (isFileNotFoundError(error))
      return { state: 'missing' }

    return { state: 'invalid', cause: errorMessageFrom(error) ?? 'Unable to read native component manifest.' }
  }
}

function requiredComponent(route: MeetingMediaRoute): NativeComponentKind {
  return route === 'video-out' ? 'virtual-camera' : 'meeting-audio'
}

function createPreflightError(params: {
  code: string
  category: MeetingMediaError['category']
  route: MeetingMediaRoute
  sessionId?: string
  message: string
  action: MeetingMediaError['action']
  cause?: string
}): MeetingMediaError {
  return {
    code: params.code,
    category: params.category,
    route: params.route,
    phase: 'preflight',
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    occurredAtMs: Date.now(),
    message: params.message,
    action: params.action,
    ...(params.cause ? { cause: params.cause } : {}),
  }
}

function componentStateForRoute(
  manifestResult: NativeComponentManifestResult,
  route: MeetingMediaRoute,
): MeetingMediaComponentState {
  if (manifestResult.state === 'missing')
    return 'not-bundled'
  if (manifestResult.state === 'invalid')
    return 'unverified'

  return manifestResult.manifest.components.some(component => component.kind === requiredComponent(route))
    ? 'unverified'
    : 'not-bundled'
}

function inspectRequiredRoute(params: {
  route: MeetingMediaRoute
  profile: MeetingMediaProfile
  platformSupported: boolean
  manifestResult: NativeComponentManifestResult
  sessionId?: string
}): MeetingMediaRoutePreflight {
  const component = componentStateForRoute(params.manifestResult, params.route)
  const issues: MeetingMediaError[] = []

  if (params.route === 'remote-audio-in') {
    if (params.profile.receiveAudio.monitorDeviceId.trim().length === 0) {
      issues.push(createPreflightError({
        code: 'MEETING_MEDIA_MONITOR_DEVICE_REQUIRED',
        category: 'DEVICE',
        route: params.route,
        sessionId: params.sessionId,
        message: 'A physical meeting-audio monitor device must be selected explicitly.',
        action: 'select-device',
      }))
    }

    if (params.profile.speech.providerId.trim().length === 0
      || params.profile.speech.model.trim().length === 0
      || params.profile.speech.locale.trim().length === 0) {
      issues.push(createPreflightError({
        code: 'MEETING_MEDIA_SPEECH_CONFIG_REQUIRED',
        category: 'PROVIDER',
        route: params.route,
        sessionId: params.sessionId,
        message: 'ASR provider, model, and locale must be configured for meeting audio.',
        action: 'configure-speech-recognition',
      }))
    }
  }

  if (!params.platformSupported) {
    issues.push(createPreflightError({
      code: 'PLATFORM_VERSION_UNSUPPORTED',
      category: 'INSTALLATION',
      route: params.route,
      sessionId: params.sessionId,
      message: 'The current operating-system version cannot host this meeting media route.',
      action: 'update-os',
    }))
  }
  else if (params.manifestResult.state === 'missing') {
    issues.push(createPreflightError({
      code: 'NATIVE_COMPONENT_NOT_BUNDLED',
      category: 'INSTALLATION',
      route: params.route,
      sessionId: params.sessionId,
      message: 'The required native meeting media component is not bundled with this AIRI build.',
      action: 'install-native-component',
    }))
  }
  else if (params.manifestResult.state === 'invalid') {
    issues.push(createPreflightError({
      code: 'NATIVE_COMPONENT_MANIFEST_INVALID',
      category: 'INSTALLATION',
      route: params.route,
      sessionId: params.sessionId,
      message: 'The native meeting media component manifest is invalid.',
      action: 'install-native-component',
      cause: params.manifestResult.cause,
    }))
  }
  else if (component === 'not-bundled') {
    issues.push(createPreflightError({
      code: 'NATIVE_COMPONENT_NOT_BUNDLED',
      category: 'INSTALLATION',
      route: params.route,
      sessionId: params.sessionId,
      message: 'The native component manifest does not include the required route.',
      action: 'install-native-component',
    }))
  }
  else {
    // TODO: Replace manifest presence with the platform adapter's signed installation and device probe.
    issues.push(createPreflightError({
      code: 'NATIVE_COMPONENT_INSTALLATION_UNVERIFIED',
      category: 'INSTALLATION',
      route: params.route,
      sessionId: params.sessionId,
      message: 'The native component is bundled but its installed device is not verified yet.',
      action: 'retry',
    }))
  }

  return {
    route: params.route,
    required: true,
    ready: issues.length === 0,
    support: params.platformSupported ? 'supported' : 'unsupported',
    component,
    // Virtual camera and virtual audio publication do not consume microphone input.
    // System-extension approval is verified by the native installation adapter instead.
    permission: 'not-required',
    devices: [],
    issues,
  }
}

function createOptionalRoutePreflight(route: MeetingMediaRoute): MeetingMediaRoutePreflight {
  return {
    route,
    required: false,
    ready: true,
    support: 'supported',
    component: 'not-required',
    permission: 'not-required',
    devices: [],
    issues: [],
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

async function detectMacOSCompatibilityComponents() {
  const systemRoot = parse(homedir()).root
  const obsPaths = [
    join(systemRoot, 'Applications', 'OBS.app'),
    join(homedir(), 'Applications', 'OBS.app'),
  ]
  const blackHoleDriverPath = join(
    systemRoot,
    'Library',
    'Audio',
    'Plug-Ins',
    'HAL',
    'BlackHole2ch.driver',
  )

  const [obsResults, blackHoleInstalled] = await Promise.all([
    Promise.all(obsPaths.map(pathExists)),
    pathExists(blackHoleDriverPath),
  ])

  return {
    obsInstalled: obsResults.some(Boolean),
    blackHoleInstalled,
  }
}

function screenCapturePermission(): MeetingMediaRoutePreflight['permission'] {
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted' || status === 'denied' || status === 'not-determined' || status === 'restricted')
    return status
  return 'unavailable'
}

async function inspectCompatibilityRoutes(params: {
  profile: MeetingMediaProfile
  platform: MeetingMediaPlatform
  systemVersion: string
  sessionId?: string
}): Promise<Record<MeetingMediaRoute, MeetingMediaRoutePreflight>> {
  const requiredRoutes = new Set(resolveRequiredMeetingMediaRoutes(params.profile))
  const [systemMajor = 0] = versionParts(params.systemVersion)
  const platformSupported = params.platform === 'darwin' && systemMajor >= 13
  const components = params.platform === 'darwin'
    ? await detectMacOSCompatibilityComponents()
    : { obsInstalled: false, blackHoleInstalled: false }
  const permission = params.platform === 'darwin' ? screenCapturePermission() : 'unavailable'

  let captureSources: Awaited<ReturnType<typeof desktopCapturer.getSources>> = []
  if (platformSupported && requiredRoutes.has('remote-audio-in')) {
    try {
      captureSources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      })
    }
    catch {
      captureSources = []
    }
  }

  function unsupportedIssue(route: MeetingMediaRoute): MeetingMediaError | null {
    if (platformSupported)
      return null
    return createPreflightError({
      code: 'MEETING_MEDIA_COMPATIBILITY_PLATFORM_UNSUPPORTED',
      category: 'INSTALLATION',
      route,
      sessionId: params.sessionId,
      message: 'The compatibility backend currently requires macOS 13 or later.',
      action: 'update-os',
    })
  }

  const routes = Object.fromEntries(MEETING_MEDIA_ROUTES.map((route) => {
    if (!requiredRoutes.has(route))
      return [route, createOptionalRoutePreflight(route)]

    const issues: MeetingMediaError[] = []
    const devices: MeetingMediaDevice[] = []
    const unsupported = unsupportedIssue(route)
    if (unsupported)
      issues.push(unsupported)

    let component: MeetingMediaComponentState = 'ready'
    let routePermission: MeetingMediaRoutePreflight['permission'] = 'not-required'

    if (route === 'video-out') {
      if (!components.obsInstalled) {
        component = 'not-installed'
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_OBS_NOT_INSTALLED',
          category: 'INSTALLATION',
          route,
          sessionId: params.sessionId,
          message: 'OBS Studio is required by the selected compatibility video backend.',
          action: 'install-native-component',
        }))
      }
      else {
        devices.push({
          id: 'obs-virtual-camera',
          name: MEETING_MEDIA_COMPATIBILITY_NAMES.camera,
          kind: 'camera',
          backend: 'obs-window-capture',
        })
      }
    }
    else if (route === 'remote-audio-in') {
      routePermission = permission
      if (permission !== 'granted') {
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_SCREEN_AUDIO_PERMISSION_REQUIRED',
          category: 'PERMISSION',
          route,
          sessionId: params.sessionId,
          message: 'Screen and system-audio recording permission is required to capture the selected meeting application.',
          action: 'open-media-permissions',
        }))
      }

      if (!params.profile.receiveAudio.captureSourceId.trim()) {
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_CAPTURE_SOURCE_REQUIRED',
          category: 'DEVICE',
          route,
          sessionId: params.sessionId,
          message: 'A meeting application window must be selected explicitly.',
          action: 'select-device',
        }))
      }
      else {
        const source = captureSources.find(item => item.id === params.profile.receiveAudio.captureSourceId)
        if (!source || (params.profile.receiveAudio.captureSourceName && source.name !== params.profile.receiveAudio.captureSourceName)) {
          issues.push(createPreflightError({
            code: 'MEETING_MEDIA_CAPTURE_SOURCE_UNAVAILABLE',
            category: 'DEVICE',
            route,
            sessionId: params.sessionId,
            message: 'The exact meeting application window selected in the profile is no longer available.',
            action: 'select-device',
          }))
        }
        else {
          devices.push({
            id: source.id,
            name: source.name,
            kind: 'meeting-speaker',
            backend: 'electron-screencapturekit',
          })
        }
      }

      if (!params.profile.speech.providerId.trim()
        || !params.profile.speech.model.trim()
        || !params.profile.speech.locale.trim()) {
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_SPEECH_CONFIG_REQUIRED',
          category: 'PROVIDER',
          route,
          sessionId: params.sessionId,
          message: 'ASR provider, model, and locale must be configured for meeting audio.',
          action: 'configure-speech-recognition',
        }))
      }
    }
    else {
      if (!components.blackHoleInstalled) {
        component = 'not-installed'
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_BLACKHOLE_NOT_INSTALLED',
          category: 'INSTALLATION',
          route,
          sessionId: params.sessionId,
          message: 'BlackHole 2ch is required by the selected compatibility audio-output backend.',
          action: 'install-native-component',
        }))
      }

      if (!params.profile.agentAudio.outputDeviceId.trim()) {
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_AGENT_OUTPUT_DEVICE_REQUIRED',
          category: 'DEVICE',
          route,
          sessionId: params.sessionId,
          message: 'The BlackHole audio output must be selected explicitly.',
          action: 'select-device',
        }))
      }
      else if (params.profile.agentAudio.outputDeviceName !== MEETING_MEDIA_COMPATIBILITY_NAMES.virtualMicrophone) {
        issues.push(createPreflightError({
          code: 'MEETING_MEDIA_AGENT_OUTPUT_DEVICE_INVALID',
          category: 'DEVICE',
          route,
          sessionId: params.sessionId,
          message: 'The selected AIRI speech output must be BlackHole 2ch.',
          action: 'select-device',
        }))
      }
      else if (components.blackHoleInstalled) {
        devices.push({
          id: params.profile.agentAudio.outputDeviceId,
          name: params.profile.agentAudio.outputDeviceName,
          kind: 'virtual-microphone',
          backend: 'blackhole-coreaudio',
        })
      }
    }

    return [route, {
      route,
      required: true,
      ready: issues.length === 0,
      support: platformSupported ? 'supported' : 'unsupported',
      component,
      permission: routePermission,
      devices,
      issues,
    } satisfies MeetingMediaRoutePreflight]
  })) as Record<MeetingMediaRoute, MeetingMediaRoutePreflight>

  return routes
}

/**
 * Creates the current platform probe.
 *
 * It reports only capabilities proven by the operating system and packaged manifest. Missing
 * native adapters therefore block session start instead of silently selecting another source.
 */
export function createMeetingMediaPlatformProbe(): MeetingMediaPlatformProbe {
  return {
    async preflight(profile, sessionId) {
      const platform = resolvePlatform()
      const systemVersion = resolveSystemVersion()

      if (profile.backend === 'compatibility') {
        const routes = await inspectCompatibilityRoutes({ profile, platform, systemVersion, sessionId })
        const requiredRoutes = resolveRequiredMeetingMediaRoutes(profile)
        return {
          protocolVersion: MEETING_MEDIA_PROTOCOL_VERSION,
          platform,
          systemVersion,
          checkedAtMs: Date.now(),
          ready: requiredRoutes.every(route => routes[route].ready),
          routes,
        }
      }

      const platformSupported = isPlatformVersionSupported(platform, systemVersion)
      const manifestResult = await loadNativeComponentManifest(platform)
      const requiredRoutes = new Set(resolveRequiredMeetingMediaRoutes(profile))

      const routes = Object.fromEntries(
        MEETING_MEDIA_ROUTES.map((route) => {
          const preflight = requiredRoutes.has(route)
            ? inspectRequiredRoute({ route, profile, platformSupported, manifestResult, sessionId })
            : createOptionalRoutePreflight(route)
          return [route, preflight]
        }),
      ) as Record<MeetingMediaRoute, MeetingMediaRoutePreflight>

      return {
        protocolVersion: MEETING_MEDIA_PROTOCOL_VERSION,
        platform,
        systemVersion,
        checkedAtMs: Date.now(),
        ready: Array.from(requiredRoutes).every(route => routes[route].ready),
        routes,
      }
    },
  }
}
