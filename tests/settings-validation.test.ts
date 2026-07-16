import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../src/shared/contracts'
import { canonicalAccelerator, validateSettingsMutation } from '../src/main/settings/validation'

const settings: AppSettings = {
  opacity: 0.92, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
  strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
  projectSummary: '', approvedVocabulary: []
}

describe('runtime settings validation', () => {
  it('normalizes aliases/order and rejects bare or unsupported trigger keys', () => {
    expect(canonicalAccelerator('shift+ctrl+space')).toBe('CONTROL+SHIFT+SPACE')
    expect(() => canonicalAccelerator('Escape')).toThrow(/modifier|Escape/i)
    expect(() => canonicalAccelerator('Control+MediaPlayPause')).toThrow(/Space, A-Z/i)
  })

  it('rejects cross-layer and emergency shortcut conflicts before persistence', () => {
    expect(() => validateSettingsMutation(settings, { listenShortcut: 'Ctrl+Space' }, false)).toThrow(/conflicts/i)
    expect(() => validateSettingsMutation(settings, { askShortcut: 'Control+Shift+I' }, false)).toThrow(/emergency/i)
  })

  it('blocks operation-sensitive changes while allowing visual settings', () => {
    expect(() => validateSettingsMutation(settings, { selectedAudioEndpointId: 'next' }, true)).toThrow(/active/i)
    expect(() => validateSettingsMutation(settings, { listenShortcut: 'Control+Alt+Space' }, true)).toThrow(/active/i)
    expect(() => validateSettingsMutation(settings, { opacity: 0.8 }, true)).not.toThrow()
  })
})
