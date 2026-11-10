// wrangler `.wasm` файлыг bundle үед compile хийж WebAssembly.Module болгон import хийлгэнэ
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
