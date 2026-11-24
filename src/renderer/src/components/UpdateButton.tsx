import { ArrowDownToLine, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../shared/update'
import { sk } from '../i18n'
import { cx } from './ui'

type State = { kind: 'idle' } | { kind: 'downloading'; percent: number } | { kind: 'restarting' } | { kind: 'failed' }

/**
 * Header pill offering a newer version. On Windows ('install') a click downloads it and restarts
 * into it; on macOS ('download'), or after a failed in-app update, it opens the installer in the browser.
 */
export function UpdateButton({ update, disabled }: { update: UpdateInfo; disabled: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(
    () =>
      window.anonymo.onUpdateProgress((percent) =>
        setState(percent >= 100 ? { kind: 'restarting' } : { kind: 'downloading', percent: Math.floor(percent) })
      ),
    []
  )

  const inApp = update.mode === 'install' && state.kind !== 'failed'
  const working = state.kind === 'downloading' || state.kind === 'restarting'

  const click = () => {
    if (!inApp) return void window.anonymo.openUpdate()
    setState({ kind: 'downloading', percent: 0 })
    // On success the app quits and the new version starts, so only failure comes back here.
    window.anonymo.installUpdate().catch(() => setState({ kind: 'failed' }))
  }

  const label =
    state.kind === 'downloading'
      ? sk.updateDownloading(state.percent)
      : state.kind === 'restarting'
        ? sk.updateRestarting
        : state.kind === 'failed'
          ? sk.updateFailed
          : inApp
            ? sk.updateInstall(update.version)
            : sk.updateAvailable(update.version)

  const Icon = working ? Loader2 : inApp ? RefreshCw : ArrowDownToLine

  return (
    <button
      onClick={click}
      disabled={working || (inApp && disabled)}
      title={inApp ? (disabled ? sk.updateBusy : sk.updateInstallTitle) : sk.updateTitle}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[color-mix(in_oklab,var(--gold)_40%,transparent)] bg-[color-mix(in_oklab,var(--gold)_12%,transparent)] px-3 py-1 text-[12px] font-medium text-gold hover:bg-[color-mix(in_oklab,var(--gold)_20%,transparent)] disabled:cursor-default disabled:hover:bg-[color-mix(in_oklab,var(--gold)_12%,transparent)]"
    >
      <Icon className={cx('size-3.5', working && 'animate-spin')} />
      <span className="tabular-nums">{label}</span>
    </button>
  )
}
