import React from 'react'
import type { AiErrorInfo } from '../shared/contracts'

const titles: Record<AiErrorInfo['code'], string> = {
  invalid_key: 'API key needs attention', quota: 'OpenAI quota unavailable', rate_limit: 'OpenAI rate limit reached', timeout: 'OpenAI timed out',
  offline: 'OpenAI is unreachable', cancelled: 'Request cancelled', output_limit: 'Response budget exhausted',
  malformed_response: 'Invalid model response',
  busy: 'A request is already active', unknown: 'Request failed'
}

export function AiErrorPanel({ error, onRetry, onOpenSettings }: { error: AiErrorInfo; onRetry(): void; onOpenSettings(): void }): React.JSX.Element {
  return <div className={`notice ${error.code === 'cancelled' ? 'neutral' : 'danger'}`} role="alert" data-error-code={error.code}>
    <strong>{titles[error.code]}</strong><p>{error.message}</p>
    <div className="actions">
      {error.code === 'invalid_key' && <button onClick={onOpenSettings}>Open Settings</button>}
      {error.retryable && <button onClick={onRetry}>Retry</button>}
    </div>
  </div>
}
