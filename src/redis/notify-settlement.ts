import { DecoratedRedis } from './scripts/create-client'
import { sleep } from '../utils/retry'
import BigNumber from 'bignumber.js'

export type CreditSettlement = (
  accountId: string,
  idempotencyKey: string,
  amount: BigNumber
) => Promise<void>

export const creditSettlement = (
  redis: DecoratedRedis,
  notifyConnector: CreditSettlement
): CreditSettlement => (accountId, idempotencyKey, amount) =>
  notifyConnector(accountId, idempotencyKey, amount)
    .then(() => {
      // TODO Log success
      redis.finalizeSettlementCredit(accountId, idempotencyKey)
    })
    .catch(err => {
      // TODO Log notification failed
    })

/**
 * Start polling Redis for queued settlement credits to notify the connector
 *
 * @param redis Connected ioredis client decorated with custom Lua scripts
 * @param notifyConnector Callback to send HTTP request to connector to notify accounting system of incoming settlement
 * @return Callback to stop polling
 */
export const startCreditLoop = (
  redis: DecoratedRedis,
  notifyConnector: CreditSettlement
): Function => {
  let terminate = false
  let creditLoop = Promise.resolve()

  // TODO More idiomatic if this was replaced with a while loop?

  const pollForCredits = () => {
    creditLoop = creditLoop
      .then(async () => {
        if (terminate) {
          return
        }

        const credit = await redis.retrySettlementCredit()
        if (!credit) {
          await sleep(50) // Check Redis again in another 50ms
          return pollForCredits()
        }

        const [accountId, idempotencyKey] = credit
        const amount = new BigNumber(credit[2])

        creditSettlement(redis, notifyConnector)(
          accountId,
          idempotencyKey,
          amount
        )

        // Keep sending notifications until the queue is empty
        pollForCredits()
      })
      .catch(err => {
        // TODO Log errors so the whole Promise chain isn't fucked
      })
  }

  return () => {
    terminate = true
    return creditLoop
  }
}
