import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { imageDescribeProjection } from '../src/projection.ts'

function createSession(...args: Parameters<typeof Session.create>): Session {
  args[4] = [imageOffloadProjection, imageDescribeProjection]
  return Session.create(...args)
}

const image: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

function input(session: Session, content: ContentBlock[] = [image, image]) {
  return session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function descriptions(session: Session): Array<string | undefined> {
  const result: Array<string | undefined> = []
  for (const message of session.deriveMessages()) {
    for (const block of message.content) {
      if (block.type === 'image') result.push(block.description)
    }
  }
  return result
}

describe('durable image descriptions', () => {
  it('preserves message identity, original data, and previously derived snapshots', () => {
    const session = createSession(SessionId('images'))
    const source = input(session, [
      { type: 'text', text: 'before' }, image,
      image, { type: 'text', text: 'after' },
      { type: 'text', text: 'unchanged' },
      image,
    ])
    const before = session.deriveMessages()
    session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 1, description: 'a red square' }] })
    expect(descriptions(session)).toEqual([undefined, 'a red square', undefined])
    const after = session.deriveMessages()
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(after[0]).toBe(session.deriveEventMessage(source))
    expect(Object.isFrozen(after[0])).toBe(true)
    expect(Object.isFrozen(after[0]?.content)).toBe(true)
    expect(after[0]?.content[0]).toBe(before[0]?.content[0])
    expect(after[0]?.content[3]).toBe(before[0]?.content[3])
    expect(JSON.stringify(source)).not.toContain('a red square')
    expect(JSON.stringify(before)).not.toContain('a red square')
    expect(session.surface.nodes).toEqual([source.seq])
    expect(session.surface.replaceGeneration).toBe(0)
    expect(session.surface.contentGeneration).toBe(1)
    expect(session.deriveEventMessage(session.snapshotEvents().at(-1)!)).toBeNull()
    session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 0, description: 'a blue circle' }] })
    expect(descriptions(session)).toEqual(['a blue circle', 'a red square', undefined])
    expect(session.surface.contentGeneration).toBe(2)
    expect(after[0]).not.toBe(session.deriveMessages()[0])
  })

  it('reconstructs the same descriptions through pure folding, resume, restore, and fork', () => {
    const session = createSession(SessionId('source'))
    const source = input(session)
    const before = session.snapshotEvents()
    session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 0, description: 'a red square' }] })
    const events = session.snapshotEvents()
    const fold = foldSurface(events, [imageDescribeProjection])
    expect(deriveEventMessage(source, fold.projectedMessages)).toEqual(session.deriveMessages()[0])
    expect(descriptions(createSession(SessionId('before'), before))).toEqual([undefined, undefined])
    expect(descriptions(createSession(SessionId('resume'), events))).toEqual(['a red square', undefined])
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'shared-frozen', [imageDescribeProjection])
    expect(descriptions(restored)).toEqual(['a red square', undefined])
    const childId = SessionId('child')
    const child = createSession(childId, events, {
      ...session.header, id: childId, parentSession: session.id, isSeeded: true,
    }, SessionLogOffset(events.length))
    expect(descriptions(child)).toEqual(['a red square', undefined])
    input(child, [image])
    expect(descriptions(child)).toEqual(['a red square', undefined, undefined])
    expect(descriptions(session)).toEqual(['a red square', undefined])
  })

  it('counts all images in a tool result without changing its call identity', () => {
    const session = createSession(SessionId('tool'))
    const source = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('shot'), isError: false, content: [image, image] }),
    }, { surfaceOp: 'append' })
    session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 1, description: 'a red square' }] })
    expect(descriptions(session)).toEqual([undefined, 'a red square'])
    expect(session.deriveEventMessage(source)?.source).toEqual(source.data.message.source)
  })

  it.each([
    null, {}, { targets: [] }, { targets: 'bad' }, { targets: [null] },
    { targets: [{ seq: 0, imageIndex: 0 }] },
    { targets: [{ seq: 0, imageIndex: 0, description: '' }] },
    { targets: [{ seq: 0, imageIndex: 0, description: 7 }] },
    { targets: [{ seq: 0, imageIndex: 0, description: 'a red square', extra: true }] },
    { targets: [{ seq: 0, imageIndex: 0, description: 'a red square' }], extra: true },
    { targets: [{ seq: -1, imageIndex: 0, description: 'a red square' }] },
    { targets: [{ seq: 0, imageIndex: -1, description: 'a red square' }] },
    { targets: [{ seq: 0, imageIndex: 0.5, description: 'a red square' }] },
    { targets: [{ seq: 0, imageIndex: '0', description: 'a red square' }] },
    { targets: [{ seq: 0, imageIndex: 1, description: 'a red square' }, { seq: 0, imageIndex: 0, description: 'a blue circle' }] },
    { targets: [{ seq: 0, imageIndex: 0, description: 'a red square' }, { seq: 0, imageIndex: 0, description: 'a blue circle' }] },
    { targets: [{ seq: 0, imageIndex: 2, description: 'a red square' }] },
    { targets: [{ seq: 1, imageIndex: 0, description: 'a red square' }] },
  ])('rejects malformed decisions at append and replay without partial application: %j', (data) => {
    const session = createSession(SessionId('invalid'))
    input(session)
    const events = session.snapshotEvents()
    const candidate = { type: 'image/describe', seq: SessionSeq(1), time: 0, data } as SessionEvent
    expect(() => session.append('image/describe', data as SessionEventMap['image/describe'])).toThrow(/image\/describe/)
    expect(() => createSession(SessionId('seed'), [...events, candidate])).toThrow(/image\/describe/)
    expect(() => foldSurface([...events, candidate], [imageDescribeProjection])).toThrow(/image\/describe/)
    expect(session.snapshotEvents()).toEqual(events)
    expect(descriptions(session)).toEqual([undefined, undefined])
    expect(session.surface.contentGeneration).toBe(0)
    session.append('image/describe', { targets: [{ seq: SessionSeq(0), imageIndex: 1, description: 'a red square' }] })
    expect(descriptions(session)).toEqual([undefined, 'a red square'])
  })

  it('rejects repeated descriptions, offloaded targets, and shadowed or assistant nodes', () => {
    const session = createSession(SessionId('invalid-targets'))
    const source = input(session)
    session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 0, description: 'a red square' }] })
    expect(() => session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 0, description: 'a blue circle' }] })).toThrow(/already described/)
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [1] }] })
    expect(() => session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 1, description: 'a red square' }] })).toThrow(/already offloaded/)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq],
    })
    expect(() => session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 0, description: 'a red square' }] })).toThrow(/not a current/)
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [image], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    expect(() => session.append('image/describe', { targets: [{ seq: assistant.seq, imageIndex: 0, description: 'a red square' }] })).toThrow(/must be user\/message/)
  })
})
