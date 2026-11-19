declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
declare module "*.sql" {
  const sqlText: string;
  export default sqlText;
}
declare module "@aphrody/auto-native/wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
declare module "cloudflare:workers" {
  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: unknown;
    protected env: Env;
  }
}
