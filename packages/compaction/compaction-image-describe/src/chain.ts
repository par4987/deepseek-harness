/**
 * The describe chain: order candidate vision routes, ask each within its
 * budget, and return the first description a route produces. Pure over its
 * inputs so tests drive it without a live provider.
 *
 * @module @deepseek-ai/dsh-compaction-image-describe/chain
 */

import type {
  GenerateOptions, ImageBlock, LlmFailure, LlmResolvedModelInfo, Message, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { VisionRoute } from './types.ts'

/** Generation budget for one description; descriptions are character-bounded on top. */
const DESCRIBE_MAX_TOKENS = 1024

/** Failure and drift reporting the chain needs; the plugin passes its context logger. */
export interface DescribeLogger {
  /** @param message - the failure or drift fact. @param args - optional error detail. */
  warn(message: string, ...args: unknown[]): void
  /** @param message - the informational fact. @param args - optional detail. */
  info(message: string, ...args: unknown[]): void
}

/** One chain attempt's inputs: configuration, the selected text-only route, and the llm faces. */
export interface DescribeChain {
  /** Configured describe chain in configured order. */
  readonly routes: VisionRoute[]
  /** Route ordering strategy. */
  readonly routeStrategy: 'chain' | 'same-provider'
  /** Instruction sent beside each described image. */
  readonly describePrompt: string
  /** Cap on one description's character count. */
  readonly maxChars: number
  /** Per-route budget for one description before the route yields to the next. */
  readonly describeTimeoutMs: number
  /** The text-only route whose occurrences are being described. */
  readonly selected: { readonly provider: string; readonly model: string }
  /** Cancellation of the turn the description serves. */
  readonly signal: AbortSignal | undefined
  readonly logger: DescribeLogger
  /** Every route the live registry advertises as accepting image input. */
  readonly visionInventory: () => Promise<readonly VisionRoute[]>
  readonly resolveModelInfo: (
    provider: string,
    model: string,
    signal: AbortSignal | undefined,
  ) => Promise<LlmResolvedModelInfo>
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

/** One produced description. */
export interface ChainDescription {
  readonly text: string
  readonly route: string
}

function routeKey(route: VisionRoute): string {
  return `${route.provider}/${route.model}`
}

/**
 * Order the routes to try. Under `'chain'` that is the configured chain as
 * given. Under `'same-provider'` the selected route's own provider goes first:
 * its chain routes, then that provider's registry-advertised vision routes the
 * chain omits, then the rest of the chain. Only routes whose metadata confirms
 * or leaves open image input survive.
 * @param chain - the attempt's inputs.
 * @returns admitted candidates in try order.
 */
export async function resolveDescribeCandidates(chain: DescribeChain): Promise<readonly VisionRoute[]> {
  const selected = chain.selected.provider
  let ordered: readonly VisionRoute[] = chain.routes
  if (chain.routeStrategy === 'same-provider') {
    // A provider's text and vision models share key, quota, and reachability,
    // so its advertised vision routes describe for its own text-only selection
    // before any foreign chain route is tried.
    const inChain = new Set(chain.routes.map(routeKey))
    const advertised: VisionRoute[] = []
    for (const route of await chain.visionInventory()) {
      // The selected model is excluded even if its catalog entry disagrees
      // with the resolved metadata: it is the route that cannot see images.
      if (route.provider !== selected || route.model === chain.selected.model || inChain.has(routeKey(route))) continue
      advertised.push(route)
    }
    ordered = [
      ...chain.routes.filter(route => route.provider === selected),
      ...advertised,
      ...chain.routes.filter(route => route.provider !== selected),
    ]
  }
  const admitted: VisionRoute[] = []
  for (const route of ordered) {
    try {
      const info = await chain.resolveModelInfo(route.provider, route.model, chain.signal)
      if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
        chain.logger.warn(`image-describe: route ${routeKey(route)} declares no image input; excluded from the chain`)
        continue
      }
      admitted.push(route)
    } catch (error) {
      chain.logger.warn(`image-describe: route ${routeKey(route)} is not resolvable; excluded from the chain`, error)
    }
  }
  return admitted
}

/**
 * Ask each candidate route in order until one returns a description within its budget.
 * @param chain - the attempt's inputs.
 * @param candidates - admitted routes in try order.
 * @param image - the occurrence to describe.
 * @returns the first description and the route that produced it, or undefined when none answered.
 */
export async function describeImageThroughChain(
  chain: DescribeChain,
  candidates: readonly VisionRoute[],
  image: ImageBlock,
): Promise<ChainDescription | undefined> {
  for (const route of candidates) {
    const label = routeKey(route)
    // Each attempt gets a fresh budget; the turn signal additionally carries
    // the caller's cancellation so an abandoned turn stops the route too.
    const budget = AbortSignal.timeout(chain.describeTimeoutMs)
    const signal = chain.signal === undefined ? budget : AbortSignal.any([chain.signal, budget])
    try {
      const text = await collectText(
        chain.stream(visionRequest(chain, image, route, signal)), chain.maxChars, budget, chain.describeTimeoutMs)
      return { text, route: label }
    } catch (error) {
      // A route without balance, rate-limited, hung past its budget, or
      // otherwise failing yields to the next candidate.
      chain.logger.warn(`image-describe: route ${label} did not describe the image; trying the next route`, error)
    }
  }
  return undefined
}

/** One vision request: the image beside the describe instruction, nothing else. */
function visionRequest(chain: DescribeChain, image: ImageBlock, route: VisionRoute, signal: AbortSignal): GenerateOptions {
  const message = createUserMessage({
    content: [{ ...image }, { type: 'text', text: chain.describePrompt }],
    source: { kind: 'user' },
  }) as Message
  return {
    provider: route.provider,
    model: route.model,
    messages: [message],
    maxTokens: DESCRIBE_MAX_TOKENS,
    signal,
  }
}

/**
 * Collect one response's text, bounded to the chain's character cap and cut
 * off when the route's own budget fires, so a route that ignores the request
 * signal cannot stall the turn.
 */
async function collectText(
  stream: AsyncIterable<StreamChunk>,
  maxChars: number,
  budget: AbortSignal,
  budgetMs: number,
): Promise<string> {
  const collecting = collectChunks(stream, maxChars)
  // The race settles the result; a loser that rejects afterwards is detached
  // here so it never reaches the process unhandled-rejection report.
  collecting.catch(() => { /* the race already settled; the losing adapter error is not re-raised */ })
  let rejectBudget: ((error: Error) => void) | undefined
  const budgetHit = new Promise<never>((_resolve, reject) => { rejectBudget = reject })
  const onBudget = (): void => rejectBudget?.(new Error(`vision route gave no answer within ${String(budgetMs)}ms`))
  if (budget.aborted) onBudget()
  else budget.addEventListener('abort', onBudget, { once: true })
  try {
    return await Promise.race([collecting, budgetHit])
  } finally {
    budget.removeEventListener('abort', onBudget)
  }
}

/** Drain one describe stream into text. */
async function collectChunks(stream: AsyncIterable<StreamChunk>, maxChars: number): Promise<string> {
  let text = ''
  let failure: LlmFailure | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.failure
    }
  }
  if (failure !== undefined) throw new LlmError(failure.message, failure.code, failure)
  if (text.length === 0) throw new Error('vision model returned an empty description')
  return text.slice(0, maxChars)
}
