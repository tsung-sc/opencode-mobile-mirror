import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp"
import { AdbServerClient } from "@yume-chan/adb"
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy"
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  ScrcpyPointerId,
  ScrcpyVideoCodecId,
} from "@yume-chan/scrcpy"
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy"
import { SCRCPY_SERVER_BASE64 } from "./scrcpy-server"

export type Log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

export interface StreamConfig {
  maxSize: number
  maxFps: number
  videoBitRate: number
}

export interface SessionEvents {
  onPacket(packet: { type: "configuration" | "data"; data: Uint8Array; keyframe: boolean }): void
  onStatus(status: {
    state: "starting" | "streaming" | "stopped" | "error"
    message: string | null
    width: number
    height: number
    codec: number
  }): void
}

const REMOTE_SERVER_PATH = "/data/local/tmp/opencode-scrcpy-server"

function serverBytes(): Uint8Array {
  const binary = Buffer.from(SCRCPY_SERVER_BASE64, "base64")
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
}

/** One scrcpy session per device serial. */
export class ScrcpySession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: AdbScrcpyClient<any> | null = null
  private aborted = false
  private width = 0
  private height = 0
  private codec: number = ScrcpyVideoCodecId.H264
  private outputPump: Promise<void> | null = null

  constructor(
    private readonly device: string,
    private readonly config: StreamConfig,
    private readonly events: SessionEvents,
    private readonly log: Log,
  ) {}

  async start(): Promise<void> {
    this.events.onStatus({ state: "starting", message: null, width: 0, height: 0, codec: this.codec })

    const connector = new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 })
    const serverClient = new AdbServerClient(connector)
    const adb = await serverClient.createAdb({ serial: this.device })

    // Push the server jar (idempotent; cheap once it is on the device).
    const bytes = serverBytes()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    await AdbScrcpyClient.pushServer(
      adb,
      stream as unknown as Parameters<typeof AdbScrcpyClient.pushServer>[1],
      REMOTE_SERVER_PATH,
    )

    const options = new AdbScrcpyOptionsLatest({
      audio: false,
      video: true,
      control: true,
      videoCodec: "h264",
      maxSize: this.config.maxSize || 0,
      maxFps: this.config.maxFps || 0,
      videoBitRate: this.config.videoBitRate || 8_000_000,
      tunnelForward: true,
      logLevel: "info",
    })

    this.client = await AdbScrcpyClient.start(adb, REMOTE_SERVER_PATH, options)
    const video = await this.client.videoStream
    this.codec = video.metadata.codec
    this.width = video.width
    this.height = video.height

    video.sizeChanged((size: { width: number; height: number }) => {
      this.width = size.width
      this.height = size.height
      this.events.onStatus({
        state: "streaming",
        message: null,
        width: this.width,
        height: this.height,
        codec: this.codec,
      })
    })

    // Drain scrcpy's textual output so the multiplexed connection never blocks.
    this.outputPump = this.pumpOutput()
    // The device echoes clipboard contents/acks back on this stream; drain it so
    // the control connection never backs up (clipboardAutosync is on by default).
    if (this.client.clipboard) {
      const cbReader = this.client.clipboard.getReader()
      void (async () => {
        try {
          for (;;) {
            const { done } = await cbReader.read()
            if (done) break
          }
        } catch {
          // closed during teardown
        } finally {
          cbReader.releaseLock()
        }
      })()
    }

    this.events.onStatus({
      state: "streaming",
      message: null,
      width: this.width,
      height: this.height,
      codec: this.codec,
    })

    const reader = video.stream.getReader()
    try {
      for (;;) {
        const { value: packet, done } = await reader.read()
        if (done) break
        if (this.aborted) break
        this.forward(packet)
      }
    } catch (e) {
      if (!this.aborted) {
        this.log("error", "video stream error", { device: this.device, error: String(e) })
        this.events.onStatus({
          state: "error",
          message: String((e as Error)?.message ?? e),
          width: this.width,
          height: this.height,
          codec: this.codec,
        })
      }
    } finally {
      reader.releaseLock()
    }
  }

  private forward(packet: ScrcpyMediaStreamPacket): void {
    if (packet.type === "configuration") {
      this.events.onPacket({ type: "configuration", data: packet.data, keyframe: false })
    } else {
      // pts is intentionally dropped: the WebCodecs decoder stamps chunk timestamps itself.
      this.events.onPacket({
        type: "data",
        data: packet.data,
        keyframe: packet.keyframe ?? false,
      })
    }
  }

  private async pumpOutput(): Promise<void> {
    if (!this.client) return
    const reader = this.client.output.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.trim()) this.log("info", "scrcpy: " + value.trim().slice(0, 160), { device: this.device })
      }
    } catch {
      // output closed during teardown
    } finally {
      reader.releaseLock()
    }
  }

  private requireController() {
    const c = this.client?.controller
    if (!c) throw new Error("scrcpy controller not available")
    return c
  }

  /** Common shape for an injectTouch payload; cast keeps us off the tight generated struct type. */
  private touchPayload(action: number, x: number, y: number, pressure: number) {
    return {
      action: action as AndroidMotionEventAction,
      pointerId: ScrcpyPointerId.VirtualFinger,
      pointerX: x,
      pointerY: y,
      videoWidth: this.width || 0,
      videoHeight: this.height || 0,
      pressure,
      actionButton: 0,
      buttons: 0,
    }
  }

  /** Inject a touch phase at physical device coordinates. */
  async touch(x: number, y: number, phase: "down" | "move" | "up"): Promise<void> {
    const action =
      phase === "down"
        ? AndroidMotionEventAction.Down
        : phase === "move"
          ? AndroidMotionEventAction.Move
          : AndroidMotionEventAction.Up
    await this.requireController().injectTouch(
      this.touchPayload(action, x, y, phase === "up" ? 0 : 1),
    )
  }

  /** Drag from one point to another, synthesizing down, moves, then up. */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const controller = this.requireController()
    const send = (action: number, x: number, y: number, pressure: number) =>
      controller.injectTouch(this.touchPayload(action, x, y, pressure))
    await send(AndroidMotionEventAction.Down, x1, y1, 1)
    const steps = Math.max(2, Math.round(durationMs / 16))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await send(
        AndroidMotionEventAction.Move,
        Math.round(x1 + (x2 - x1) * t),
        Math.round(y1 + (y2 - y1) * t),
        1,
      )
    }
    await send(AndroidMotionEventAction.Up, x2, y2, 0)
  }

  async injectText(text: string): Promise<void> {
    const controller = this.requireController()
    // injectText only emits ASCII key events and cannot deliver IME text such as
    // Chinese. For any non-ASCII content, push it to the device clipboard and ask
    // scrcpy to auto-paste it into the focused field.
    if (/^[\x00-\x7F]*$/.test(text)) {
      await controller.injectText(text)
    } else {
      await controller.setClipboard({
        sequence: BigInt(Date.now()),
        paste: true,
        content: text,
      })
    }
  }

  /** Map the panel's logical key names to Android keycodes and inject down+up. */
  async pressKey(key: string): Promise<void> {
    const map: Record<string, AndroidKeyCode> = {
      HOME: AndroidKeyCode.AndroidHome,
      BACK: AndroidKeyCode.AndroidBack,
      APP_SWITCH: AndroidKeyCode.AndroidAppSwitch,
      POWER: AndroidKeyCode.Power,
      WAKEUP: AndroidKeyCode.Power,
      ENTER: AndroidKeyCode.Enter,
      VOLUME_UP: AndroidKeyCode.VolumeUp,
      VOLUME_DOWN: AndroidKeyCode.VolumeDown,
    }
    const keyCode = map[key.toUpperCase()]
    if (keyCode === undefined) throw new Error(`unsupported key: ${key}`)
    const controller = this.requireController()
    await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 })
    await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 })
  }

  async stop(): Promise<void> {
    this.aborted = true
    try {
      await this.client?.close()
    } catch (e) {
      this.log("warn", "scrcpy close error", { device: this.device, error: String(e) })
    }
    this.client = null
    this.events.onStatus({
      state: "stopped",
      message: null,
      width: this.width,
      height: this.height,
      codec: this.codec,
    })
  }
}
