/** Vite 以 ?inline 后缀导入的资源会在构建时内联为字符串。 */
declare module "*.css?inline" {
  const css: string
  export default css
}

/** 二进制资源强制内联为 data: URL（任意大小，不产出独立 asset 文件）。 */
declare module "*.bin?inline" {
  const dataUrl: string
  export default dataUrl
}
