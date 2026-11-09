# opencode-mobile-mirror

**[English](README.md) · 简体中文**

一款 [OpenCode Desktop](https://opencode.ai) GUI 插件：在会话右侧面板里实时镜像已连接的安卓手机，并能用鼠标直接操控——点按、滑动、输入文字、发送系统按键。基于本地 `adb` 工作，免 root、无需模拟器。

![opencode-mobile-mirror 面板](screenshot.png)

## 核心特性

- **实时视频流（约 30fps）**：基于 [scrcpy](https://github.com/Genymobile/scrcpy) 与 [Tango](https://github.com/yume-chan/ya-webadb) TypeScript 实现，在插件进程内用 WebCodecs 硬解、WebGL 渲染到 canvas。
- **截图回退模式**：每 2 秒轮询一张截图，适合不支持 WebCodecs 的环境。
- **可交互操控**：光标为手指形状，点击即轻点、拖动即滑动，可输入文字并发送主屏/返回/最近任务/电源键。指针捕获（pointer capture）保证鼠标移出画面后虚拟手指也一定抬起，不会卡住。
- **旋转跟随**：设备横竖屏切换时，面板里的手机机身同步切换形态。
- **中文输入**：含中文等非 ASCII 文字时，自动走剪贴板粘贴，绕开 `input text` 只能输入英文的限制。
- **单文件插件**：全部打包进一个 CommonJS 模块，scrcpy server 以 base64 内嵌，无需随包附带额外二进制。

## 工作原理

```
OpenCode 面板（SolidJS + WebCodecs canvas）
        │  类型化 IPC 桥（事件 + 方法）
        ▼
Electron 主进程  ── adb (127.0.0.1:5037) ──► 安卓设备
        └─ Tango scrcpy 客户端：推送 server、启动 H.264 流、注入触控/按键
```

- 只有**主进程**能启动原生进程并运行 Tango 客户端；它会自行定位 `adb`（含常见的 Scoop、Android SDK 路径），因此从开始菜单启动、拿不到 shell `PATH` 的 GUI 应用也能正常工作。
- 编码后的 H.264 数据包通过 IPC **事件**通道以原始 `Uint8Array` 发回窗口，由窗口侧解码渲染。
- 触控坐标会从按 contain 缩放显示的 canvas 反向换算成物理视频像素，任意尺寸、任意方向下点按都准确。

## 环境要求

- OpenCode Desktop（使用实验性 GUI 扩展 API）。
- 已安装 Android Platform Tools（`adb`），设备开启 **USB 调试**并连接（或用 `adb connect` 走 Wi-Fi）。
- 实时流需要支持 WebCodecs 的 Chromium 运行时（OpenCode Desktop 已内置）。

## 安装

本插件以本地目录方式使用，先构建再在 OpenCode 配置中注册：

```bash
npm install
npm run build
```

然后在 `opencode.json` 里引用本地目录（字段名随 OpenCode 版本略有差异）：

```json
{
  "plugins": ["/你的/本地/路径/opencode-mobile-mirror"]
}
```

打开会话，在侧栏 **+** 菜单里选择 **Phone mirror**。

## 使用说明

- 顶部设备名本身就是下拉框，多设备时可直接切换。
- 用分段开关在**实时流**（scrcpy，约 30fps）和**截图**（2 秒轮询）之间切换。
- 实时流模式下悬停画面有操作提示；可用下方的主屏/返回/最近任务/电源键。
- 在输入框打字后回车：英文直接注入，中文等输入法文字自动通过剪贴板粘贴。
- 旋转手机（如全屏看视频）时，面板机身会跟着旋转。

## 常见问题

- **一直停在“正在建立实时视频流”**：查看桌面日志（`%APPDATA%/ai.opencode.desktop/logs`）。出现 `plugin event encoding failed` 通常是 Struct 载荷缺字段——声明的每个 key 都必须存在（可为 `null`，不能缺失）。
- **面板找不到设备**：确认 `adb devices` 能看到手机且已授权 USB 调试。
- **横屏时截图模式画面有黑边**：属正常，`screencap` 仍输出竖屏画布；请改用实时流，它会编码出真正的横向帧。
- **中文输入没反应**：先在手机上点一下输入框使其获得焦点，插件通过剪贴板粘贴文字。

## 局限

- 仅支持安卓（iOS 在 Windows 上无法本地控制，需要云设备方案）。
- 截图模式 2 秒轮询且无法原生旋转；看视频、快速交互建议用实时流。
- 内嵌的 scrcpy server 采用 Apache-2.0 许可，详见上游 scrcpy 项目。

## 许可证

MIT
