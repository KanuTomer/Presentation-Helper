import React, { useEffect, useRef, useState } from 'react'
import type { GlassDisplay } from '../shared/contracts'

const VERTEX = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * .5 + .5; vUv.y = 1. - vUv.y; gl_Position = vec4(aPos, 0., 1.); }`

// One pass: soft lens edge, haze-scaled warp, mip-matched disc blur, dark tint, rim light.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uScene; uniform vec4 uCrop; uniform vec2 uSize; uniform float uHaze; uniform vec2 uTexel;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
vec3 sampleScene(vec2 uv, float lod) { return textureLod(uScene, uCrop.xy + clamp(uv, 0., 1.) * uCrop.zw, lod).rgb; }
void main() {
  vec2 px = vUv * uSize;
  float d = min(min(px.x, uSize.x - px.x), min(px.y, uSize.y - px.y));
  float edge = 1. - smoothstep(0., 18., d);
  vec2 lens = -(vUv - .5) * edge * edge * .03;
  vec2 warp = (vec2(noise(px * .012), noise(px * .012 + 19.)) - .5) * uHaze * .03;
  vec2 uv = vUv + lens + warp;
  float radius = uHaze * 26. + edge * 1.5;
  vec2 stepSize = radius / uSize;
  float lod = max(log2(radius * uCrop.z / (uTexel.x * uSize.x) / 3. + 1e-4), 0.);
  vec3 color = vec3(0.);
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996, r = sqrt((float(i) + .5) / 16.);
    color += sampleScene(uv + vec2(cos(a), sin(a)) * r * stepSize, lod);
  }
  color /= 16.;
  color = mix(color, vec3(.035, .04, .055), .08 + uHaze * .5);
  float rim = (1. - smoothstep(0., 1.5, d)) * .25 + edge * edge * .05;
  color += rim * (.7 + .3 * (1. - vUv.y)) + (1. - vUv.y) * .05 * (1. - uHaze * .5);
  outColor = vec4(color, 1.);
}`

type GlassState = 'live' | 'fallback'

/**
 * Renders the screen behind the presenter as adjustable glass. Capture
 * protection keeps this window out of its own stream; frames stay on the GPU
 * and the capture stops whenever the presenter is hidden.
 */
export function LiquidGlass({ haze, enabled }: { haze: number; enabled: boolean }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const hazeRef = useRef(haze)
  const [state, setState] = useState<GlassState>('fallback')
  const [display, setDisplay] = useState<GlassDisplay>()
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const renderer = useRef<GlassRenderer | undefined>(undefined)

  useEffect(() => {
    hazeRef.current = haze
    renderer.current?.setHaze(haze)
    document.documentElement.style.setProperty('--haze', String(haze))
  }, [haze])
  useEffect(() => {
    document.documentElement.dataset.glass = state
  }, [state])
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    void window.presenter.getGlassDisplay().then(setDisplay).catch(() => undefined)
    const stop = window.presenter.onGlassDisplay((next) => setDisplay((current) => sameDisplay(current, next) ? current : next))
    return () => { document.removeEventListener('visibilitychange', update); stop() }
  }, [])
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches
    if (!enabled || reduced || !visible || !display || !canvas.current || !navigator.mediaDevices?.getDisplayMedia) { setState('fallback'); return }
    let cancelled = false
    const glass = GlassRenderer.create(canvas.current, display, hazeRef.current)
    if (!glass) { setState('fallback'); return }
    renderer.current = glass
    void glass.start().then(() => { if (!cancelled) setState('live') }, () => { if (!cancelled) setState('fallback') })
    return () => { cancelled = true; glass.dispose(); if (renderer.current === glass) renderer.current = undefined }
  }, [enabled, visible, display])
  return <canvas ref={canvas} className="liquid-glass" aria-hidden="true" hidden={state !== 'live'} />
}

function sameDisplay(left: GlassDisplay | undefined, right: GlassDisplay): boolean {
  return Boolean(left && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height)
}

class GlassRenderer {
  private video = document.createElement('video')
  private stream?: MediaStream
  private frameRequest = 0
  private videoRequest = 0
  private dirty = true
  private hasFrame = false
  private scaled?: boolean
  private lastGeometry = ''
  private disposed = false

  private constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    private program: WebGLProgram,
    private display: GlassDisplay,
    private haze: number
  ) {}

  static create(canvas: HTMLCanvasElement, display: GlassDisplay, haze: number): GlassRenderer | undefined {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', desynchronized: true })
    if (!gl) return undefined
    const program = compile(gl)
    if (!program) return undefined
    return new GlassRenderer(canvas, gl, program, display, haze)
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 60 } }, audio: false })
    if (this.disposed) { this.stop(); return }
    this.video.muted = true
    this.video.srcObject = this.stream
    await this.video.play()
    this.adaptResolution()
    this.videoRequest = this.video.requestVideoFrameCallback(this.onFrame)
    this.frameRequest = requestAnimationFrame(this.loop)
  }

  setHaze(haze: number): void { this.haze = haze; this.dirty = true; this.adaptResolution() }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameRequest)
    if (this.videoRequest) this.video.cancelVideoFrameCallback(this.videoRequest)
    this.stop()
    // Keep the context: the same canvas is reused when the capture restarts.
    this.gl.deleteProgram(this.program)
  }

  private stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    this.video.srcObject = null
  }

  /** Capture frames arrive only when the screen changes, so upload on arrival and redraw on move. */
  private readonly onFrame = (): void => {
    if (this.disposed) return
    const { gl } = this
    if (this.video.videoWidth) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video)
      gl.generateMipmap(gl.TEXTURE_2D)
      this.hasFrame = true
      this.dirty = true
    }
    this.videoRequest = this.video.requestVideoFrameCallback(this.onFrame)
  }

  /** Reads the window's own position each display frame instead of handling move events. */
  private readonly loop = (): void => {
    if (this.disposed) return
    const geometry = `${screenX},${screenY},${innerWidth},${innerHeight}`
    if (geometry !== this.lastGeometry) { this.lastGeometry = geometry; this.dirty = true }
    if (this.dirty && this.hasFrame) { this.dirty = false; this.draw() }
    this.frameRequest = requestAnimationFrame(this.loop)
  }

  private draw(): void {
    const { gl, canvas, display, video } = this
    const ratio = devicePixelRatio
    const width = Math.round(innerWidth * ratio), height = Math.round(innerHeight * ratio)
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    gl.viewport(0, 0, width, height)
    const uniform = (name: string) => gl.getUniformLocation(this.program, name)
    gl.uniform4f(uniform('uCrop'), (screenX - display.x) / display.width, (screenY - display.y) / display.height, innerWidth / display.width, innerHeight / display.height)
    gl.uniform2f(uniform('uSize'), innerWidth, innerHeight)
    gl.uniform2f(uniform('uTexel'), 1 / video.videoWidth, 1 / video.videoHeight)
    gl.uniform1f(uniform('uHaze'), this.haze)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Blur hides detail, so a hazy pane captures at half resolution. */
  private adaptResolution(): void {
    const track = this.stream?.getVideoTracks()[0]
    const scaled = this.haze > 0.35
    if (!track || scaled === this.scaled) return
    this.scaled = scaled
    const factor = (scaled ? 0.5 : 1) * devicePixelRatio
    void track.applyConstraints({ frameRate: { max: 60 }, width: { max: Math.round(this.display.width * factor) }, height: { max: Math.round(this.display.height * factor) } }).catch(() => undefined)
  }
}

function compile(gl: WebGL2RenderingContext): WebGLProgram | undefined {
  const shader = (type: number, source: string): WebGLShader | undefined => {
    const item = gl.createShader(type)
    if (!item) return undefined
    gl.shaderSource(item, source); gl.compileShader(item)
    return gl.getShaderParameter(item, gl.COMPILE_STATUS) ? item : undefined
  }
  const vertex = shader(gl.VERTEX_SHADER, VERTEX), fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  if (!vertex || !fragment || !program) return undefined
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return program
}
