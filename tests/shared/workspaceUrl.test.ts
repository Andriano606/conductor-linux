import { describe, it, expect } from 'vitest'
import { workspaceUrl } from '@shared/workspaceUrl'

describe('workspaceUrl', () => {
  it('defaults to localhost when host is empty or missing', () => {
    expect(workspaceUrl('', 3000)).toBe('http://localhost:3000')
    expect(workspaceUrl(undefined, 3000)).toBe('http://localhost:3000')
    expect(workspaceUrl('   ', 3000)).toBe('http://localhost:3000')
  })

  it('uses a custom bare domain over http', () => {
    expect(workspaceUrl('myapp.local', 8080)).toBe('http://myapp.local:8080')
  })

  it('preserves an explicit scheme', () => {
    expect(workspaceUrl('https://myapp.local', 8080)).toBe('https://myapp.local:8080')
  })

  it('strips a trailing slash on the host', () => {
    expect(workspaceUrl('myapp.local/', 8080)).toBe('http://myapp.local:8080')
    expect(workspaceUrl('https://myapp.local/', 8080)).toBe('https://myapp.local:8080')
  })

  it('replaces a port the user typed into the host with the workspace port', () => {
    expect(workspaceUrl('myapp.local:1234', 8080)).toBe('http://myapp.local:8080')
    expect(workspaceUrl('https://myapp.local:1234', 8080)).toBe('https://myapp.local:8080')
  })
})
