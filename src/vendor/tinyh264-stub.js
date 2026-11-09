// Stub for @yume-chan/scrcpy-decoder-tinyh264.
// The real package ships a WASM worker used only as a fallback when the browser
// lacks native WebCodecs. Electron's Chromium always provides VideoDecoder, and
// the GUI bundle must stay a single CJS file (no emitted worker chunks), so we
// replace the package with its only symbol actually imported here: createCanvas.
export function createCanvas() {
  return document.createElement("canvas")
}
