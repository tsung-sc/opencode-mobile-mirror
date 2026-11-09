import { Command, MenuItem, Panel, Plugin, Style, type PanelTab } from "@opencode/plugin/gui"
import { main } from "./main"
import mirrorCss from "./mirror.css?inline"
import { MirrorView } from "./view"

export default Plugin.define({
  os: ["windows", "macos", "linux"],
  i18n: {
    en: {
      title: "Phone Mirror",
      "command.open": "Open phone mirror",
      "menu.open": "Phone mirror",
    },
  },
  setup(ctx) {
    // 注入面板专属样式（mm- 前缀隔离宿主，颜色走宿主主题变量并带 fallback）
    ctx.add(Style, mirrorCss)

    const tab: PanelTab = {
      id: "mirror",
      get title() {
        return ctx.t("title")
      },
      closable: "compact",
      fallback: true,
    }

    ctx.add(Panel, {
      id: "mirror",
      region: "side",
      width: 360,
      mobile: {
        get title() {
          return ctx.t("title")
        },
        order: 40,
        kind: "menu",
        icon: "monitor",
      },
      list: (input) => (input.open.includes("mirror") ? [tab] : []),
      render: () => <MirrorView ctx={ctx} />,
    })

    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      keywords: "android phone adb screen mirror mobile",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:mirror`, session)
      },
    }))

    ctx.add(MenuItem, (): MenuItem => ({
      menu: "session.panel",
      id: "open",
      title: ctx.t("menu.open"),
      description: "Live Android screen over adb",
      icon: "monitor",
      order: 10,
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:mirror`, session)
      },
    }))
  },
  main,
})
