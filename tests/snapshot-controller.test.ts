import { describe, expect, it, vi } from 'vitest'
import { SnapshotController } from '../src/main/snapshots/controller'
import { SnapshotStore } from '../src/main/snapshots/store'
import { OperationCoordinator } from '../src/main/operations/coordinator'
import type { AiService } from '../src/main/ai/service'
import type { TransmissionPreviewGate } from '../src/main/privacy/transmissionPreview'

function harness() {
  const operations = new OperationCoordinator({ register: vi.fn(() => true), unregister: vi.fn() })
  const frames = new SnapshotStore({ monitors: () => [{ id: '1', name: 'Display', current: true, width: 100, height: 100 }], capture: async () => ({ bytes: Buffer.from('image'), width: 100, height: 100, mime: 'image/png' }) })
  const ai = { retrieveSnapshot: vi.fn(() => []), generate: vi.fn(async () => ({ responseStyle: 'solution', task: 'clarification' })) }
  const preview = { present: vi.fn(async () => undefined), clear: vi.fn() }
  return { operations, frames, ai, preview, controller: new SnapshotController(frames, ai as unknown as AiService, operations, preview as unknown as TransmissionPreviewGate) }
}
describe('snapshot operation lifecycle', () => {
  it('does not retrieve or generate during capture; supports two complete requests', async () => {
    const h = harness()
    for (let index = 0; index < 2; index++) {
      const frame = await h.controller.capture()
      expect(h.ai.generate).toHaveBeenCalledTimes(index)
      expect(h.ai.retrieveSnapshot).toHaveBeenCalledTimes(index)
      await expect(h.controller.solve(frame.id)).resolves.toMatchObject({ ok: true })
      expect(() => h.frames.get(frame.id)).toThrow(); expect(h.operations.isBusy).toBe(false)
    }
    expect(h.ai.generate).toHaveBeenCalledTimes(2)
  })
  it('blocks typed/audio overlap without deleting the active frame', async () => {
    const h = harness(); const frame = await h.controller.capture(); const typed = h.operations.begin('typed', 'retrieving')
    await expect(h.controller.solve(frame.id)).resolves.toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(h.frames.get(frame.id).id).toBe(frame.id); expect(h.ai.generate).not.toHaveBeenCalled(); await h.operations.finish(typed.id, 'success'); h.frames.clear()
  })
  it('requires a rendered context preview and cleans up a cancelled Send', async () => {
    const h = harness(); const frame = await h.controller.capture()
    let acknowledged!: () => void
    h.preview.present.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledged = resolve }))
    const pending = h.controller.solve(frame.id)
    await vi.waitFor(() => expect(h.preview.present).toHaveBeenCalled())
    expect(h.ai.generate).not.toHaveBeenCalled(); await h.operations.cancel(); acknowledged()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(h.ai.generate).not.toHaveBeenCalled(); expect(() => h.frames.get(frame.id)).toThrow(); expect(h.operations.isBusy).toBe(false)
  })
  it('cleans up after failure and allows explicit retry through a new snapshot', async () => {
    const h = harness(); const frame = await h.controller.capture(); h.ai.generate.mockRejectedValueOnce(new Error('network'))
    await expect(h.controller.solve(frame.id)).resolves.toMatchObject({ ok: false }); expect(() => h.frames.get(frame.id)).toThrow()
    const retry = await h.controller.capture(); await expect(h.controller.solve(retry.id)).resolves.toMatchObject({ ok: true })
  })
})
