import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs"
import { ScrcpyVideoCodecId } from "@yume-chan/scrcpy"
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy"

export interface StreamPacket {
  type: "configuration" | "data"
  data: Uint8Array
  keyframe: boolean
}

export interface StreamState {
  state: "starting" | "streaming" | "stopped" | "error"
  message?: string | null
  width: number
  height: number
  codec: number
}

export interface ControllerOptions {
  /** The typed Ipc client (ctx.main(Mirror)). */
  mirror: any
  device: string
  canvas: HTMLCanvasElement
  onState: (s: StreamState) => void
  onUnsupported: () => void
  onError: (message: string) => void
}

/**
 * Window-side controller: subscribes to scrcpy packets over IPC events,
 * decodes H.264 with WebCodecs, renders to a WebGL canvas, and maps pointer
 * events back to physical video coordinates for touch injection.
 */
export class StreamController {
  private decoder: WebCodecsVideoDecoder | null = null
  private writer: WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null = null
  private unsubPacket: (() => void) | null = null
  private unsubStatus: (() => void) | null = null
  private stopped = false
  private videoWidth = 0
  private videoHeight = 0
  // Last in-frame touch position, used to lift the finger if release lands off-frame.
  private lastTouch: { x: number; y: number } | null = null

  constructor(private readonly opts: ControllerOptions) {}

  static get supported(): boolean {
    return WebCodecsVideoDecoder.isSupported && WebGLVideoFrameRenderer.isSupported
  }

  async start(): Promise<void> {
    if (!StreamController.supported) {
      this.opts.onUnsupported()
      return
    }
    const { mirror, device, canvas, onState, onError } = this.opts

    const renderer = new WebGLVideoFrameRenderer(canvas, false)
    this.decoder = new WebCodecsVideoDecoder({ codec: ScrcpyVideoCodecId.H264, renderer })
    this.decoder.sizeChanged((size) => {
      this.videoWidth = size.width
      this.videoHeight = size.height
      canvas.style.objectFit = "contain"
    })
    this.writer = this.decoder.writable.getWriter()

    // Receive encoded packets from the main process and feed the decoder.
    this.unsubPacket = mirror.on("videoPacket", (packet: StreamPacket) => {
      if (this.stopped || !this.writer) return
      // The IPC payload is structurally identical to the library's media packet.
      const mediaPacket = packet as unknown as ScrcpyMediaStreamPacket
      void this.writer.write(mediaPacket).catch((e) => {
        if (!this.stopped) onError(String((e as Error)?.message ?? e))
      })
    })

    this.unsubStatus = mirror.on("streamStatus", (status: StreamState) => {
      if (status.width) this.videoWidth = status.width
      if (status.height) this.videoHeight = status.height
      onState(status)
      if (status.state === "error") onError(status.message ?? "stream error")
    })

    try {
      await mirror.startStream({
        device,
        maxSize: 1080,
        maxFps: 30,
        videoBitRate: 8_000_000,
      })
    } catch (e) {
      onError(String((e as Error)?.message ?? e))
    }
  }

  /** Map a pointer event on the canvas to physical video coordinates. */
  toVideoCoords(ev: MouseEvent | PointerEvent): { x: number; y: number } | null {
    const el = ev.currentTarget as HTMLCanvasElement
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height || !this.videoWidth || !this.videoHeight) return null
    // The canvas content is rendered with object-fit: contain inside its box.
    const mediaAspect = this.videoWidth / this.videoHeight
    const boxAspect = rect.width / rect.height
    let contentW: number, contentH: number, offsetX: number, offsetY: number
    if (boxAspect > mediaAspect) {
      contentH = rect.height
      contentW = contentH * mediaAspect
      offsetX = (rect.width - contentW) / 2
      offsetY = 0
    } else {
      contentW = rect.width
      contentH = contentW / mediaAspect
      offsetX = 0
      offsetY = (rect.height - contentH) / 2
    }
    const localX = ev.clientX - rect.left - offsetX
    const localY = ev.clientY - rect.top - offsetY
    if (localX < 0 || localY < 0 || localX > contentW || localY > contentH) return null
    return {
      x: Math.round((localX / contentW) * this.videoWidth),
      y: Math.round((localY / contentH) * this.videoHeight),
    }
  }

  async touch(x: number, y: number, phase: "down" | "move" | "up"): Promise<void> {
    if (phase !== "up") this.lastTouch = { x, y }
    await this.opts.mirror.streamTouch({ device: this.opts.device, x, y, phase, pointerId: 0 })
  }

  /** Lift the finger at the last known in-frame position (release landed off-frame). */
  async touchUpLast(): Promise<void> {
    const p = this.lastTouch
    if (!p) return
    await this.opts.mirror.streamTouch({ device: this.opts.device, x: p.x, y: p.y, phase: "up", pointerId: 0 })
    this.lastTouch = null
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.opts.mirror.streamSwipe({
      device: this.opts.device,
      x1,
      y1,
      x2,
      y2,
      durationMs,
    })
  }

  async pressKey(key: string): Promise<void> {
    await this.opts.mirror.streamKey({ device: this.opts.device, key })
  }

  async typeText(text: string): Promise<void> {
    await this.opts.mirror.streamTypeText({ device: this.opts.device, text })
  }

  get dimensions() {
    return { width: this.videoWidth, height: this.videoHeight }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubPacket?.()
    this.unsubStatus?.()
    this.unsubPacket = null
    this.unsubStatus = null
    try {
      await this.writer?.close()
    } catch {
      // already closed
    }
    this.writer = null
    try {
      this.decoder?.dispose()
    } catch {
      // ignore teardown errors
    }
    this.decoder = null
    try {
      await this.opts.mirror.stopStream({ device: this.opts.device })
    } catch {
      // session may already be gone
    }
  }
}
