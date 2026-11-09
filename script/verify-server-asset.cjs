const fs = require("fs")
const m = fs.readFileSync("src/scrcpy-server.ts", "utf8")
const b64 = m.split('"')[1]
const bytes = Buffer.from(b64, "base64")
console.log("decoded bytes:", bytes.length)
console.log("magic:", bytes.subarray(0, 4).toString("hex"), "expect 504b0304 (PK zip/jar)")
console.log("roundtrip matches vendor file:", bytes.equals(fs.readFileSync("vendor/scrcpy-server-v3.3.3.bin")))
