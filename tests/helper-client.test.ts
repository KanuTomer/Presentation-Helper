import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))

const features = [
  'wasapi-system-loopback', 'device-selection', 'hold-shortcut', 'pcm16k-mono',
  'hook-ready', 'single-file-capture', 'bounded-capture', 'operation-ids', 'capture-limit-events'
]

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean { this.killed = true; queueMicrotask(() => this.emit('exit', 0, null)); return true }
}

function responder(onCommand: (command: Record<string, unknown>, child: FakeChild) => void) {
  const child = new FakeChild()
  let pending = ''
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString()
    for (;;) {
      const lineEnd = pending.indexOf('\n')
      if (lineEnd < 0) break
      const line = pending.slice(0, lineEnd); pending = pending.slice(lineEnd + 1)
      onCommand(JSON.parse(line), child)
    }
  })
  return child
}

function send(child: FakeChild, event: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(event)}\n`)
}

describe('Windows helper client protocol', () => {
  it('requires protocol v2 features and reaches ready', async () => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
      if (command.type === 'shutdown') {
        send(process, { type: 'shutdownComplete', requestId: command.requestId })
        queueMicrotask(() => process.emit('exit', 0, null))
      }
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    await expect(client.start()).resolves.toBe(true)
    expect(client.state).toBe('ready')
    expect(client.features).toEqual(features)
    await client.stopProcess()
    expect(client.state).toBe('missing')
  })

  it('rejects a protocol mismatch or missing required feature', async () => {
    const protocolChild = responder((command, process) => {
      send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 1, shortcutReady: true, features })
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const protocol = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => protocolChild) as never })
    await expect(protocol.start()).resolves.toBe(false)
    expect(protocol.lastError).toMatch(/unsupported helper protocol/i)

    const featureChild = responder((command, process) => {
      send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features: features.slice(0, -1) })
    })
    const feature = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => featureChild) as never })
    await expect(feature.start()).resolves.toBe(false)
    expect(feature.lastError).toMatch(/missing required features/i)
  })

  it('rejects a handshake whose keyboard hook is not ready and catches synchronous spawn failures', async () => {
    const hookChild = responder((command, process) => {
      send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: false, features })
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const hook = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => hookChild) as never })
    await expect(hook.start()).resolves.toBe(false)
    expect(hook.lastError).toMatch(/keyboard hook is not ready/i)

    const spawnFailure = new HelperClient({
      executablePath: () => process.execPath,
      spawnProcess: (() => { throw new Error('sensitive provider detail') }) as never
    })
    await expect(spawnFailure.start()).resolves.toBe(false)
    expect(spawnFailure.lastError).toBe('Windows helper could not be launched.')
  })

  it('preserves an unsolicited fatal keyboard-hook startup error without treating it as an idle crash', async () => {
    const child = responder((command, process) => {
      if (command.type !== 'hello') return
      send(process, {
        type: 'error', code: 'shortcut_hook_unavailable', message: 'native provider detail', fatal: true
      })
      queueMicrotask(() => process.emit('exit', 1, null))
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    const crashed = vi.fn(); client.onUnexpectedExit = crashed

    await expect(client.start()).resolves.toBe(false)

    expect(client.state).toBe('failed')
    expect(client.lastError).toMatch(/shortcut hook could not be installed/i)
    expect(client.lastError).not.toContain('native provider detail')
    expect(crashed).not.toHaveBeenCalled()
  })

  it('routes one operation-scoped native safety-limit event', async () => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    const limit = vi.fn(); client.onCaptureLimitReached = limit
    await client.start()
    send(child, { type: 'captureLimitReached', operationId: 'active-op', reason: 'maximum_size' })
    await vi.waitFor(() => expect(limit).toHaveBeenCalledWith('active-op', 'maximum_size'))
  })

  it('surfaces typed helper errors and ignores duplicate terminal replies', async () => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
      if (command.type === 'startCapture') {
        send(process, { type: 'error', requestId: command.requestId, operationId: command.operationId, code: 'device_unavailable', message: 'Output unavailable.' })
        send(process, { type: 'captureStarted', requestId: command.requestId, operationId: command.operationId })
      }
    })
    const { HelperClient, HelperClientError } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    await client.start()
    await expect(client.command({ type: 'startCapture', operationId: 'one' }, ['captureStarted', 'error'])).rejects.toEqual(
      expect.objectContaining<Partial<InstanceType<typeof HelperClientError>>>({ code: 'device_unavailable', message: 'Output unavailable.' })
    )
  })

  it('rejects pending work and reports an unexpected crash once', async () => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    const crashed = vi.fn(); client.onUnexpectedExit = crashed
    await client.start()
    const pending = client.command({ type: 'listDevices' }, ['deviceList', 'error'])
    child.emit('exit', 7, null)
    await expect(pending).rejects.toMatchObject({ code: 'helper_exited' })
    expect(client.state).toBe('failed')
    expect(crashed).toHaveBeenCalledTimes(1)
  })

  it('classifies a command timeout once and ignores its late matching reply', async () => {
    let timedOutRequestId = ''
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
      if (command.type === 'stopCapture') timedOutRequestId = String(command.requestId)
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    await client.start()

    vi.useFakeTimers()
    const pending = client.command({ type: 'stopCapture', operationId: 'timed-out' }, ['captureStopped', 'error'], 100)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'helper_timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    const stateChanged = vi.fn(); client.onState = stateChanged
    send(child, { type: 'captureStopped', requestId: timedOutRequestId, operationId: 'timed-out' })
    await vi.runAllTicks()
    expect(stateChanged).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it.each([
    ['malformed', '{not-json'],
    ['oversized', 'x'.repeat(65_537)]
  ])('treats %s protocol output during capture as fatal and settles pending work', async (_label, corruptLine) => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    const crashed = vi.fn(); client.onUnexpectedExit = crashed
    await client.start()
    client.setLifecycle('capturing')
    const pending = client.command({ type: 'stopCapture', operationId: 'active' }, ['captureStopped', 'error'], 30_000)

    child.stdout.write(`${corruptLine}\n`)

    await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
    await vi.waitFor(() => expect(child.killed).toBe(true))
    expect(client.state).toBe('failed')
    expect(crashed).toHaveBeenCalledTimes(1)
  })

  it('keeps helper startup bounded with an injectable cold-start timeout', async () => {
    const child = responder(() => undefined)
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({
      executablePath: () => process.execPath,
      spawnProcess: (() => child) as never,
      startupTimeoutMs: 100
    })
    vi.useFakeTimers()
    const starting = client.start()
    await vi.advanceTimersByTimeAsync(100)
    await expect(starting).resolves.toBe(false)
    expect(client.state).toBe('failed')
    expect(client.lastError).toMatch(/timed out/i)
    vi.useRealTimers()
  })

  it('settles every pending command and reports only one crash when error and exit both fire', async () => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    const crashed = vi.fn(); client.onUnexpectedExit = crashed
    await client.start()
    const first = client.command({ type: 'listDevices' }, ['deviceList', 'error'])
    const second = client.command({ type: 'configureShortcut' }, ['shortcutConfigured', 'error'])
    child.emit('error', new Error('private native crash detail'))
    child.emit('exit', 7, null)
    await expect(first).rejects.toMatchObject({ code: 'helper_exited' })
    await expect(second).rejects.toMatchObject({ code: 'helper_exited' })
    expect(crashed).toHaveBeenCalledTimes(1)
    expect(client.lastError).toBe('Windows helper could not be launched.')
  })

  it('drains bounded stderr and rejects commands after an intentional shutdown', async () => {
    const child = responder((command, process) => {
      if (command.type === 'hello') send(process, { type: 'ready', requestId: command.requestId, protocolVersion: 2, shortcutReady: true, features })
      if (command.type === 'shutdown') {
        send(process, { type: 'shutdownComplete', requestId: command.requestId })
        queueMicrotask(() => process.emit('exit', 0, null))
      }
    })
    const { HelperClient } = await import('../src/main/audio/helperClient')
    const client = new HelperClient({ executablePath: () => process.execPath, spawnProcess: (() => child) as never })
    const crashed = vi.fn(); client.onUnexpectedExit = crashed
    await client.start()
    child.stderr.write(`${'x'.repeat(700)}\n`)
    await vi.waitFor(() => expect(client.lastError).toHaveLength(600))
    await client.stopProcess()
    expect(crashed).not.toHaveBeenCalled()
    await expect(client.command({ type: 'listDevices' }, ['deviceList'])).rejects.toMatchObject({ code: 'helper_unavailable' })
  })
})
