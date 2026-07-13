export const channels = {
  status: 'app:status', getStatus: 'app:get-status', getSettings: 'settings:get', updateSettings: 'settings:update',
  hasApiKey: 'secrets:has-key', saveApiKey: 'secrets:save-key', deleteApiKey: 'secrets:delete-key', testApiKey: 'secrets:test-key',
  ask: 'ai:ask', cancel: 'ai:cancel', clearSession: 'ai:clear-session', getUsage: 'usage:get',
  selectDocuments: 'documents:select', listDocuments: 'documents:list', removeDocument: 'documents:remove',
  clickThrough: 'window:click-through', opacity: 'window:opacity', showSettings: 'window:show-settings',
  startListening: 'audio:start', stopListening: 'audio:stop', audioResponse: 'audio:response', appError: 'app:error',
  refreshAudioDevices: 'audio:refresh-devices', setCaptureProtection: 'capture:set-protection', saveCaptureResult: 'capture:save-result', removeCaptureResult: 'capture:remove-result',
  focusAsk: 'ui:focus-ask', openSettings: 'ui:open-settings'
} as const
