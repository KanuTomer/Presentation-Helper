// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ShortcutSettingsTransaction } from '../src/main/settings/shortcutTransaction'

const previous = { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space' }
const next = { askShortcut: 'Alt+A', hideShortcut: 'Alt+H', listenShortcut: 'Alt+Space' }

function harness() {
  const electron = { shortcutWarnings: [] as string[], applyShortcutSet: vi.fn(() => true) }
  const configureHelper = vi.fn(async () => undefined)
  const commit = vi.fn(async () => 'committed')
  const rollbackPersistence = vi.fn(async () => undefined)
  const transaction = new ShortcutSettingsTransaction(electron, configureHelper)
  return { electron, configureHelper, commit, rollbackPersistence, transaction }
}

describe('atomic shortcut settings transaction', () => {
  it('commits only after Electron and the restricted helper accept the complete set', async () => {
    const h = harness()
    await expect(h.transaction.apply({ previous, next, commit: h.commit, rollbackPersistence: h.rollbackPersistence })).resolves.toBe('committed')
    expect(h.electron.applyShortcutSet).toHaveBeenCalledWith(next.askShortcut, next.hideShortcut, previous)
    expect(h.configureHelper).toHaveBeenCalledWith(next.listenShortcut)
    expect(h.commit).toHaveBeenCalledOnce()
    expect(h.rollbackPersistence).not.toHaveBeenCalled()
  })

  it('does not touch helper or persistence when the OS rejects a shortcut', async () => {
    const h = harness()
    h.electron.shortcutWarnings.push('Alt+A conflicts with another application.')
    h.electron.applyShortcutSet.mockReturnValue(false)
    await expect(h.transaction.apply({ previous, next, commit: h.commit, rollbackPersistence: h.rollbackPersistence })).rejects.toThrow(/conflicts/)
    expect(h.configureHelper).not.toHaveBeenCalled()
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.rollbackPersistence).not.toHaveBeenCalled()
  })

  it('does not require helper readiness when only ask/hide shortcuts change', async () => {
    const h = harness()
    h.configureHelper.mockRejectedValue(new Error('Helper unavailable.'))
    const askHideOnly = { ...next, listenShortcut: previous.listenShortcut }
    await expect(h.transaction.apply({ previous, next: askHideOnly, commit: h.commit, rollbackPersistence: h.rollbackPersistence })).resolves.toBe('committed')
    expect(h.configureHelper).not.toHaveBeenCalled()
  })

  it('rolls every layer back when helper registration or persistence fails', async () => {
    const helperFailure = harness()
    helperFailure.configureHelper.mockRejectedValueOnce(new Error('Native hook conflict.'))
    await expect(helperFailure.transaction.apply({ previous, next, commit: helperFailure.commit, rollbackPersistence: helperFailure.rollbackPersistence })).rejects.toThrow(/Native hook conflict/)
    expect(helperFailure.electron.applyShortcutSet).toHaveBeenNthCalledWith(2, previous.askShortcut, previous.hideShortcut, previous)
    expect(helperFailure.configureHelper).toHaveBeenNthCalledWith(2, previous.listenShortcut)
    expect(helperFailure.rollbackPersistence).toHaveBeenCalledOnce()

    const persistenceFailure = harness()
    persistenceFailure.commit.mockRejectedValue(new Error('Settings write failed.'))
    await expect(persistenceFailure.transaction.apply({ previous, next, commit: persistenceFailure.commit, rollbackPersistence: persistenceFailure.rollbackPersistence })).rejects.toThrow(/Settings write failed/)
    expect(persistenceFailure.electron.applyShortcutSet).toHaveBeenCalledTimes(2)
    expect(persistenceFailure.configureHelper).toHaveBeenCalledTimes(2)
    expect(persistenceFailure.rollbackPersistence).toHaveBeenCalledOnce()
  })

  it('surfaces an actionable restart requirement if any rollback layer fails', async () => {
    const h = harness()
    h.configureHelper.mockRejectedValueOnce(new Error('New hook conflict.')).mockRejectedValueOnce(new Error('Old hook restore failed.'))
    await expect(h.transaction.apply({ previous, next, commit: h.commit, rollbackPersistence: h.rollbackPersistence })).rejects.toThrow(/rollback was incomplete.*Restart PresenterAI/i)
  })
})
