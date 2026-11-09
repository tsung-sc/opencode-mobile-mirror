const fs = require("fs")
const css = fs.readFileSync("src/mirror.css")
try {
  new TextDecoder("utf-8", { fatal: true }).decode(css)
  console.log("mirror.css valid UTF-8, bytes:", css.length)
} catch (e) {
  console.log("ENCODING BROKEN:", e.message)
  process.exit(1)
}
const view = fs.readFileSync("src/view.tsx", "utf8")
const used = new Set()
for (const m of view.matchAll(/class="([^"]+)"/g)) {
  m[1].split(/\s+/).forEach((c) => c && used.add(c))
}
const cssText = css.toString("utf8")
const missing = [...used].filter((c) => !cssText.includes("." + c))
console.log("classes used:", used.size)
console.log("missing in css:", missing.length ? missing.join(", ") : "none")
// ensure no crosshair remains and pointer cursor present
console.log("crosshair count:", (cssText.match(/crosshair/g) || []).length)
console.log("pointer cursor count:", (cssText.match(/cursor: pointer/g) || []).length)
