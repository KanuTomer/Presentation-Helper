import type { DeleteAllLocalDataResult } from '../../shared/contracts.js'

interface RelaunchApplication {
  relaunch(): void
  exit(exitCode?: number): void
}

interface UnrefTimer {
  unref?(): void
}

type Schedule = (callback: () => void, delayMs: number) => UnrefTimer

/**
 * Schedule a relaunch only after every local-data scope was deleted.
 * Keeping this decision outside the IPC callback makes the all-or-partial
 * boundary independently testable without loading Electron.
 */
export function scheduleRelaunchAfterDeletion(
  outcome: Pick<DeleteAllLocalDataResult, 'ok'>,
  application: RelaunchApplication,
  schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs)
): boolean {
  if (!outcome.ok) return false
  const timer = schedule(() => {
    application.relaunch()
    application.exit(0)
  }, 100)
  timer.unref?.()
  return true
}
