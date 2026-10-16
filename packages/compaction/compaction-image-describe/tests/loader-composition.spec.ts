/** Real Loader and AgentLoop composition: a text-only route gets durable image descriptions from the configured vision chain. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { describedImageText, LlmAdapter, textOnlyImageText, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ImageDescribe from '../src/index.ts'

const image: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

/** One stub behind two providers: the text-only route the turn selects and the vision route the chain describes through. */
class SplitModalityModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly description = 'a red square on a white table'

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      inputModalities: provider === 'vision-fixture' ? ['text', 'image'] : ['text'],
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = options.provider === 'vision-fixture' ? this.description : 'Answering without seeing any image.'
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('describes a surface image through the chain and the next request carries the text in its place', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-image-describe-loader-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-compaction-image-describe', ImageDescribe],
  ])
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: '${name}'`,
    ...name === '@deepseek-ai/dsh-compaction-image-describe' ? [
      '  config:',
      '    visionRoutes:',
      '      - provider: vision-fixture',
      '        model: vl',
      '    describeTimeoutMs: 2000',
    ] : [],
  ]).join('\n') + '\n')

  const context = ctx = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()

  const model = new SplitModalityModel()
  context.llm.registerAdapter(['text-fixture', 'vision-fixture'], model)
  const agent = await context.agentLoop.create(SessionId('describe-loader'), { provider: 'text-fixture', model: 'text-only' })
  const idle = Promise.withResolvers<undefined>()
  const stop = context.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve(undefined)
  })
  agent.followup(createUserMessage({ content: [image, { type: 'text', text: 'What do you see?' }], source: { kind: 'user' } }))
  await idle.promise
  stop()

  const nextIdle = Promise.withResolvers<undefined>()
  const stopNext = context.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') nextIdle.resolve(undefined)
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Summarize it in one word.' }], source: { kind: 'user' } }))
  await nextIdle.promise
  stopNext()

  const requestImages = (request: GenerateOptions | undefined): ImageBlock[] =>
    (request?.messages ?? []).flatMap(message => message.content.filter(block => block.type === 'image'))
  const requestText = (request: GenerateOptions | undefined): string =>
    (request?.messages ?? [])
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  // The loop commits the accepted user batch after the agent/request
  // waterfall, so the turn-1 attempt assembled before any description existed
  // and served the deterministic placeholder; the turn-2 waterfall described
  // the retained image, and its request carries the durable description in
  // the image's place.
  expect(model.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
    'text-fixture/text-only', 'vision-fixture/vl', 'text-fixture/text-only',
  ])
  expect(requestText(model.requests[0])).toContain(textOnlyImageText(image.attachment))
  expect(requestImages(model.requests[0])).toEqual([])
  expect(requestImages(model.requests[1]).map(block => String(block.attachment.attachmentId)))
    .toEqual([String(image.attachment.attachmentId)])
  expect(requestText(model.requests[2])).toContain(describedImageText(image.attachment, model.description))
  expect(requestText(model.requests[2])).not.toContain(textOnlyImageText(image.attachment))

  const userMessage = agent.session.snapshotEvents().find(event => event.type === 'user/message')
  const decision = agent.session.snapshotEvents().find(event => event.type === 'image/describe')
  expect(decision).toMatchObject({
    type: 'image/describe',
    data: { targets: [{ seq: userMessage?.seq, imageIndex: 0, description: model.description }] },
  })
  const derived = agent.session.deriveMessages()
    .flatMap(message => message.content)
    .filter(block => block.type === 'image')
  expect(derived.map(block => block.description)).toEqual([model.description])
})
