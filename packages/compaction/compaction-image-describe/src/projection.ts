/** Browser-safe durable image description declaration and pure replay definition. */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import type { ImageDescribeTarget } from './types.ts'
import { describeMessageImages, type MessageDescribeTarget } from './project-message.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Record the description text a configured vision chain produced for selected
     * input-image occurrences, so text-only routes receive the description in the
     * image's place. Targets name unique current user/message or tool/result
     * occurrences in current model-request order; each carries its verbatim
     * description. Message nodes and identities remain unchanged.
     * @messageProjection
     */
    'image/describe': { targets: ImageDescribeTarget[] }
  }
}

/** Whether a durable value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value: unknown): value is SessionSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/** Whether a durable description is a nonempty string. */
function isDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Atomic validation and reconstruction shared by live sessions and detached replay. */
export const imageDescribeProjection: SessionMessageProjection<'image/describe'> = {
  type: 'image/describe',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data['targets']) || data['targets'].length === 0) {
      throw new Error('image/describe: data must contain a nonempty targets array')
    }
    const messages = new Map<SessionSeq, Message>()
    const nodes = new Set(context.nodes)
    const grouped = new Map<SessionSeq, MessageDescribeTarget[]>()
    let previousSeq: SessionSeq | undefined
    let previousIndex = -1
    for (const target of data['targets'] as unknown[]) {
      if (
        !isRecord(target) || Object.keys(target).length !== 3
        || !isIndex(target['seq']) || !isIndex(target['imageIndex']) || !isDescription(target['description'])
      ) {
        throw new Error('image/describe: each target must contain a seq, an imageIndex, and a nonempty description')
      }
      const seq = target['seq']
      const imageIndex = target['imageIndex']
      if (previousSeq !== undefined && (seq < previousSeq || (seq === previousSeq && imageIndex <= previousIndex))) {
        throw new Error('image/describe: targets must strictly increase by seq then imageIndex')
      }
      previousSeq = seq
      previousIndex = imageIndex
      if (!nodes.has(seq)) throw new Error(`image/describe: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/describe: target seq ${seq} must be user/message or tool/result`)
      }
      const group = grouped.get(seq) ?? []
      group.push({ imageIndex, description: target['description'] })
      grouped.set(seq, group)
    }
    for (const [seq, targets] of grouped) {
      const source = context.events[seq - context.baseSeq]
      const message = context.messages.get(seq)
        ?? (source?.type === 'user/message' ? source.data : source?.type === 'tool/result' ? source.data.message : undefined)
      if (message === undefined) throw new Error(`image/describe: target seq ${seq} has no derived message`)
      messages.set(seq, describeMessageImages(message, targets))
    }
    return messages
  },
}
