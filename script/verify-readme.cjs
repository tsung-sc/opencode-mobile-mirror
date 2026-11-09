const fs = require("fs")
for (const f of ["README.md", "README.zh-CN.md"]) {
  const s = fs.readFileSync(f, "utf8")
  console.log("== " + f + " ==")
  console.log("  links to zh-CN:", s.includes("README.zh-CN.md"))
  console.log("  links to English README:", /\]\(README\.md\)/.test(s))
  console.log("  image:", (s.match(/screenshot\.png/g) || []).length, "ref(s)")
  console.log("  contains CJK:", /[\u4e00-\u9fff]/.test(s))
  console.log("  ends with MIT:", s.trimEnd().endsWith("MIT"))
}
