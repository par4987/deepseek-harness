/** Select undescribed surface occurrences, describe each attachment once, and log one durable decision. */

import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { isRetainedImage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ImageDescribeTarget } from './types.ts'
import type { DescribeChain } from './chain.ts'
import { describeImageThroughChain, resolveDescribeCandidates } from './chain.ts'

/** One attachment's pending state: a representative block and every retained occurrence. */
interface PendingAttachment {
  readonly block: ImageBlock
  readonly occurrences: Array<{ seq: SessionSeq; imageIndex: number }>
}

/**
 * Describe every undescribed retained image occurrence of the session's
 * current surface through the configured vision chain and append one
 * `image/describe` decision. One attachment is described once and each of its
 * occurrences receives the same text. An attachment whose chain yields no
 * description stays for the deterministic text-only projection, matching a
 * dead chain.
 * @param session - session whose next request derives from the described surface.
 * @param chain - the attempt's describe chain inputs.
 * @returns how many attachments received a description; zero appends nothing.
 */
export async function describeUndescribedImages(session: Session, chain: DescribeChain): Promise<number> {
  const pending = new Map<string, PendingAttachment>()
  for (const seq of session.surface.nodes) {
    // Existing Session history read; migration deferred. Current surface nodes index the durable log.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    const event = session.eventAt(seq)!
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- both input node types produce a message
    const message = session.deriveEventMessage(event)!
    let imageIndex = 0
    for (const block of message.content) {
      if (block.type === 'image') {
        if (isRetainedImage(block)) {
          const id = String(block.attachment.attachmentId)
          const entry = pending.get(id)
          if (entry === undefined) {
            pending.set(id, { block, occurrences: [{ seq, imageIndex }] })
          } else {
            entry.occurrences.push({ seq, imageIndex })
          }
        }
        imageIndex += 1
      }
    }
  }
  if (pending.size === 0) return 0

  const candidates = await resolveDescribeCandidates(chain)
  if (candidates.length === 0) return 0
  const targets: ImageDescribeTarget[] = []
  let described = 0
  for (const entry of pending.values()) {
    const description = await describeImageThroughChain(chain, candidates, entry.block)
    if (description === undefined) continue
    described += 1
    for (const occurrence of entry.occurrences) {
      targets.push({ seq: occurrence.seq, imageIndex: occurrence.imageIndex, description: description.text })
    }
  }
  if (targets.length === 0) return 0
  // The walk groups by attachment, so targets arrive grouped rather than in
  // surface order; the decision records them in current model-request order.
  targets.sort((left, right) => left.seq - right.seq || left.imageIndex - right.imageIndex)
  session.append('image/describe', { targets })
  return described
}
