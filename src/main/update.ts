import { app, session } from 'electron'
import { autoUpdater } from 'electron-updater'
import { parseLatest, UPDATE_ORIGIN, type UpdateInfo } from '../shared/update'

/**
 * New versions, checked once per launch. The only network traffic the app makes:
 *
 * - Windows: electron-updater reads /latest.yml. On the user's click it downloads the new installer
 *   (only the changed blocks when the old version's .blockmap exists), runs it silently and starts the
 *   new version. Per-user NSIS install, so no UAC prompt.
 * - macOS: GET /latest.json and a button that opens the DMG in the browser. Squirrel.Mac refuses to
 *   update an app without a Developer ID signature, which Anonymo does not have yet.
 *
 * Both run in their own sessions (electron-updater uses its own partition), so the lockdown on the
 * default session (privacy.ts), which every window and document goes through, is unchanged. No
 * document data, identifiers or settings are sent.
 *
 * Skipped in development and tests (not packaged) and in the Microsoft Store build, which the Store
 * updates itself and whose listing promises no network access.
 */
let check: Promise<UpdateInfo | null> | null = null

export function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!app.isPackaged || process.windowsStore) return Promise.resolve(null)
  check ??= process.platform === 'win32' ? checkInstallable().catch(() => fetchLatest()) : fetchLatest()
  return check
}

async function checkInstallable(): Promise<UpdateInfo | null> {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null
  const r = await autoUpdater.checkForUpdates()
  if (!r?.isUpdateAvailable) return null
  return { version: r.updateInfo.version, url: `${UPDATE_ORIGIN}/windows`, mode: 'install' }
}

async function fetchLatest(): Promise<UpdateInfo | null> {
  try {
    const ses = session.fromPartition('anonymo-update', { cache: false })
    const res = await ses.fetch(`${UPDATE_ORIGIN}/latest.json`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    return parseLatest(await res.json(), app.getVersion(), process.platform)
  } catch {
    // Offline, firewall, proxy… The app works the same without it, so say nothing.
    return null
  }
}

/** Downloads the offered update and restarts into it. Rejects if there is nothing installable or the download fails. */
export async function installUpdate(onProgress: (percent: number) => void): Promise<void> {
  const offer = await check
  if (offer?.mode !== 'install') throw new Error('Žiadna aktualizácia na inštaláciu.')
  const h = (p: { percent: number }) => onProgress(p.percent)
  autoUpdater.on('download-progress', h)
  try {
    await autoUpdater.downloadUpdate()
  } finally {
    autoUpdater.off('download-progress', h)
  }
  // Silent install, then start the new version. The app's before-quit cleanup still runs.
  autoUpdater.quitAndInstall(true, true)
}

/** The renderer may only open the installer link this check produced, never an arbitrary URL. */
export async function offeredUrl(): Promise<string | null> {
  return (await check)?.url ?? null
}
