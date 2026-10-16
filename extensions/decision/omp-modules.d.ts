/**
 * Type declarations for the omp-only modules this extension resolves at runtime.
 *
 * omp ships as one bundled file whose `@oh-my-pi/*` specifiers were rewritten at
 * build time, so a specifier that node could resolve never exists in any tree we
 * typecheck against — these declarations give the compiler a shape without
 * dragging in a package that is not installed. Nothing here runs: each surface is
 * still reached behind a `try`, and the runtime shape is checked by the host
 * adapters, so `unknown` is the honest type for all of it.
 */
declare module "@oh-my-pi/pi-ai/judgment" {
  const surface: unknown;
  export default surface;
}

declare module "@oh-my-pi/pi-coding-agent/judgment" {
  const surface: unknown;
  export default surface;
}

declare module "@oh-my-pi/pi-coding-agent" {
  const surface: unknown;
  export default surface;
}

declare module "@oh-my-pi/pi-coding-agent/registry/agent-registry" {
  const surface: unknown;
  export default surface;
}

declare module "@oh-my-pi/coding-agent" {
  const surface: unknown;
  export default surface;
}

declare module "@oh-my-pi/pi-utils/dirs" {
  const surface: unknown;
  export default surface;
}
