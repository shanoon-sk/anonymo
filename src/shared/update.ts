// "Is there a newer version?" – pure logic, shared by the main process and the tests.
// Nothing is downloaded until the user clicks the button.

/** Download server (download-worker/). /latest.json names the current release, /latest.yml feeds electron-updater. */
export const UPDATE_ORIGIN = 'https://anonymo.shanoon.workers.dev'

export interface UpdateInfo {
  version: string
  /** Installer for this platform, always on UPDATE_ORIGIN. Opened in the browser for 'download'. */
  url: string
  /**
   * 'install' – Windows: the app downloads the update itself and restarts into it.
   * 'download' – macOS (no Developer ID signature yet, which in-app updates require there), or when
   * the in-app updater failed: the button opens the installer in the browser.
   */
  mode: 'install' | 'download'
}

const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)

/** True when `candidate` is a strictly higher x.y.z than `current`. Anything else is false. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** Turns the /latest.json body into an offer for this platform, or null when there is nothing to offer. */
export function parseLatest(body: unknown, current: string, platform: string): UpdateInfo | null {
  if (!body || typeof body !== 'object') return null
  const { version, windows, mac } = body as Record<string, unknown>
  const url = platform === 'win32' ? windows : platform === 'darwin' ? mac : undefined
  if (typeof version !== 'string' || typeof url !== 'string') return null
  // The link is opened in the user's browser, so it must point at our own server.
  if (!url.startsWith(`${UPDATE_ORIGIN}/`)) return null
  return isNewer(version, current) ? { version, url, mode: 'download' } : null
}
