import { useEffect, useRef } from 'react'
import type { PtyKind } from '@shared/types'
import { fitAndResize, mount } from '../termRegistry'

export function TerminalView({ id, kind }: { id: string; kind: PtyKind }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    mount(host, id, kind)

    const onResize = (): void => fitAndResize(id, kind)
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    observer.observe(host)
    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
    }
  }, [id, kind])

  return <div className="term-host" ref={hostRef} />
}
