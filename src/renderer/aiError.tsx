import React from 'react'
import type { AiErrorInfo } from '../shared/contracts'

const titles: Record<AiErrorInfo['code'], string> = {
  invalid_key: 'API key needs attention', quota: 'OpenAI quota unavailable', rate_limit: 'OpenAI rate limit reached', timeout: 'OpenAI timed out',
  offline: 'OpenAI is unreachable', cancelled: 'Request cancelled', output_limit: 'Response budget exhausted',
  malformed_response: 'Invalid model response',
  busy: 'Another operation is active', helper_unavailable: 'Windows audio helper unavailable',
  device_unavailable: 'Audio output unavailable', invalid_audio: 'Recording could not be used',
  invalid_transcript: 'Reviewer speech was not understood', capture_timeout: 'Listening limit reached', unknown: 'Request failed'
}

export function AiErrorPanel({ error, onRetry, onOpenSettings, allowRetry = true }: { error: AiErrorInfo; onRetry(): void; onOpenSettings(): void; allowRetry?: boolean }): React.JSX.Element {
  return <div className={`notice ${error.code === 'cancelled' ? 'neutral' : 'danger'}`} role="alert" data-error-code={error.code}>
    <strong>{titles[error.code]}</strong><p>{error.message}</p>
    <div className="actions">
      {['invalid_key', 'helper_unavailable', 'device_unavailable'].includes(error.code) && <button onClick={onOpenSettings}>Open Settings</button>}
      {error.retryable && allowRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  </div>
}
