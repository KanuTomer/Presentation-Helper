// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LIQUID_GLASS_MAX_DPR,
  LIQUID_GLASS_MAX_FPS,
  LiquidGlassLayer,
  clampNeonIntensity,
  computeLiquidGlassBackingSize,
  liquidGlassStatusClass,
  shouldAnimateLiquidGlass,
  shouldRenderLiquidGlassFrame
} from '../src/renderer/liquidGlass'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'presenter')
})

describe('liquid-glass helpers', () => {
  it('clamps intensity and caps the backing buffer DPR', () => {
    expect(clampNeonIntensity(-1)).toBe(0)
    expect(clampNeonIntensity(0.65)).toBe(0.65)
    expect(clampNeonIntensity(2)).toBe(1)
    expect(clampNeonIntensity(Number.NaN)).toBe(0)

    expect(computeLiquidGlassBackingSize(200, 100, 3)).toEqual({
      width: 300,
      height: 150,
      pixelRatio: LIQUID_GLASS_MAX_DPR
    })
    expect(computeLiquidGlassBackingSize(0, -1, Number.NaN)).toEqual({
      width: 1,
      height: 1,
      pixelRatio: 1
    })
  })

  it('animates only while visible and motion is permitted', () => {
    expect(shouldAnimateLiquidGlass(true, false)).toBe(true)
    expect(shouldAnimateLiquidGlass(false, false)).toBe(false)
    expect(shouldAnimateLiquidGlass(true, true)).toBe(false)
    expect(liquidGlassStatusClass('context-lost')).toBe('liquid-glass--context-lost')
    expect(shouldRenderLiquidGlassFrame(1_000, Number.NEGATIVE_INFINITY)).toBe(true)
    expect(shouldRenderLiquidGlassFrame(1_000 + (1_000 / LIQUID_GLASS_MAX_FPS) / 2, 1_000)).toBe(false)
    expect(shouldRenderLiquidGlassFrame(1_000 + 1_000 / LIQUID_GLASS_MAX_FPS + 0.001, 1_000)).toBe(true)
  })
})

describe('LiquidGlassLayer', () => {
  it('is transparent, inert, and exposes a safe fallback when WebGL2 is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const status = vi.fn()
    const { container } = render(
      <LiquidGlassLayer neonIntensity={0.72} onStatusChange={status} />
    )

    const canvas = container.querySelector('canvas')
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    expect(canvas?.getAttribute('tabindex')).toBe('-1')
    expect(canvas?.classList.contains('liquid-glass-layer')).toBe(true)
    expect(canvas?.getAttribute('data-neon-intensity')).toBe('0.72')

    await waitFor(() => {
      expect(canvas?.getAttribute('data-liquid-glass-status')).toBe('fallback')
      expect(canvas?.classList.contains('liquid-glass--fallback')).toBe(true)
      expect(status).toHaveBeenCalledWith('fallback')
    })
  })

  it('reports context loss and rebuilds resources when WebGL2 is restored', async () => {
    const gl = createFakeWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl)
    let nextFrame: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrame = callback
      return 7
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let restoreSurface: (() => void) | undefined
    const unsubscribe = vi.fn()
    Object.defineProperty(window, 'presenter', {
      configurable: true,
      value: {
        onSurfaceRestored: (callback: () => void) => {
          restoreSurface = callback
          return unsubscribe
        }
      }
    })
    const status = vi.fn()
    const { container, unmount } = render(
      <LiquidGlassLayer neonIntensity={0.5} onStatusChange={status} />
    )
    const canvas = container.querySelector('canvas')!

    await waitFor(() => expect(canvas.dataset.liquidGlassStatus).toBe('ready'))
    expect(gl.createProgram).toHaveBeenCalledTimes(1)

    const viewportCalls = gl.viewport.mock.calls.length
    restoreSurface?.()
    expect(gl.viewport).toHaveBeenCalledTimes(viewportCalls + 1)
    act(() => {
      const frame = nextFrame
      nextFrame = undefined
      frame?.(performance.now() + 1_000)
    })
    expect(gl.drawArrays).toHaveBeenCalledOnce()

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    await waitFor(() => expect(canvas.dataset.liquidGlassStatus).toBe('context-lost'))

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    await waitFor(() => expect(canvas.dataset.liquidGlassStatus).toBe('ready'))
    expect(gl.createProgram).toHaveBeenCalledTimes(2)

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(cancelFrame).toHaveBeenCalled()
    expect(gl.deleteProgram).toHaveBeenCalled()
    expect(gl.deleteBuffer).toHaveBeenCalled()
  })

  it('updates the WebGL intensity uniform and renders another frame when props change', async () => {
    const gl = createFakeWebGl2Context()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl)
    let nextFrameId = 1
    const frames = new Map<number, FrameRequestCallback>()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId
      nextFrameId += 1
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })

    const flushFrames = (now: number): void => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(now)
    }
    const intensityValues = (): number[] => gl.uniform1f.mock.calls
      .filter(([location]) => (location as unknown as { name?: string })?.name === 'u_intensity')
      .map(([, value]) => value)

    const { container, rerender } = render(<LiquidGlassLayer neonIntensity={0} />)
    const canvas = container.querySelector('canvas')!
    await waitFor(() => expect(canvas.dataset.liquidGlassStatus).toBe('ready'))

    act(() => flushFrames(1_000))
    expect(intensityValues()).toContain(0)
    const drawCountAtZero = gl.drawArrays.mock.calls.length

    rerender(<LiquidGlassLayer neonIntensity={1} />)
    act(() => flushFrames(1_100))

    expect(canvas.dataset.neonIntensity).toBe('1')
    expect(intensityValues()).toContain(1)
    expect(gl.drawArrays.mock.calls.length).toBeGreaterThan(drawCountAtZero)
    expect(gl.enable).not.toHaveBeenCalled()
    expect(gl.blendFunc).not.toHaveBeenCalled()
  })
})

function createFakeWebGl2Context(): WebGL2RenderingContext {
  const shader = {}
  const program = {}
  const buffer = {}
  const uniform = {}
  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLE_STRIP: 0x0005,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    createShader: vi.fn(() => shader),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => program),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => buffer),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn((_program, name: string) => ({ ...uniform, name })),
    deleteBuffer: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    drawArrays: vi.fn(),
    isContextLost: vi.fn(() => false)
  } as unknown as WebGL2RenderingContext
}
