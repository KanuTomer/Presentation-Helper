import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../src/shared/contracts'
import { canonicalAccelerator, parseSettingsPatch, validateSettingsMutation } from '../src/main/settings/validation'

const settings: AppSettings = {
  glassTint: 0.42, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
  strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
  projectSummary: '', approvedVocabulary: [], sessionBudgetUsd: 0.25
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
    expect(() => validateSettingsMutation(settings, { glassTint: 0.5 }, true)).not.toThrow()
    expect(() => validateSettingsMutation(settings, { sessionBudgetUsd: 1 }, true)).toThrow(/active/i)
  })

  it('strictly bounds renderer patches and rejects unknown fields', () => {
    expect(parseSettingsPatch({ sessionBudgetUsd: 83.5, glassTint: 0.42, projectSummary: '🧪'.repeat(4_000) }))
      .toMatchObject({ sessionBudgetUsd: 83.5, glassTint: 0.42 })
    expect(() => parseSettingsPatch({ sessionBudgetUsd: 0 })).toThrow()
    expect(() => parseSettingsPatch({ sessionBudgetUsd: 101 })).toThrow()
    expect(() => parseSettingsPatch({ glassTint: 0.17 })).toThrow()
    expect(() => parseSettingsPatch({ opacity: 0.8 })).toThrow()
    expect(() => parseSettingsPatch({ inrPerUsd: 84 })).toThrow()
    expect(() => parseSettingsPatch({ projectSummary: '🧪'.repeat(4_001) })).toThrow(/4,000/i)
    expect(() => parseSettingsPatch({ telemetry: true })).toThrow(/unrecognized|invalid/i)
  })

  it('normalizes approved vocabulary without accepting duplicate or oversized terms', () => {
    expect(parseSettingsPatch({ approvedVocabulary: ['  WASAPI ', 'wasapi', 'FTS5'] }).approvedVocabulary).toEqual(['WASAPI', 'FTS5'])
    expect(() => parseSettingsPatch({ approvedVocabulary: ['x'.repeat(65)] })).toThrow(/1–64/i)
  })
})
