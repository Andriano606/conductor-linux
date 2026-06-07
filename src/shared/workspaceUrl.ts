// Builds the URL opened by the "open in browser" button. Shared by the main
// process (which actually opens it) and the renderer (tooltip), so both always
// agree on what the button does.

/**
 * Combine a project's configured browser host with a workspace port into a URL.
 * The host may be a bare domain ("localhost", "myapp.local") or include a
 * scheme ("https://myapp.local"). Empty/undefined falls back to "localhost".
 * A trailing slash and any trailing port on the host are ignored.
 */
export function workspaceUrl(browserHost: string | undefined, port: number): string {
  const raw = (browserHost ?? '').trim().replace(/\/+$/, '')
  const schemeMatch = raw.match(/^(\w+:\/\/)(.*)$/)
  const scheme = schemeMatch ? schemeMatch[1] : 'http://'
  // Host without scheme, and without a port the user may have typed in.
  const host = (schemeMatch ? schemeMatch[2] : raw).replace(/:\d+$/, '') || 'localhost'
  return `${scheme}${host}:${port}`
}
