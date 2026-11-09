import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/gui"
import { Mirror } from "./contract"
import { ScrcpySession } from "./scrcpy-session"

type Log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/** Locate adb without trusting the Electron PATH (GUI apps often miss user PATH like scoop). */
function resolveAdb(log: Log, override?: string): string {
  const home = homedir()
  const candidates = [
    process.env.OPENCODE_MOBILE_ADB,
    override,
    join(home, "scoop", "shims", "adb.exe"),
    join(home, "scoop", "apps", "adb", "current", "platform-tools", "adb.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk", "platform-tools", "adb.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Android", "platform-tools", "adb.exe"),
    join(process.env.PROGRAMFILES ?? "", "platform-tools", "adb.exe"),
  ].filter((c): c is string => !!c)
  for (const c of candidates) if (existsSync(c)) return c
  log("error", "no adb in candidate paths, falling back to PATH", { candidates })
  return "adb"
}

export function createAdb(adbPath: string, log: Log) {
  function adb(args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(adbPath, args, { windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on("data", (c) => out.push(c as Buffer))
      child.stderr.on("data", (c) => err.push(c as Buffer))
      child.on("error", reject)
      child.on("close", (code) =>
        resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1 }),
      )
    })
  }
  const shell = (device: string, command: string) =>
    adb(["-s", device, "shell", command]).then((r) => r.stdout.toString("utf8"))

  async function listDevices() {
    const r = await adb(["devices", "-l"])
    return r.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/)
        const m = line.match(/model:(\S+)/)
        return {
          id: parts[0],
          name: m ? m[1].replaceAll("_", " ") : parts[0],
          state: parts[1],
          model: m ? m[1] : "",
          platform: "android",
        }
      })
  }

  async function screenSize(device: string) {
    const m = (await shell(device, "wm size")).match(/(\d+)x(\d+)/)
    return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2400 }
  }

  return {
    adb,
    shell,
    listDevices,
    screenSize,
    async screenshot(device: string) {
      const [shot, size] = await Promise.all([
        adb(["-s", device, "exec-out", "screencap", "-p"]),
        screenSize(device),
      ])
      let locked = false
      let rotation = 0
      // Lock-screen detection: match the exact field value. Never use a loose
      // /true/ test on the whole dump — other config lines contain "=true" and
      // previously caused every screenshot to be reported as locked.
      try {
        const lockDump = await shell(
          device,
          "dumpsys window | grep -E 'mDreamingLockscreen|mShowingLockscreen|keyguardShowing'",
        )
        locked = /(mDreamingLockscreen|mShowingLockscreen|keyguardShowing)=true/.test(lockDump)
      } catch (e) {
        log("error", "lock check failed", { error: String(e) })
      }
      // Rotation detection: display rotation index (ROTATION_0..3 -> 0/90/180/270).
      try {
        const rotDump = await shell(
          device,
          "dumpsys window | grep -E 'mDisplayRotation=| mRotation='",
        )
        const displayRot = rotDump.match(/mDisplayRotation=ROTATION_(\d+)/)
        const winRot = rotDump.match(/\smRotation=ROTATION_(\d+)/)
        const idx = displayRot?.[1] ?? winRot?.[1]
        if (idx !== undefined) rotation = Number(idx) * 90
      } catch (e) {
        log("error", "rotation dump failed", { error: String(e) })
      }
      // Some ROMs don't expose rotation via dumpsys window; cross-check display.
      if (rotation === 0) {
        try {
          const displayDump = await shell(device, "dumpsys display")
          const ddi = displayDump.match(/DisplayDeviceInfo\{[\s\S]*?\brotation\s+(\d+)/)
          if (ddi) rotation = Number(ddi[1])
        } catch (e) {
          log("error", "display dump failed", { error: String(e) })
        }
      }
      if (shot.code !== 0 || shot.stdout.length === 0) {
        throw new Error(`screencap failed code=${shot.code} stderr=${shot.stderr}`)
      }
      return {
        data: shot.stdout.toString("base64"),
        width: size.width,
        height: size.height,
        locked,
        rotation,
      }
    },
  }
}

export const main: Plugin.MainSetup = (ctx) => {
  const log: Log = (level, message, extra) =>
    ctx.log.write(level, `[mobile-mirror] ${message}`, extra as Readonly<Record<string, unknown>>)
  const adbPath = resolveAdb(log, (ctx.options as { adbPath?: string } | undefined)?.adbPath)
  const bridge = createAdb(adbPath, log)
  log("info", "main process started", { adbPath })

  // Probe adb once at startup so the log shows PATH/toolchain problems immediately.
  bridge
    .adb(["version"])
    .then((r) => log("info", "adb probe ok", { version: r.stdout.toString("utf8").split("\n")[0] }))
    .catch((e) => log("error", "adb probe failed", { error: String(e) }))

  type Caller = { window: number; signal: AbortSignal }
  // Ipc methods may return void or a value; widen to any to satisfy the bridge's void|Promise<void> shape.
  const wrap =
    (name: string, fn: (input: any, caller: Caller) => Promise<any>) =>
    async (input: any, caller: Caller): Promise<any> => {
      try {
        return await fn(input, caller)
      } catch (e) {
        log("error", `${name} failed`, { error: String((e as Error)?.message ?? e) })
        throw e
      }
    }

  // One live scrcpy session per device serial.
  const sessions = new Map<string, ScrcpySession>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ipc: any
  function provider() {
    ipc = ctx.provide(Mirror, {
      listDevices: wrap("listDevices", () => bridge.listDevices()),
      screenshot: wrap("screenshot", ({ device }) => bridge.screenshot(device)),
      tap: wrap("tap", ({ device, x, y }) => bridge.shell(device, `input tap ${Math.round(x)} ${Math.round(y)}`)),
      swipe: wrap(
        "swipe",
        ({ device, x1, y1, x2, y2, duration }) =>
          bridge.shell(
            device,
            `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(duration)}`,
          ),
      ),
      typeText: wrap("typeText", ({ device, text }) => {
        const safe = text.replaceAll("\\", "\\\\").replaceAll(" ", "%s")
        return bridge.shell(device, `input text "${safe}"`)
      }),
      pressKey: wrap("pressKey", ({ device, key }) => bridge.shell(device, `input keyevent KEYCODE_${key}`)),
      wake: wrap("wake", ({ device }) => bridge.shell(device, "input keyevent KEYCODE_WAKEUP")),

      startStream: wrap("startStream", async (input, caller) => {
        const { device, maxSize, maxFps, videoBitRate } = input
        await sessions.get(device)?.stop().catch(() => {})
        const session = new ScrcpySession(
          device,
          { maxSize, maxFps, videoBitRate },
          {
            onPacket: (packet) => ipc.emit("videoPacket", packet, caller.window),
            onStatus: (status) =>
              ipc.emit("streamStatus", { device, ...status }, caller.window),
          },
          log,
        )
        sessions.set(device, session)
        // Run the long-lived pump without awaiting it; status/events report progress.
        void session
          .start()
          .catch((e) => log("error", "scrcpy session crashed", { device, error: String(e) }))
        return {
          device,
          state: "starting",
          message: null,
          width: 0,
          height: 0,
          codec: 0,
        }
      }),

      stopStream: wrap("stopStream", async ({ device }) => {
        const session = sessions.get(device)
        if (session) {
          await session.stop().catch(() => {})
          sessions.delete(device)
        }
      }),

      streamTouch: wrap("streamTouch", async ({ device, x, y, phase }) => {
        await sessions.get(device)?.touch(x, y, phase)
      }),

      streamSwipe: wrap(
        "streamSwipe",
        async ({ device, x1, y1, x2, y2, durationMs }) => {
          await sessions.get(device)?.swipe(x1, y1, x2, y2, durationMs)
        },
      ),

      streamKey: wrap("streamKey", async ({ device, key }) => {
        const session = sessions.get(device)
        if (session) await session.pressKey(key)
        else await bridge.shell(device, `input keyevent KEYCODE_${key}`)
      }),

      streamTypeText: wrap("streamTypeText", async ({ device, text }) => {
        const session = sessions.get(device)
        if (session) await session.injectText(text)
        else {
          const safe = text.replaceAll("\\", "\\\\").replaceAll(" ", "%s")
          await bridge.shell(device, `input text "${safe}"`)
        }
      }),
    })
  }

  provider()

  ctx.onCleanup(() => {
    for (const session of sessions.values()) void session.stop().catch(() => {})
    sessions.clear()
  })
}
