import type { MeetingMediaVideoProfile } from '@proj-airi/stage-shared/meeting-media'

/** Character renderer kinds represented by the shared Stage component. */
export type MeetingStageRenderer = 'live2d' | 'vrm' | 'spine' | 'tachie' | 'mmd' | 'godot'

/** Latest renderer-owned canvas and Stage background state sampled for one meeting frame. */
export interface MeetingStageFrameSnapshot {
  canvas: HTMLCanvasElement
  renderer: MeetingStageRenderer
  capturedAtMs: number
  stageBackgroundUrl: string | null
  stageBackgroundColor: string | null
}

/** Renderer-owned source boundary. Reading never serializes the frame to PNG or JPEG. */
export interface MeetingStageFrameSource {
  ownerId: string
  renderer: () => MeetingStageRenderer | null
  read: () => MeetingStageFrameSnapshot | null
}

/** Visible canvas owned by the desktop Stage page while compatibility output is active. */
export interface MeetingVideoOutputSurface {
  ownerId: string
  canvas: HTMLCanvasElement
}

/** Fixed-size canvas frame reused by the compositor with latest-frame ownership semantics. */
export interface MeetingVideoComposedFrame {
  canvas: HTMLCanvasElement
  sequence: number
  capturedAtMs: number
  composedAtMs: number
  compositorLatencyMs: number
  width: number
  height: number
}

/** Explicit composition failure safe to map into the video route's structured error. */
export class MeetingVideoCompositionError extends Error {
  constructor(
    public readonly code: 'STAGE_FRAME_UNAVAILABLE' | 'STAGE_BACKGROUND_UNAVAILABLE' | 'MEETING_BACKGROUND_UNRESOLVED' | 'MEETING_BACKGROUND_LOAD_FAILED' | 'MEETING_BACKGROUND_COLOR_INVALID' | 'MEETING_COMPOSITOR_CONTEXT_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'MeetingVideoCompositionError'
  }
}

let registeredSource: MeetingStageFrameSource | null = null
let registeredOutputSurface: MeetingVideoOutputSurface | null = null

/**
 * Registers the single Stage instance allowed to publish meeting frames in this renderer process.
 * The returned cleanup removes only the same owner and is safe to call repeatedly.
 */
export function registerMeetingStageFrameSource(source: MeetingStageFrameSource): () => void {
  if (registeredSource && registeredSource.ownerId !== source.ownerId) {
    throw new Error(`Meeting Stage frame source is already owned by "${registeredSource.ownerId}".`)
  }

  registeredSource = source
  return () => {
    if (registeredSource?.ownerId === source.ownerId)
      registeredSource = null
  }
}

/** Returns the currently registered source without transferring its lifecycle ownership. */
export function getMeetingStageFrameSource(): MeetingStageFrameSource | null {
  return registeredSource
}

/** Registers the single clean output surface captured by OBS in this renderer process. */
export function registerMeetingVideoOutputSurface(surface: MeetingVideoOutputSurface): () => void {
  if (registeredOutputSurface && registeredOutputSurface.ownerId !== surface.ownerId) {
    throw new Error(`Meeting video output surface is already owned by "${registeredOutputSurface.ownerId}".`)
  }

  registeredOutputSurface = surface
  return () => {
    if (registeredOutputSurface?.ownerId === surface.ownerId)
      registeredOutputSurface = null
  }
}

/** Returns the current clean output canvas without transferring its DOM ownership. */
export function getMeetingVideoOutputSurface(): MeetingVideoOutputSurface | null {
  return registeredOutputSurface
}

function coverRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  }
}

function characterRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fit: MeetingMediaVideoProfile['fit'],
) {
  const scale = fit === 'cover'
    ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
    : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  }
}

/**
 * Composites the latest Stage canvas into a reusable opaque 720p or 1080p canvas.
 * Consumers must copy or publish the returned canvas before requesting the next frame.
 */
export class MeetingVideoCompositor {
  private readonly canvas: HTMLCanvasElement
  private readonly imageByUrl = new Map<string, Promise<HTMLImageElement>>()
  private sequence = 0
  private disposed = false

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas')
  }

  async compose(params: {
    source: MeetingStageFrameSnapshot
    profile: MeetingMediaVideoProfile
    /** Resolved URL for an explicit profile background ID; omitted values fail instead of falling back. */
    resolvedBackgroundUrl?: string
  }): Promise<MeetingVideoComposedFrame> {
    if (this.disposed)
      throw new Error('Meeting video compositor is disposed.')

    const { source, profile } = params
    if (source.canvas.width <= 0 || source.canvas.height <= 0) {
      throw new MeetingVideoCompositionError(
        'STAGE_FRAME_UNAVAILABLE',
        'The active Stage renderer has no complete canvas frame.',
      )
    }

    const startedAt = performance.now()
    this.canvas.width = profile.width
    this.canvas.height = profile.height
    const context = this.canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new MeetingVideoCompositionError(
        'MEETING_COMPOSITOR_CONTEXT_UNAVAILABLE',
        'A 2D meeting video compositor could not be created.',
      )
    }

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    await this.drawBackground(context, source, profile, params.resolvedBackgroundUrl)

    const target = characterRect(
      source.canvas.width,
      source.canvas.height,
      profile.width,
      profile.height,
      profile.fit,
    )

    context.save()
    if (profile.mirrorSource) {
      context.translate(profile.width, 0)
      context.scale(-1, 1)
      context.drawImage(source.canvas, target.x, target.y, target.width, target.height)
    }
    else {
      context.drawImage(source.canvas, target.x, target.y, target.width, target.height)
    }
    context.restore()

    const composedAtMs = Date.now()
    this.sequence += 1
    return {
      canvas: this.canvas,
      sequence: this.sequence,
      capturedAtMs: source.capturedAtMs,
      composedAtMs,
      compositorLatencyMs: performance.now() - startedAt,
      width: profile.width,
      height: profile.height,
    }
  }

  /** Releases cached background elements and rejects subsequent frame requests. */
  dispose(): void {
    this.disposed = true
    this.imageByUrl.clear()
    this.canvas.width = 0
    this.canvas.height = 0
  }

  private async drawBackground(
    context: CanvasRenderingContext2D,
    source: MeetingStageFrameSnapshot,
    profile: MeetingMediaVideoProfile,
    resolvedBackgroundUrl?: string,
  ): Promise<void> {
    if (profile.background.kind === 'color') {
      this.fillColor(context, profile.background.value)
      return
    }

    if (profile.background.kind === 'image') {
      if (!resolvedBackgroundUrl) {
        throw new MeetingVideoCompositionError(
          'MEETING_BACKGROUND_UNRESOLVED',
          `Meeting background "${profile.background.backgroundId}" has no resolved URL.`,
        )
      }
      await this.drawCoverImage(context, resolvedBackgroundUrl)
      return
    }

    if (source.stageBackgroundUrl) {
      await this.drawCoverImage(context, source.stageBackgroundUrl)
      return
    }

    if (source.stageBackgroundColor) {
      this.fillColor(context, source.stageBackgroundColor)
      return
    }

    throw new MeetingVideoCompositionError(
      'STAGE_BACKGROUND_UNAVAILABLE',
      'The Stage profile requires a background, but the active Stage exposes neither an image nor a color.',
    )
  }

  private fillColor(context: CanvasRenderingContext2D, color: string): void {
    if (!CSS.supports('color', color)) {
      throw new MeetingVideoCompositionError(
        'MEETING_BACKGROUND_COLOR_INVALID',
        `Meeting background color "${color}" is invalid.`,
      )
    }

    context.fillStyle = color
    context.fillRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private async drawCoverImage(context: CanvasRenderingContext2D, url: string): Promise<void> {
    const image = await this.loadImage(url)
    const target = coverRect(image.naturalWidth, image.naturalHeight, this.canvas.width, this.canvas.height)
    context.drawImage(image, target.x, target.y, target.width, target.height)
  }

  private async loadImage(url: string): Promise<HTMLImageElement> {
    const cached = this.imageByUrl.get(url)
    if (cached)
      return await cached

    const pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => resolve(image)
      image.onerror = () => reject(new MeetingVideoCompositionError(
        'MEETING_BACKGROUND_LOAD_FAILED',
        `Meeting background "${url}" could not be loaded.`,
      ))
      image.src = url
    })
    this.imageByUrl.set(url, pending)

    try {
      return await pending
    }
    catch (error) {
      this.imageByUrl.delete(url)
      throw error
    }
  }
}
