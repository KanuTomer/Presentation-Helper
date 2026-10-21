import { describe, expect, it, vi } from 'vitest'
import { SnapshotController } from '../src/main/snapshots/controller'
import { SnapshotStore } from '../src/main/snapshots/store'
import { OperationCoordinator } from '../src/main/operations/coordinator'
import type { AiService } from '../src/main/ai/service'
import type { TransmissionPreviewGate } from '../src/main/privacy/transmissionPreview'

function harness() {
  const operations = new OperationCoordinator({ register: vi.fn(() => true), unregister: vi.fn() })
  const frames = new SnapshotStore(async () => ({ bytes: Buffer.from('image'), width: 100, height: 100, mime: 'image/png' }))
  const ai = { retrieveSnapshot: vi.fn(() => []), generate: vi.fn(async () => ({ responseStyle: 'solution', task: 'clarification' })) }
  const preview = { present: vi.fn(async () => undefined), clear: vi.fn() }
  return { operations, frames, ai, preview, controller: new SnapshotController(frames, ai as unknown as AiService, operations, preview as unknown as TransmissionPreviewGate) }
}
describe('screenshot attachment lifecycle', () => {
  it('attaches without a model call, then answers the typed question with the image', async () => {
    const h = harness()
    for (let index = 0; index < 2; index++) {
      const attached = await h.controller.attach()
      expect(h.ai.generate).toHaveBeenCalledTimes(index)
      await expect(h.controller.ask(index ? '' : 'Why does this print NaN?', attached.id)).resolves.toMatchObject({ ok: true })
      expect(h.frames.has(attached.id)).toBe(false); expect(h.operations.isBusy).toBe(false)
    }
    expect(h.ai.generate.mock.calls[0]![0]).toContain('Why does this print NaN?')
    // The typed text drives document retrieval too, not only the prompt.
    expect(h.ai.retrieveSnapshot.mock.calls[0]).toEqual([expect.stringContaining('Why does this print NaN?'), 'Why does this print NaN?', expect.anything()])
    expect(h.ai.generate.mock.calls[1]![0]).toContain('Identify and solve the primary visible problem')
    expect(h.preview.present).toHaveBeenCalledWith(expect.objectContaining({ screenshot: true }))
    expect(h.ai.generate.mock.calls[0]![2]).toMatchObject({ snapshotDataUrl: expect.stringMatching(/^data:image[/]png;base64,/) })
  })
  it('blocks typed/audio overlap without deleting the attachment', async () => {
    const h = harness(); const attached = await h.controller.attach(); const typed = h.operations.begin('typed', 'retrieving')
    await expect(h.controller.ask('', attached.id)).resolves.toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(h.frames.has(attached.id)).toBe(true); expect(h.ai.generate).not.toHaveBeenCalled()
    await h.operations.finish(typed.id, 'success'); h.frames.clear()
  })
  it('requires a rendered context preview and clears the image when cancelled', async () => {
    const h = harness(); const attached = await h.controller.attach()
    let acknowledged!: () => void
    h.preview.present.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledged = resolve }))
    const pending = h.controller.ask('', attached.id)
    await vi.waitFor(() => expect(h.preview.present).toHaveBeenCalled())
    expect(h.ai.generate).not.toHaveBeenCalled(); await h.operations.cancel(); acknowledged()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(h.ai.generate).not.toHaveBeenCalled(); expect(h.frames.has(attached.id)).toBe(false); expect(h.operations.isBusy).toBe(false)
  })
  it('rejects a removed or expired attachment', async () => {
    const h = harness(); const attached = await h.controller.attach(); h.frames.clear()
    await expect(h.controller.ask('', attached.id)).resolves.toMatchObject({ ok: false })
    expect(h.ai.generate).not.toHaveBeenCalled()
  })
})
