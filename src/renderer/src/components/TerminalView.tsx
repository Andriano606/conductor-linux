import { useEffect, useRef } from 'react'
import type { PtyKind } from '@shared/types'
import { fitAndResize, mount } from '../termRegistry'

export function TerminalView({ id, kind }: { id: string; kind: PtyKind }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    mount(host, id, kind)

    // Coalesce resize bursts to one fit per frame so a fit→layout→observer-fires
    // feedback loop can't pile up while output is streaming.
    let raf = 0
    const onResize = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        fitAndResize(id, kind)
      })
    }
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    observer.observe(host)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      observer.disconnect()
    }
  }, [id, kind])

  return <div className="term-host" ref={hostRef} />
}
