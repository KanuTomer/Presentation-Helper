import React from 'react'

/** Static rim only: no canvas, animation loop, blending, or restoration state. */
export function QuietGlassLayer(): React.JSX.Element {
  return <div className="quiet-glass-layer" aria-hidden="true" />
}
