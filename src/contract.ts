import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/**
 * All payloads use Schema.Struct (plain objects), not Schema.Class.
 * The IPC bridge validates inputs against the schema and plain objects do not
 * satisfy a Class's instance check ("Expected X"); Struct decodes them fine.
 */

/** One connected device as reported by `adb devices -l`. */
export const Device = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
  model: Schema.String,
  platform: Schema.String,
})
export type Device = Schema.Schema.Type<typeof Device>

/** A PNG screenshot plus the device resolution used to map taps. */
export const Screenshot = Schema.Struct({
  /** base64 encoded PNG bytes */
  data: Schema.String,
  /** device physical width in px */
  width: Schema.Number,
  /** device physical height in px */
  height: Schema.Number,
  /** true while the keyguard (lock screen) is showing */
  locked: Schema.Boolean,
  /** current display rotation in degrees: 0/90/180/270 (90/270 = landscape) */
  rotation: Schema.Number,
})
export type Screenshot = Schema.Schema.Type<typeof Screenshot>

export const DeviceInput = Schema.Struct({ device: Schema.String })

export const TapInput = Schema.Struct({
  device: Schema.String,
  /** physical device x coordinate */
  x: Schema.Number,
  /** physical device y coordinate */
  y: Schema.Number,
})

export const SwipeInput = Schema.Struct({
  device: Schema.String,
  x1: Schema.Number,
  y1: Schema.Number,
  x2: Schema.Number,
  y2: Schema.Number,
  /** swipe duration in ms */
  duration: Schema.Number,
})

export const TextInput = Schema.Struct({
  device: Schema.String,
  text: Schema.String,
})

export const KeyInput = Schema.Struct({
  device: Schema.String,
  /** ADB keycode name without the KEYCODE_ prefix, e.g. HOME, BACK, WAKEUP */
  key: Schema.String,
})

/* ── scrcpy real-time streaming ──────────────────────────────────────────── */

export const StreamInput = Schema.Struct({
  device: Schema.String,
  /** cap the longer edge, 0 = native resolution */
  maxSize: Schema.Number,
  maxFps: Schema.Number,
  videoBitRate: Schema.Number,
})

/** One encoded H.264 packet crossing the IPC bridge as raw bytes. */
export const VideoPacket = Schema.Struct({
  /** "configuration" (SPS/PPS) or "data" (a frame chunk) */
  type: Schema.String,
  data: Schema.Uint8Array,
  keyframe: Schema.Boolean,
})

export const StreamStatus = Schema.Struct({
  device: Schema.String,
  /** "starting" | "streaming" | "stopped" | "error" */
  state: Schema.String,
  message: Schema.NullishOr(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
  /** logical video codec id from scrcpy (H264 = 1748121140) */
  codec: Schema.Number,
})

export const StreamTouchInput = Schema.Struct({
  device: Schema.String,
  /** physical device coordinates */
  x: Schema.Number,
  y: Schema.Number,
  /** "down" | "move" | "up" */
  phase: Schema.String,
  /** logical video width/height the panel used to compute the ratio, for sanity */
  pointerId: Schema.Number,
})

export const StreamSwipeInput = Schema.Struct({
  device: Schema.String,
  x1: Schema.Number,
  y1: Schema.Number,
  x2: Schema.Number,
  y2: Schema.Number,
  durationMs: Schema.Number,
})

/**
 * Bridge between the renderer panel and the Electron main process,
 * which is the only half allowed to spawn the native `adb` binary and run
 * the Tango scrcpy client. Video packets travel back over `events`.
 */
export const Mirror = Ipc.define({
  id: "mobile-mirror.mirror",
  methods: {
    listDevices: { output: Schema.Array(Device) },
    screenshot: { input: DeviceInput, output: Screenshot },
    tap: { input: TapInput },
    swipe: { input: SwipeInput },
    typeText: { input: TextInput },
    pressKey: { input: KeyInput },
    wake: { input: DeviceInput },
    // scrcpy session lifecycle (screenshot methods stay as a fallback)
    startStream: { input: StreamInput, output: StreamStatus },
    stopStream: { input: DeviceInput },
    streamTouch: { input: StreamTouchInput },
    streamSwipe: { input: StreamSwipeInput },
    streamKey: { input: KeyInput },
    streamTypeText: { input: TextInput },
  },
  events: {
    videoPacket: VideoPacket,
    streamStatus: StreamStatus,
  },
})
