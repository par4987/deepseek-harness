import { describe, expect, it, vi } from 'vitest'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type { DescribeChain, DescribeLogger } from '../src/chain.ts'
import { describeUndescribedImages } from '../src/image-describe.ts'
import { imageDescribeProjection } from '../src/projection.ts'

function createSession(...args: Parameters<typeof Session.create>): Session {
  args[4] = [imageOffloadProjection, imageDescribeProjection]
  return Session.create(...args)
}

const red: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}
const blue: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'b'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

/** A chain whose stream records every describe request and answers the given text. */
function answeringChain(text: string): { chain: DescribeChain; describeRequests: Array<{ provider: string; model: string }> } {
  const describeRequests: Array<{ provider: string; model: string }> = []
  const chain: DescribeChain = {
    routes: [{ provider: 'xkiro', model: 'vl' }],
    routeStrategy: 'chain',
    describePrompt: 'describe it',
    maxChars: 2048,
    describeTimeoutMs: 200,
    selected: { provider: 'text-only', model: 'm' },
    signal: undefined,
    logger: { warn: vi.fn(), info: vi.fn() } satisfies DescribeLogger,
    visionInventory: async () => [],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text', 'image'] }),
    stream: async function* (options) {
      describeRequests.push({ provider: options.provider, model: options.model })
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { chain, describeRequests }
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

describe('describeUndescribedImages', () => {
  it('describes one attachment once and marks every occurrence with the same text', async () => {
    const session = createSession(SessionId('dedup'))
    session.append('user/message', createUserMessage({ content: [red, blue, red], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const { chain, describeRequests } = answeringChain('the description')
    const described = await describeUndescribedImages(session, chain)
    expect(described).toBe(2)
    expect(describeRequests).toHaveLength(2)
    expect(descriptions(session)).toEqual(['the description', 'the description', 'the description'])
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('image/describe')
    if (event?.type !== 'image/describe') return
    // The walk groups by attachment; the recorded decision restores request order.
    expect(event.data.targets).toEqual([
      { seq: 0, imageIndex: 0, description: 'the description' },
      { seq: 0, imageIndex: 1, description: 'the description' },
      { seq: 0, imageIndex: 2, description: 'the description' },
    ])
  })

  it('walks user and tool-result nodes in surface order', async () => {
    const session = createSession(SessionId('mixed'))
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('shot'), isError: false, content: [red] }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [blue], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const { chain, describeRequests } = answeringChain('the description')
    expect(await describeUndescribedImages(session, chain)).toBe(2)
    expect(describeRequests).toHaveLength(2)
    expect(descriptions(session)).toEqual(['the description', 'the description'])
  })

  it('skips described and offloaded occurrences and appends nothing when none remain', async () => {
    const session = createSession(SessionId('already'))
    const source = session.append('user/message', createUserMessage({ content: [red, red], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('image/describe', { targets: [{ seq: source.seq, imageIndex: 0, description: 'done already' }] })
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [1] }] })
    const { chain, describeRequests } = answeringChain('the description')
    expect(await describeUndescribedImages(session, chain)).toBe(0)
    expect(describeRequests).toHaveLength(0)
    expect(session.snapshotEvents().at(-1)?.type).not.toBe('image/describe')
  })

  it('appends nothing when no candidate route resolves', async () => {
    const session = createSession(SessionId('dead-chain'))
    session.append('user/message', createUserMessage({ content: [red], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const { chain } = answeringChain('the description')
    const dead: DescribeChain = {
      ...chain,
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
    }
    expect(await describeUndescribedImages(session, dead)).toBe(0)
    expect(session.snapshotEvents().at(-1)?.type).toBe('user/message')
  })

  it('leaves occurrences without an answer for the deterministic projection', async () => {
    const session = createSession(SessionId('partial'))
    session.append('user/message', createUserMessage({ content: [red, blue], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const chain: DescribeChain = {
      ...answeringChain('the description').chain,
      stream: async function* (options) {
        const block = options.messages[0]?.content[0]
        if (block?.type === 'image' && String(block.attachment.attachmentId) === String(red.attachment.attachmentId)) {
          yield { type: 'text-delta', index: 0, text: 'red answer' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } else {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no balance', code: 'INSUFFICIENT_BALANCE' } } }
        }
      },
    }
    const described = await describeUndescribedImages(session, chain)
    expect(described).toBe(1)
    expect(descriptions(session)).toEqual(['red answer', undefined])
  })
})
