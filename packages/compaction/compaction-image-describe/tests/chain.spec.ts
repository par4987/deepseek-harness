import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, ImageBlock, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveDescribeCandidates, describeImageThroughChain, type DescribeChain, type DescribeLogger } from '../src/chain.ts'
import type { VisionRoute } from '../src/types.ts'

const image: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

/** One per-route answer: literal sentinels or a plain text answer. */
type StubAnswer = 'error' | 'empty' | 'hung' | (string & {})

/** A stream stub keyed by `provider/model`; unlisted routes answer with the given text. */
function streamsByRoute(answers: Record<string, StubAnswer>): {
  calls: GenerateOptions[]
  stream: DescribeChain['stream']
} {
  const calls: GenerateOptions[] = []
  const stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    calls.push(options)
    const answer = answers[`${options.provider}/${options.model}`] ?? 'a red square'
    if (answer === 'hung') {
      // Ignore the request signal and never finish: only the chain's own
      // describe budget can end this call.
      await new Promise<never>(() => {})
    }
    if (answer === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no balance', code: 'INSUFFICIENT_BALANCE' } } }
      return
    }
    const text = answer === 'empty' ? '' : answer
    if (text !== '') yield { type: 'text-delta', index: 0, text }
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

describe('resolveDescribeCandidates', () => {
  it('keeps the configured chain order under the chain strategy', async () => {
    const subject = chain({
      routes: [{ provider: 'foreign', model: 'fvl' }, { provider: 'xkiro', model: 'vl' }],
      visionInventory: async () => [{ provider: 'xkiro', model: 'advertised' }],
      stream: streamsByRoute({}).stream,
    })
    const candidates = await resolveDescribeCandidates(subject)
    expect(candidates.map(route => `${route.provider}/${route.model}`)).toEqual(['foreign/fvl', 'xkiro/vl'])
  })

  it('fronts the selected provider under the same-provider strategy and skips its own text model', async () => {
    const subject = chain({
      routes: [{ provider: 'foreign', model: 'fvl' }, { provider: 'xkiro', model: 'chain-own' }],
      routeStrategy: 'same-provider',
      selected: { provider: 'xkiro', model: 'text-only-model' },
      visionInventory: async () => [
        { provider: 'xkiro', model: 'advertised' },
        { provider: 'xkiro', model: 'chain-own' },
        { provider: 'xkiro', model: 'text-only-model' },
        { provider: 'other', model: 'unrelated' },
      ],
      stream: streamsByRoute({}).stream,
    })
    const candidates = await resolveDescribeCandidates(subject)
    expect(candidates.map(route => `${route.provider}/${route.model}`)).toEqual([
      'xkiro/chain-own', 'xkiro/advertised', 'foreign/fvl',
    ])
  })

  it('excludes routes that declare no image input and routes that fail to resolve', async () => {
    const warn = vi.fn()
    const subject = chain({
      routes: [{ provider: 'a', model: 'text-declarer' }, { provider: 'b', model: 'broken' }, { provider: 'c', model: 'vision' }],
      logger: { warn, info: vi.fn() } satisfies DescribeLogger,
      resolveModelInfo: async (provider, model) => {
        if (provider === 'b') throw new Error('unregistered')
        const modalities: ModelModality[] = provider === 'a' ? ['text'] : ['text', 'image']
        return { provider, id: model, name: model, inputModalities: modalities }
      },
      stream: streamsByRoute({}).stream,
    })
    const candidates = await resolveDescribeCandidates(subject)
    expect(candidates.map(route => `${route.provider}/${route.model}`)).toEqual(['c/vision'])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('describeImageThroughChain', () => {
  const candidates: VisionRoute[] = [
    { provider: 'xkiro', model: 'vl' },
    { provider: 'foreign', model: 'fvl' },
  ]

  it('describes through the first route that answers', async () => {
    const { calls, stream } = streamsByRoute({})
    const description = await describeImageThroughChain(chain({ stream }), candidates, image)
    expect(description).toEqual({ text: 'a red square', route: 'xkiro/vl' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.provider).toBe('xkiro')
  })

  it('yields to the next route when one ends with a failed finish', async () => {
    const { calls, stream } = streamsByRoute({ 'xkiro/vl': 'error', 'foreign/fvl': 'the fallback text' })
    const description = await describeImageThroughChain(chain({ stream }), candidates, image)
    expect(description).toEqual({ text: 'the fallback text', route: 'foreign/fvl' })
    expect(calls).toHaveLength(2)
  })

  it('yields to the next route when one returns an empty description', async () => {
    const { stream } = streamsByRoute({ 'xkiro/vl': 'empty', 'foreign/fvl': 'the fallback text' })
    const description = await describeImageThroughChain(chain({ stream }), candidates, image)
    expect(description).toEqual({ text: 'the fallback text', route: 'foreign/fvl' })
  })

  it('yields to the next route when one hangs past its describe budget', async () => {
    const { stream } = streamsByRoute({ 'xkiro/vl': 'hung', 'foreign/fvl': 'the fallback text' })
    const description = await describeImageThroughChain(chain({ stream, describeTimeoutMs: 60 }), candidates, image)
    expect(description).toEqual({ text: 'the fallback text', route: 'foreign/fvl' })
  })

  it('caps the description at the configured character count', async () => {
    const { stream } = streamsByRoute({ 'xkiro/vl': 'x'.repeat(50) })
    const description = await describeImageThroughChain(chain({ stream, maxChars: 10 }), candidates, image)
    expect(description?.text).toBe('x'.repeat(10))
  })

  it('returns undefined when no route answers', async () => {
    const { stream } = streamsByRoute({ 'xkiro/vl': 'error', 'foreign/fvl': 'hung' })
    const description = await describeImageThroughChain(chain({ stream, describeTimeoutMs: 60 }), candidates, image)
    expect(description).toBeUndefined()
  })
})
