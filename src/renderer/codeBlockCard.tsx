import React, { useEffect, useRef, useState } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import type { CodeBlock } from '../shared/contracts'

export type CopyCodeHandler = (code: string) => void | Promise<void>

export function CodeBlockCard({ block, onCopy }: { block: CodeBlock; onCopy?: CopyCodeHandler }): React.JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current) }, [])

  const copy = async (): Promise<void> => {
    if (!onCopy) return
    try {
      await onCopy(block.code)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1_800)
  }

  const label = block.title ? `${block.title} (${block.language})` : `${block.language} code`
  return <section className="code-block-card" aria-label={label}>
    <header className="code-block-header">
      <div className="code-block-heading">
        <span className="code-language">{block.language}</span>
        {block.title && <span className="code-title">{block.title}</span>}
      </div>
      <button
        type="button"
        className="code-copy-button"
        disabled={!onCopy}
        title={onCopy ? 'Copy code' : 'Code copying is unavailable.'}
        aria-label={`Copy ${label}`}
        onClick={() => void copy()}
      >{copyState === 'copied' ? 'Copied' : 'Copy'}</button>
    </header>
    <Highlight theme={themes.vsDark} code={block.code} language={normalizeLanguage(block.language)}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => <pre
        className={`code-scroll ${className}`}
        style={style}
        tabIndex={0}
        aria-label={`${label} source`}
      ><code>{tokens.map((line, lineIndex) => {
        const lineProps = getLineProps({ line })
        return <React.Fragment key={lineIndex}>
          <span {...lineProps} className={`code-line ${lineProps.className ?? ''}`.trim()}>
            {line.map((token, tokenIndex) => {
              const tokenProps = getTokenProps({ token })
              // prism-react-renderer represents an empty source line with a
              // synthetic newline token. Row separators below already carry
              // that newline, so rendering both would add a blank line and
              // duplicate trailing newlines.
              return <span key={tokenIndex} {...tokenProps}>{token.empty ? '' : tokenProps.children}</span>
            })}
          </span>
          {lineIndex < tokens.length - 1 ? '\n' : null}
        </React.Fragment>
      })}</code></pre>}
    </Highlight>
    <span className="copy-status" role="status" aria-live="polite">
      {copyState === 'copied' ? 'Code copied.' : copyState === 'failed' ? 'Code could not be copied.' : ''}
    </span>
  </section>
}

function normalizeLanguage(language: string): string {
  const normalized = language.normalize('NFKC').toLocaleLowerCase('en-US')
  return ({
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', py: 'python', rb: 'ruby', cs: 'csharp',
    'c#': 'csharp', 'c++': 'cpp', sh: 'bash', shell: 'bash',
    ps1: 'powershell', html: 'markup', xml: 'markup'
  } as Record<string, string>)[normalized] ?? normalized
}
