export const channels = {
  status: 'app:status', getStatus: 'app:get-status', getSettings: 'settings:get', updateSettings: 'settings:update',
  getApiKeyStatus: 'secrets:status', saveApiKey: 'secrets:save-key', deleteApiKey: 'secrets:delete-key', testApiKey: 'secrets:test-key',
  ask: 'ai:ask', cancel: 'ai:cancel', clearSession: 'ai:clear-session', getUsage: 'usage:get', clearUsage: 'usage:clear',
  selectDocuments: 'documents:select', listDocuments: 'documents:list', removeDocument: 'documents:remove',
  searchDocuments: 'documents:search', inspectDocument: 'documents:inspect',
  clearAllDocuments: 'documents:clear-all',
  clickThrough: 'window:click-through', opacity: 'window:opacity', showSettings: 'window:show-settings',
  startListening: 'audio:start', stopListening: 'audio:stop', audioResponse: 'audio:response', appError: 'app:error',
  refreshAudioDevices: 'audio:refresh-devices', ackListeningIndicator: 'audio:indicator-rendered', ackAnswerVisible: 'audio:answer-rendered',
  acceptListeningConsent: 'privacy:accept-listening', acknowledgeTransmissionPreview: 'privacy:preview-rendered',
  clearCaptureResults: 'privacy:clear-capture-results', deleteAllLocalData: 'privacy:delete-all-local-data',
  dismissSettingsRecoveryWarning: 'settings:dismiss-recovery-warning',
  setCaptureProtection: 'capture:set-protection', saveCaptureResult: 'capture:save-result', removeCaptureResult: 'capture:remove-result',
  focusAsk: 'ui:focus-ask', openSettings: 'ui:open-settings', openPrivacy: 'ui:open-privacy'
} as const
