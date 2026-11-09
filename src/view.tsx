import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Mirror } from "./contract"
import { StreamController, type StreamState } from "./stream-controller"

const REFRESH_MS = 2000
type Mode = "stream" | "screenshot"

export function MirrorView(props: { ctx: any }) {
  const ctx = props.ctx
  // `use` exposes the reactive provider lifecycle (pending/active/inactive+reason);
  // `main` is the typed call client.
  const live = ctx.use(Mirror)
  const mirror = ctx.main(Mirror)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [devices, setDevices] = createSignal<any[]>([])
  const [deviceId, setDeviceId] = createSignal<string>("")
  const [shot, setShot] = createSignal<
    { data: string; width: number; height: number; locked: boolean; rotation: number } | null
  >(null)
  const [error, setError] = createSignal<string>("")
  const [diag, setDiag] = createSignal<string>("startup")
  const [auto, setAuto] = createSignal(true)
  const [paused, setPaused] = createSignal(false)
  const [text, setText] = createSignal("")

  // Real-time streaming state.
  const webCodecsSupported = StreamController.supported
  const [mode, setMode] = createSignal<Mode>(webCodecsSupported ? "stream" : "screenshot")
  const [streamState, setStreamState] = createSignal<StreamState | null>(null)
  let canvasEl: HTMLCanvasElement | undefined
  let controller: StreamController | null = null
  let streamSwipeStart: { x: number; y: number } | null = null

  let timer: ReturnType<typeof setInterval> | undefined
  let attempt = 0

  function ipcStatus(): string {
    try {
      const l = live()
      return l.status === "inactive" ? `inactive:${l.reason ?? "?"}` : l.status
    } catch (e) {
      return `use-error:${String((e as Error)?.message ?? e)}`
    }
  }

  /** Reject instead of hanging forever when the IPC provider is unavailable. */
  function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    const n = ++attempt
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out (attempt #${n}, ipc=${ipcStatus()})`)), 6000),
      ),
    ])
  }

  async function refreshDevices() {
    setDiag(`listing devices… ipc=${ipcStatus()}`)
    try {
      const list: Array<{ id: string; name: string; state: string; model: string; platform: string }> =
        await withTimeout(mirror.listDevices(), "listDevices")
      setDevices(list)
      setError("")
      setDiag(`ok: ${list.length} device(s), ipc=${ipcStatus()}`)
      const online = list.find((d) => d.state === "device")
      if (online && !list.some((d) => d.id === deviceId())) setDeviceId(online.id)
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      console.error("[mobile-mirror] listDevices failed", msg)
      setError(msg)
      setDiag(`listDevices failed | ipc=${ipcStatus()}`)
    }
  }

  async function refreshShot() {
    const id = deviceId()
    if (!id || paused()) return
    try {
      const s: { data: string; width: number; height: number; locked: boolean; rotation: number } =
        await withTimeout(mirror.screenshot({ device: id }), "screenshot")
      setShot(s)
      setError("")
      setDiag(`screen ok ${s.width}x${s.height} locked=${s.locked}, ipc=${ipcStatus()}`)
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      console.error("[mobile-mirror] screenshot failed", msg)
      setError(msg)
      setDiag(`screenshot failed | ipc=${ipcStatus()}`)
    }
  }

  /**
   * Map a click inside the displayed image back to physical device coordinates.
   * 始终以实际显示 <img> 的 getBoundingClientRect() 为基准做比例换算，
   * 机身外壳、bezel、缩放都不参与计算，因此坐标映射与改造前完全一致。
   */
  function deviceCoords(ev: MouseEvent) {
    const el = ev.currentTarget as HTMLImageElement
    const rect = el.getBoundingClientRect()
    const s = shot()
    if (!rect.width || !rect.height || !s) return null
    const rx = (ev.clientX - rect.left) / rect.width
    const ry = (ev.clientY - rect.top) / rect.height
    return { x: Math.round(rx * s.width), y: Math.round(ry * s.height) }
  }

  async function onTap(ev: MouseEvent) {
    const c = deviceCoords(ev)
    const id = deviceId()
    if (!c || !id) return
    await mirror.tap({ device: id, x: c.x, y: c.y })
    setTimeout(refreshShot, 400)
  }

  let swipeStart: { x: number; y: number } | null = null
  function onPointerDown(ev: MouseEvent) {
    const c = deviceCoords(ev)
    if (c) swipeStart = c
  }
  async function onPointerUp(ev: MouseEvent) {
    const end = deviceCoords(ev)
    const start = swipeStart
    swipeStart = null
    const id = deviceId()
    if (!end || !start || !id) return
    const dist = Math.hypot(end.x - start.x, end.y - start.y)
    // 判定阈值保持不变：位移超过物理屏幕长边的 8% 即视为滑动
    if (dist > Math.max(shot()?.width ?? 0, shot()?.height ?? 0) * 0.08) {
      await mirror.swipe({ device: id, x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: 300 })
      setTimeout(refreshShot, 400)
    }
  }

  async function sendKey(key: string) {
    const id = deviceId()
    if (!id) return
    if (mode() === "stream" && controller) await controller.pressKey(key)
    else await mirror.pressKey({ device: id, key })
    if (mode() === "screenshot") setTimeout(refreshShot, 400)
  }

  async function sendText() {
    const id = deviceId()
    const t = text()
    if (!id || !t) return
    if (mode() === "stream" && controller) await controller.typeText(t)
    else await mirror.typeText({ device: id, text: t })
    setText("")
    if (mode() === "screenshot") setTimeout(refreshShot, 400)
  }

  function wake() {
    const id = deviceId()
    if (!id) return
    void mirror.wake({ device: id }).then(refreshShot)
  }

  /* ── real-time scrcpy stream lifecycle ───────────────────────────────── */

  async function startStream() {
    const id = deviceId()
    if (!id || !canvasEl || controller) return
    setError("")
    const c = new StreamController({
      mirror,
      device: id,
      canvas: canvasEl,
      onState: (s) => {
        setStreamState(s)
        setDiag(`stream ${s.state} ${s.width}x${s.height}, ipc=${ipcStatus()}`)
      },
      onUnsupported: () => {
        setMode("screenshot")
        setError("当前环境不支持 WebCodecs 硬解，已自动切换到截图模式")
      },
      onError: (message) => setError(message),
    })
    controller = c
    await c.start()
  }

  async function stopStream() {
    const c = controller
    controller = null
    if (c) await c.stop().catch(() => {})
    setStreamState(null)
  }

  async function switchMode(next: Mode) {
    if (next === mode()) return
    if (next === "stream") {
      setMode("stream")
      await startStream()
    } else {
      await stopStream()
      setMode("screenshot")
      void refreshShot()
    }
  }

  // Track the active pointer so a drag keeps delivering move/up even if the
  // cursor leaves the canvas, and never leaves a virtual finger stuck "down".
  let activePointerId: number | null = null

  function onCanvasPointerDown(ev: PointerEvent) {
    if (!controller || activePointerId !== null) return
    const c = controller.toVideoCoords(ev)
    if (!c) return
    // Lock all subsequent pointer events to the canvas until release.
    try {
      ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
    } catch {
      // ignore if capture is unsupported
    }
    activePointerId = ev.pointerId
    streamSwipeStart = c
    void controller.touch(c.x, c.y, "down")
  }

  function onCanvasPointerMove(ev: PointerEvent) {
    if (!controller || activePointerId !== ev.pointerId) return
    const c = controller.toVideoCoords(ev)
    if (c) void controller.touch(c.x, c.y, "move")
  }

  async function finishPointer(ev: PointerEvent, cancelled: boolean) {
    if (!controller || activePointerId !== ev.pointerId) return
    activePointerId = null
    streamSwipeStart = null
    const c = controller.toVideoCoords(ev)
    try {
      ;(ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId)
    } catch {
      // already released
    }
    // Always lift the finger — even when the release landed outside the frame
    // (c === null), so the device never keeps scrolling after mouse-up.
    if (c && !cancelled) await controller.touch(c.x, c.y, "up")
    else await controller.touchUpLast()
  }

  function onCanvasPointerUp(ev: PointerEvent) {
    void finishPointer(ev, false)
  }

  function onCanvasPointerCancel(ev: PointerEvent) {
    void finishPointer(ev, true)
  }

  onMount(() => {
    void refreshDevices()
    timer = setInterval(() => {
      if (auto() && mode() === "screenshot") void refreshShot()
    }, REFRESH_MS)
    const deviceTimer = setInterval(refreshDevices, 5000)
    onCleanup(() => {
      if (timer) clearInterval(timer)
      clearInterval(deviceTimer)
      void stopStream()
    })
  })

  // (Re)start the stream when a device/mode changes. The inner onCleanup stops
  // the previous device's stream before the effect re-runs, preventing leaks.
  createEffect(() => {
    const id = deviceId()
    if (!id) return
    if (mode() === "stream") {
      void startStream()
      onCleanup(() => void stopStream())
    } else {
      void refreshShot()
    }
  })

  onCleanup(() => void stopStream())

  const currentDevice = createMemo(() => devices().find((d) => d.id === deviceId()))
  const hasDevice = createMemo(() => !!deviceId())
  // Landscape detection differs by mode: scrcpy re-encodes to a wide frame, while
  // a screencap keeps the portrait canvas (so read the display rotation instead).
  const isLandscape = createMemo(() => {
    if (mode() === "stream") {
      const s = streamState()
      return !!s && s.width > 0 && s.height > 0 && s.width > s.height
    }
    const r = shot()?.rotation ?? 0
    return r === 90 || r === 270
  })
  const frameSize = createMemo<{ width: number; height: number }>(() => {
    if (mode() === "stream") {
      const s = streamState()
      return { width: s?.width ?? 0, height: s?.height ?? 0 }
    }
    return { width: shot()?.width ?? 0, height: shot()?.height ?? 0 }
  })
  const isStreaming = createMemo(
    () => mode() === "stream" && streamState()?.state === "streaming" && hasDevice(),
  )
  const isLive = createMemo(
    () => hasDevice() && (mode() === "stream" ? isStreaming() : auto() && !paused()),
  )
  const diagHasError = createMemo(() => /failed|timed out|error/i.test(diag()))

  // 图标均取自 SDK IconName 集合（icon-name.d.ts）；ctx 为 any，宿主组件直接以 JSX 调用
  const UiIcon = ctx.ui.Icon

  return (
    <div class="mm-root">
      {/* ── 紧凑 header：设备名 + 连接状态 + Live 徽标 + 刷新 ── */}
      <header class="mm-header">
        <span class="mm-device-icon">
          <UiIcon name="monitor" size="small" />
        </span>
        <div class="mm-title-block">
          <div class="mm-title-row">
            <span class="mm-status-dot" data-on={hasDevice()} />
            <div class="mm-device-picker">
              <select
                class="mm-device-select"
                value={deviceId()}
                onChange={(e) => setDeviceId(e.currentTarget.value)}
                aria-label="选择设备"
              >
                <Show when={devices().length === 0} fallback={devices().map((d) => (
                  <option value={d.id}>{d.name}（{d.state}）</option>
                ))}>
                  <option value="">手机镜像</option>
                </Show>
              </select>
              <UiIcon name="chevron-down" size="small" />
            </div>
          </div>
          <span class="mm-subtitle">
            {hasDevice() ? (currentDevice()?.state === "device" ? "已连接 · 可触控操作" : `设备状态：${currentDevice()?.state}`) : "未检测到设备"}
          </span>
        </div>
        <span class="mm-live" data-live={isLive()}>
          {isLive() ? "直播中" : paused() ? "已暂停" : "未连接"}
        </span>
        <ctx.ui.IconButton
          icon="refresh"
          label="刷新设备"
          size="small"
          onClick={() => void refreshDevices()}
        />
      </header>

      {/* ── 画面模式切换：实时视频流 / 截图轮询 ── */}
      <div class="mm-mode" role="tablist" aria-label="画面模式">
        <button
          class="mm-mode-btn"
          data-active={mode() === "stream"}
          disabled={!webCodecsSupported}
          title={webCodecsSupported ? "scrcpy 实时视频流（约 30fps）" : "当前环境不支持 WebCodecs 硬解"}
          onClick={() => void switchMode("stream")}
        >
          <UiIcon name="outline-video" size="small" />
          实时流
        </button>
        <button
          class="mm-mode-btn"
          data-active={mode() === "screenshot"}
          onClick={() => void switchMode("screenshot")}
        >
          <UiIcon name="photo" size="small" />
          截图
        </button>
      </div>

      <Show when={error()}>
        <div class="mm-error" role="alert">
          <UiIcon name="circle-exclamation" size="small" />
          <span>{error()}</span>
        </div>
      </Show>

      {/* ── 拟物手机机身：屏幕完整 contain，不裁剪；实时流随设备旋转切换竖/横形态 ── */}
      <div class="mm-stage">
        <div class="mm-phone" data-landscape={mode() === "stream" && isLandscape()}>
          <div class="mm-screen-frame">
            <div class="mm-screen" data-landscape={mode() === "stream" && isLandscape()}>
              {/* 实时视频流模式：WebCodecs 解码到 canvas */}
              <Show when={mode() === "stream"}>
                <canvas
                  ref={canvasEl}
                  class="mm-shot mm-canvas"
                  onPointerDown={onCanvasPointerDown}
                  onPointerMove={onCanvasPointerMove}
                  onPointerUp={(e) => void onCanvasPointerUp(e)}
                  onPointerCancel={(e) => void onCanvasPointerCancel(e)}
                />
                <Show when={!isStreaming()}>
                  <div class="mm-overlay" data-kind={hasDevice() ? "loading" : "empty"}>
                    <Show
                      when={hasDevice()}
                      fallback={
                        <>
                          <span class="mm-overlay-icon"><UiIcon name="monitor" size="large" /></span>
                          <span class="mm-overlay-title">暂无手机画面</span>
                          <span class="mm-overlay-sub">请连接安卓设备并确认 USB 调试已开启</span>
                        </>
                      }
                    >
                      <div class="mm-spinner" />
                      <span class="mm-overlay-sub">
                        {streamState()?.state === "error" ? "视频流启动失败，可切换到截图模式" : "正在建立实时视频流…"}
                      </span>
                    </Show>
                  </div>
                </Show>
                <Show when={isStreaming()}>
                  <span class="mm-hint">点击轻点 · 按住拖动滑动 · 实时触控</span>
                </Show>
              </Show>

              {/* 截图轮询模式：与改造前一致的 img 渲染与坐标映射 */}
              <Show when={mode() === "screenshot"}>
                <Show
                  when={shot()}
                  fallback={
                    <div class="mm-overlay" data-kind={hasDevice() ? "loading" : "empty"}>
                      <Show
                        when={hasDevice()}
                        fallback={
                          <>
                            <span class="mm-overlay-icon"><UiIcon name="monitor" size="large" /></span>
                            <span class="mm-overlay-title">暂无手机画面</span>
                            <span class="mm-overlay-sub">请连接安卓设备并确认 USB 调试已开启</span>
                          </>
                        }
                      >
                        <div class="mm-spinner" />
                        <span class="mm-overlay-sub">等待手机画面…</span>
                      </Show>
                    </div>
                  }
                >
                  {(s) => (
                    <>
                      <img
                        class="mm-shot"
                        src={`data:image/png;base64,${s().data}`}
                        draggable={false}
                        onClick={(e) => void onTap(e)}
                        onMouseDown={onPointerDown}
                        onMouseUp={(e) => void onPointerUp(e)}
                      />
                      <Show when={isLandscape()}>
                        <button class="mm-rotate-tip" onClick={() => void switchMode("stream")}>
                          <UiIcon name="outline-video" size="small" />
                          设备已横置 · 切到实时流可全屏跟随旋转
                        </button>
                      </Show>
                      <span class="mm-hint">点击轻点 · 按住拖动滑动</span>
                      <Show when={s().locked}>
                        <div class="mm-overlay" data-kind="locked">
                          <span class="mm-overlay-icon"><UiIcon name="lock" size="large" /></span>
                          <span class="mm-overlay-title">设备已锁屏</span>
                          <span class="mm-overlay-sub">唤醒后即可在屏幕上直接触控</span>
                          <button class="mm-send mm-wake-btn" onClick={wake}>
                            唤醒屏幕
                          </button>
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </div>

      {/* ── 底部控制区：手机导航样式 ── */}
      <div class="mm-controls">
        <nav class="mm-nav" aria-label="手机导航键">
          <button class="mm-nav-btn" disabled={!hasDevice()} onClick={() => void sendKey("BACK")}>
            <UiIcon name="arrow-left" size="small" />
            返回
          </button>
          <button class="mm-nav-btn" disabled={!hasDevice()} onClick={() => void sendKey("HOME")}>
            <UiIcon name="dot-grid" size="small" />
            主屏
          </button>
          <button class="mm-nav-btn" disabled={!hasDevice()} onClick={() => void sendKey("APP_SWITCH")}>
            <UiIcon name="menu" size="small" />
            最近任务
          </button>
        </nav>

        <div class="mm-actions">
          <button class="mm-action-btn" disabled={!hasDevice()} onClick={() => void sendKey("WAKEUP")}>
            <UiIcon name="status-active" size="small" />
            电源
          </button>
          <Show
            when={mode() === "screenshot"}
            fallback={
              <button
                class="mm-action-btn"
                data-pressed={!isStreaming()}
                disabled={!hasDevice()}
                onClick={() => void (isStreaming() ? stopStream() : startStream())}
              >
                <UiIcon name={isStreaming() ? "stop" : "refresh"} size="small" />
                {isStreaming() ? "停止流" : "重连流"}
              </button>
            }
          >
            <button
              class="mm-action-btn"
              data-pressed={paused()}
              disabled={!hasDevice()}
              onClick={() => setPaused(!paused())}
            >
              <UiIcon name={paused() ? "refresh" : "stop"} size="small" />
              {paused() ? "继续" : "暂停"}
            </button>
          </Show>
          <Show when={mode() === "screenshot"}>
            <button
              class="mm-action-btn"
              disabled={!hasDevice() || paused()}
              onClick={() => void refreshShot()}
            >
              <UiIcon name="photo" size="small" />
              立即截图
            </button>
          </Show>
        </div>

        <div class="mm-text-row">
          <input
            class="mm-input"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void sendText() }}
            placeholder="输入文字后回车发送到手机"
            disabled={!hasDevice()}
            aria-label="发送到手机的文字"
          />
          <button class="mm-send" disabled={!hasDevice() || !text()} onClick={() => void sendText()}>
            发送
          </button>
        </div>

        {/* 自动刷新仅属于截图轮询模式；实时流本身持续推帧，无需此开关 */}
        <Show when={mode() === "screenshot"}>
          <label class="mm-switch-row">
            <input type="checkbox" checked={auto()} onChange={(e) => setAuto(e.currentTarget.checked)} />
            <span class="mm-switch" aria-hidden="true" />
            <span class="mm-switch-copy">
              <span class="mm-switch-title">自动刷新画面</span>
              <span class="mm-switch-desc">每 {REFRESH_MS / 1000} 秒同步一次手机屏幕</span>
            </span>
          </label>
        </Show>
      </div>

      {/* ── 诊断信息降级为底部等宽小字，出错才高亮 ── */}
      <p class="mm-diag" data-testid="mobile-mirror-diag" data-error={diagHasError()}>
        {diag()}
      </p>
    </div>
  )
}
