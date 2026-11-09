import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  resolve: {
    alias: {
      // Drop the WASM fallback decoder (and its emitted worker chunk); native
      // WebCodecs in Electron covers H.264. Only createCanvas was imported.
      "@yume-chan/scrcpy-decoder-tinyh264": fileURLToPath(
        new URL("./src/vendor/tinyh264-stub.js", import.meta.url),
      ),
    },
  },
  plugins: [gui()],
})
