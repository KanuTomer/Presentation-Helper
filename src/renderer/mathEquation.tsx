import React, { useEffect, useRef } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

export function MathEquation({ expression }: { expression: string }): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!element.current) return
    katex.render(expression, element.current, { displayMode: true, throwOnError: false, trust: false, strict: 'error', maxExpand: 500, maxSize: 20, output: 'htmlAndMathml' })
  }, [expression])
  return <div className="math-equation" ref={element} aria-label={expression} />
}
