import { afterEach } from 'vitest'

// jest-dom matchers (extends expect with toBeInTheDocument, toBeDisabled, …).
// Harmless under the node environment — it only augments `expect`.
import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement ResizeObserver, which TerminalView observes the host
// with. Stub it so mounting the terminal view doesn't crash the render tree.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// Auto-unmount React trees between tests. Imported lazily so the node-environment
// main-process tests (which never touch the DOM) don't pull in jsdom globals.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  }
})
