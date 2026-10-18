import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, ImageBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describeAdmittedImages } from '../src/admission.ts'
import type { DescribeChain, DescribeLogger } from '../src/chain.ts'

const attachment = (id: string): ImageBlock => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${id.padStart(64, '0')}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
})

/** One per-route answer: the error sentinel or a plain text answer. */
type StubAnswer = 'error' | (string & {})

/** A stream stub keyed by `provider/model`; unlisted routes answer with the given text. */
function streamsByRoute(answers: Record<string, StubAnswer>): {
  calls: GenerateOptions[]
  stream: DescribeChain['stream']
} {
  const calls: GenerateOptions[] = []
  const stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    calls.push(options)
    const answer = answers[`${options.provider}/${options.model}`] ?? 'a red square'
    if (answer === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no balance', code: 'INSUFFICIENT_BALANCE' } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return { calls, stream }
}

function chain(over: Partial<DescribeChain> & { stream: DescribeChain['stream'] }): DescribeChain {
  return {
    routes: [{ provider: 'xkiro', model: 'vl' }],
    routeStrategy: 'chain',
    describePrompt: 'describe it',
    maxChars: 2048,
    describeTimeoutMs: 200,
    selected: { provider: 'text-only', model: 'm' },
    signal: undefined,
    logger: { warn: vi.fn(), info: vi.fn() } satisfies DescribeLogger,
    visionInventory: async () => [],
    resolveModelInfo: async (provider, model): Promise<LlmResolvedModelInfo> => ({ provider, id: model, name: model }),
    ...over,
  }
}

describe('describeAdmittedImages', () => {
  it('describes one attachment once and applies the same text to every occurrence', async () => {
    const shared = attachment('shared')
    const first = createUserMessage({ content: [shared, attachment('other'), shared], source: { kind: 'user' } })
    const second = createUserMessage({ content: [shared], source: { kind: 'user' } })
    const { calls, stream } = streamsByRoute({ 'xkiro/vl': 'described text' })
    const result = await describeAdmittedImages([first, second], chain({ stream }))
    expect(calls).toHaveLength(2)
    const blocks = result.flatMap(message => message.content.filter(block => block.type === 'image'))
    expect(blocks.map(block => block.description)).toEqual(['described text', 'described text', 'described text', 'described text'])
  })

  it('returns the same messages when no block is a retained image', async () => {
    const text = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const { stream } = streamsByRoute({})
    const input = [text]
    expect(await describeAdmittedImages(input, chain({ stream }))).toBe(input)
  })

  it('keeps every block unchanged when the chain answers nothing', async () => {
    const image = attachment('a')
    const message = createUserMessage({ content: [image], source: { kind: 'user' } })
    const { stream } = streamsByRoute({ 'xkiro/vl': 'error' })
    const input = [message]
    expect(await describeAdmittedImages(input, chain({ stream }))).toBe(input)
  })

  it('describes only retained occurrences, leaving offloaded and described blocks alone', async () => {
    const retained = attachment('retained')
    const offloaded: ImageBlock = { ...attachment('offloaded'), offloaded: true }
    const described: ImageBlock = { ...attachment('described'), description: 'already described' }
    const message = createUserMessage({ content: [offloaded, described, retained], source: { kind: 'user' } })
    const { calls, stream } = streamsByRoute({})
    const result = await describeAdmittedImages([message], chain({ stream }))
    const blocks = result[0]!.content.filter(block => block.type === 'image')
    expect(calls).toHaveLength(1)
    expect(blocks[0]).toEqual(offloaded)
    expect(blocks[1]).toEqual(described)
    expect(blocks[2]?.description).toBe('a red square')
  })

  it('returns the same messages when no candidate route survives', async () => {
    const message = createUserMessage({ content: [attachment('a')], source: { kind: 'user' } })
    const { calls, stream } = streamsByRoute({})
    const subject = chain({
      resolveModelInfo: async (provider, model): Promise<LlmResolvedModelInfo> => ({
        provider, id: model, name: model, inputModalities: ['text'],
      }),
      stream,
    })
    const input = [message]
    expect(await describeAdmittedImages(input, subject)).toBe(input)
    expect(calls).toHaveLength(0)
  })
})
