import { DecoratedRedis } from './scripts/create-client'
import { sleep } from '../utils'
import BigNumber from 'bignumber.js'

const REDIS_CREDIT_POLL_INTERVAL_MS = 50

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

export type StopCreditLoop = () => Promise<void>

/**
 * Start polling Redis for queued settlement credits to notify the connector
 * @param redis Connected ioredis client decorated with custom Lua scripts
 * @param notifyConnector Callback to send HTTP request to connector to notify accounting system of incoming settlement
 * @return Callback to stop polling, returning a Promise that resolves when the loop ends
 */
export const startCreditLoop = (
  redis: DecoratedRedis,
  notifyConnector: CreditSettlement
): StopCreditLoop => {
  let terminate = false

  const creditLoop = (async () => {
    while (true) {
      if (terminate) {
        return
      }

      const credit = await redis.retrySettlementCredit().catch(err => {
        // TODO Catch errors so the loop doesn't automatically exist
      })
      if (!credit) {
        await sleep(REDIS_CREDIT_POLL_INTERVAL_MS)
        continue
      }

      const [accountId, idempotencyKey] = credit
      const amount = new BigNumber(credit[2])

      creditSettlement(redis, notifyConnector)(accountId, idempotencyKey, amount)

      // Keep sending notifications with no delay until the queue is empty
    }
  })()

  return () => {
    terminate = true
    return creditLoop
  }
}
