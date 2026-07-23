import React, { useEffect, useRef, useState } from 'react'

export const LIQUID_GLASS_MAX_DPR = 1.5
export const LIQUID_GLASS_MAX_FPS = 30

export type LiquidGlassStatus =
  | 'initializing'
  | 'ready'
  | 'context-lost'
  | 'fallback'

export interface LiquidGlassLayerProps {
  neonIntensity: number
  className?: string
  onStatusChange?: (status: LiquidGlassStatus) => void
}

export interface LiquidGlassBackingSize {
  width: number
  height: number
  pixelRatio: number
}

interface LiquidGlassResources {
  program: WebGLProgram
  vertexBuffer: WebGLBuffer
  position: number
  resolution: WebGLUniformLocation | null
  time: WebGLUniformLocation | null
  intensity: WebGLUniformLocation | null
}

export interface LiquidGlassEngine {
  setIntensity: (value: number) => void
  setReducedMotion: (reduced: boolean) => void
  dispose: () => void
}

const vertexShaderSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const fragmentShaderSource = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_intensity;
out vec4 out_color;

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

float noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), local.x),
    mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0)), local.x),
    local.y
  );
}

float fbm(vec2 point) {
  float value = 0.0;
  float amplitude = 0.55;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int octave = 0; octave < 3; octave++) {
    value += amplitude * noise(point);
    point = turn * point * 2.03 + 11.7;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 uv = v_uv;
  vec2 centered = (uv - 0.5) * vec2(aspect, 1.0);
  float time = u_time * 0.16;

  vec2 flow = vec2(
    fbm(centered * 2.1 + vec2(time, -time * 0.65)),
    fbm(centered * 2.4 + vec2(-time * 0.72, time * 0.48))
  ) - 0.5;

  vec2 warped = centered + flow * 0.19;
  float waves = sin(warped.x * 9.0 + time * 5.0)
    + sin((warped.x + warped.y) * 12.0 - time * 4.2);
  float caustic = pow(clamp(0.5 + waves * 0.23, 0.0, 1.0), 5.0);
  caustic += pow(clamp(fbm(warped * 5.0 + vec2(time)) * 1.18, 0.0, 1.0), 8.0);

  float radial = length(centered);
  float lensRim = smoothstep(0.72, 0.45, radial)
    * smoothstep(0.14, 0.42, radial);
  float diagonal = smoothstep(0.62, 0.0, abs(warped.y + warped.x * 0.38 - 0.08));

  vec3 cobalt = vec3(0.16, 0.36, 1.0);
  vec3 violet = vec3(0.62, 0.23, 1.0);
  vec3 ice = vec3(0.58, 0.90, 1.0);
  vec3 color = mix(cobalt, violet, smoothstep(-0.48, 0.62, warped.x + flow.y));
  color += ice * caustic * 0.72;
  color += mix(violet, ice, uv.x) * diagonal * 0.13;
  color += vec3(0.82, 0.91, 1.0) * lensRim * 0.16;

  float energy = clamp(caustic * 0.62 + diagonal * 0.12 + lensRim * 0.28, 0.0, 1.0);
  float edgeBias = mix(0.42, 1.0, smoothstep(0.24, 0.78, radial));
  float alpha = u_intensity * (0.025 + energy * 0.17) * edgeBias;
  out_color = vec4(color * u_intensity, alpha);
}
`

export function clampNeonIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function computeLiquidGlassBackingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = 1
): LiquidGlassBackingSize {
  const pixelRatio = Math.min(
    LIQUID_GLASS_MAX_DPR,
    Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1)
  )
  return {
    width: Math.max(1, Math.round(Math.max(0, cssWidth) * pixelRatio)),
    height: Math.max(1, Math.round(Math.max(0, cssHeight) * pixelRatio)),
    pixelRatio
  }
}

export function shouldAnimateLiquidGlass(
  documentVisible: boolean,
  reducedMotion: boolean
): boolean {
  return documentVisible && !reducedMotion
}

export function shouldRenderLiquidGlassFrame(now: number, lastRenderedAt: number): boolean {
  return now - lastRenderedAt >= 1_000 / LIQUID_GLASS_MAX_FPS
}

export function liquidGlassStatusClass(status: LiquidGlassStatus): string {
  return `liquid-glass--${status}`
}

function compileShader(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(kind)
  if (!shader) throw new Error('Unable to allocate the liquid-glass shader.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || 'Unknown compilation failure.'
    gl.deleteShader(shader)
    throw new Error(`Unable to compile the liquid-glass shader: ${detail}`)
  }
  return shader
}

function createResources(gl: WebGL2RenderingContext): LiquidGlassResources {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error('Unable to allocate the liquid-glass program.')
  }

  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) || 'Unknown link failure.'
    gl.deleteProgram(program)
    throw new Error(`Unable to link the liquid-glass program: ${detail}`)
  }

  const vertexBuffer = gl.createBuffer()
  if (!vertexBuffer) {
    gl.deleteProgram(program)
    throw new Error('Unable to allocate the liquid-glass geometry.')
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  )

  return {
    program,
    vertexBuffer,
    position: gl.getAttribLocation(program, 'a_position'),
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    time: gl.getUniformLocation(program, 'u_time'),
    intensity: gl.getUniformLocation(program, 'u_intensity')
  }
}

function deleteResources(
  gl: WebGL2RenderingContext,
  resources: LiquidGlassResources | undefined
): void {
  if (!resources) return
  gl.deleteBuffer(resources.vertexBuffer)
  gl.deleteProgram(resources.program)
}

export function createLiquidGlassEngine(
  canvas: HTMLCanvasElement,
  options: {
    neonIntensity: number
    reducedMotion: boolean
    onStatusChange: (status: LiquidGlassStatus) => void
  }
): LiquidGlassEngine | undefined {
  let gl: WebGL2RenderingContext | null
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: false,
      premultipliedAlpha: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
      stencil: false
    })
  } catch {
    gl = null
  }

  if (!gl) {
    options.onStatusChange('fallback')
    return undefined
  }

  let resources: LiquidGlassResources | undefined
  let intensity = clampNeonIntensity(options.neonIntensity)
  let reducedMotion = options.reducedMotion
  let disposed = false
  let animationFrame: number | undefined
  let startedAt = performance.now()
  let lastRenderedAt = Number.NEGATIVE_INFINITY

  const isVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden'

  const resize = (): void => {
    if (!gl) return
    const bounds = canvas.getBoundingClientRect()
    const size = computeLiquidGlassBackingSize(
      bounds.width || canvas.clientWidth,
      bounds.height || canvas.clientHeight,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio
    )
    if (canvas.width !== size.width) canvas.width = size.width
    if (canvas.height !== size.height) canvas.height = size.height
    gl.viewport(0, 0, size.width, size.height)
  }

  const cancelAnimation = (): void => {
    if (animationFrame === undefined) return
    cancelAnimationFrame(animationFrame)
    animationFrame = undefined
  }

  const draw = (now: number): void => {
    animationFrame = undefined
    if (disposed || !gl || !resources || gl.isContextLost()) return
    if (!shouldRenderLiquidGlassFrame(now, lastRenderedAt)) {
      if (shouldAnimateLiquidGlass(isVisible(), reducedMotion)) {
        animationFrame = requestAnimationFrame(draw)
      }
      return
    }
    lastRenderedAt = now
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(resources.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertexBuffer)
    if (resources.position >= 0) {
      gl.enableVertexAttribArray(resources.position)
      gl.vertexAttribPointer(resources.position, 2, gl.FLOAT, false, 0, 0)
    }
    gl.uniform2f(resources.resolution, canvas.width, canvas.height)
    gl.uniform1f(resources.time, reducedMotion ? 0 : (now - startedAt) / 1000)
    gl.uniform1f(resources.intensity, intensity)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    if (shouldAnimateLiquidGlass(isVisible(), reducedMotion)) {
      animationFrame = requestAnimationFrame(draw)
    }
  }

  const render = (): void => {
    cancelAnimation()
    if (!disposed && isVisible()) animationFrame = requestAnimationFrame(draw)
  }

  const initialize = (): boolean => {
    if (!gl) return false
    try {
      deleteResources(gl, resources)
      resources = createResources(gl)
      startedAt = performance.now()
      lastRenderedAt = Number.NEGATIVE_INFINITY
      resize()
      options.onStatusChange('ready')
      render()
      return true
    } catch {
      resources = undefined
      options.onStatusChange('fallback')
      cancelAnimation()
      return false
    }
  }

  const handleVisibility = (): void => {
    if (isVisible()) render()
    else cancelAnimation()
  }
  const handleResize = (): void => {
    resize()
    render()
  }
  const handleContextLost = (event: Event): void => {
    event.preventDefault()
    resources = undefined
    cancelAnimation()
    options.onStatusChange('context-lost')
  }
  const handleContextRestored = (): void => {
    if (!disposed) initialize()
  }

  canvas.addEventListener('webglcontextlost', handleContextLost)
  canvas.addEventListener('webglcontextrestored', handleContextRestored)
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('resize', handleResize)

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(handleResize)
  resizeObserver?.observe(canvas)
  initialize()

  return {
    setIntensity(value: number): void {
      intensity = clampNeonIntensity(value)
      if (!shouldAnimateLiquidGlass(isVisible(), reducedMotion)) render()
    },
    setReducedMotion(reduced: boolean): void {
      reducedMotion = reduced
      render()
    },
    dispose(): void {
      disposed = true
      cancelAnimation()
      resizeObserver?.disconnect()
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('resize', handleResize)
      if (gl && !gl.isContextLost()) deleteResources(gl, resources)
      resources = undefined
    }
  }
}

export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia(query)
    const update = (): void => setReduced(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  return reduced
}

export function LiquidGlassLayer({
  neonIntensity,
  className,
  onStatusChange
}: LiquidGlassLayerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<LiquidGlassEngine | undefined>(undefined)
  const statusCallbackRef = useRef(onStatusChange)
  const [status, setStatus] = useState<LiquidGlassStatus>('initializing')
  const reducedMotion = usePrefersReducedMotion()

  statusCallbackRef.current = onStatusChange

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const updateStatus = (nextStatus: LiquidGlassStatus): void => {
      setStatus(nextStatus)
      statusCallbackRef.current?.(nextStatus)
    }
    engineRef.current = createLiquidGlassEngine(canvas, {
      neonIntensity,
      reducedMotion,
      onStatusChange: updateStatus
    })
    return () => {
      engineRef.current?.dispose()
      engineRef.current = undefined
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setIntensity(neonIntensity)
  }, [neonIntensity])

  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion)
  }, [reducedMotion])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      tabIndex={-1}
      className={[
        'liquid-glass-layer',
        liquidGlassStatusClass(status),
        className
      ].filter(Boolean).join(' ')}
      data-liquid-glass-status={status}
      data-neon-intensity={clampNeonIntensity(neonIntensity)}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'block',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        background: 'transparent'
      }}
    />
  )
}
