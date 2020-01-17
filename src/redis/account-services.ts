import BigNumber from 'bignumber.js'
import {
  DecoratedPipeline,
  DecoratedRedis,
  isSettlementAmount
} from './scripts/create-client'
import debug from 'debug'
import { isSafeKey, SafeKey } from '.'
import uuid from 'uuid/v4'
import { isValidAmount } from '../utils/quantity'
import { PrepareSettlement } from './redis'
import { CreditSettlement, creditSettlement } from './notify-settlement'

const log = debug('settlement-core:account-services')

// TODO Copy this from elsewhere
type PerformSettlement = (
  accountId: SafeKey,
  prepare: PrepareSettlement
) => Promise<void>

interface SettlementServices {
  /**
   * Retry failed or queued outgoing settlements
   * - Automatically called after the settlement engine is instantiated
   *
   * @param accountId Unique account identifier
   */
  trySettlement(accountId: string, settle: PerformSettlement): void

  /** Amount to credit as an incoming settlement, in standard unit of the asset (arbitrary precision) */
  /**
   * Redis transaction executed atomically before creating a settlement credit to notify the connector.
   * This should include custom logic to (1) fail if this settlement was already credited, and
   * (2) prevent crediting it again.
   */
  creditSettlement(
    accountId: string,
    amount: BigNumber,
    tx?: DecoratedPipeline
  ): Promise<void>

  /** TODO add docs here */
  refundSettlement(
    accountId: string,
    amount: BigNumber,
    tx?: DecoratedPipeline
  ): Promise<void>
}

export interface AccountServices extends SettlementServices {
  /** Connected ioredis client, decorated with custom accounting Lua scripts */
  redis: DecoratedRedis

  /**
   * Send a message to the given account and return their response
   *
   * @param accountId Unique account identifier to send message to
   * @param message Object to be serialized as JSON
   */
  sendMessage(accountId: string, message: any): Promise<any>
}

export const setupSettlementServices = (
  redis: DecoratedRedis,
  sendCreditNotification: CreditSettlement
): SettlementServices => ({
  trySettlement(accountId, settle) {
    let details = `account=${accountId}`

    if (!isSafeKey(accountId)) {
      return log(`Error: Failed to settle, invalid account: ${details}`)
    }

    // TODO Require the engine instance to be passed into this? Or settle function to be passed in?
    settle(accountId, async leaseDuration => {
      const rawAmounts = await redis.prepareSettlement(accountId, leaseDuration)
      if (!isSettlementAmount(rawAmounts)) {
        return Promise.reject(
          new Error(
            'Failed to load amount to settle, database may be corrupted'
          )
        )
      }

      // Sum all of the individual settlement amounts (odd elements)
      const amount: BigNumber = rawAmounts
        .filter((_, i) => i % 2 === 1)
        .reduce((a, b) => a.plus(b), new BigNumber(0))

      // Create transaction to atomically commit this settlement
      const settlementIds = rawAmounts.filter((_, i) => i % 2 === 0) // Even elements in response
      const commitTx = redis
        .multi()
        .commitSettlement(accountId, ...settlementIds)

      // TODO Add successful log here

      return [amount, commitTx]
    })
  },

  async creditSettlement(accountId, amount, tx = redis.multi()) {
    const idempotencyKey = uuid()
    const details = `amountToCredit=${amount} account=${accountId} idempotencyKey=${idempotencyKey}`

    if (amount.isZero()) {
      return
    }

    // Protects against saving `NaN` or `Infinity` to the database
    if (!isValidAmount(amount)) {
      return log(
        `Error: Failed to credit settlement, invalid amount: ${details}`
      )
    }

    if (!isSafeKey(accountId)) {
      return log(
        `Error: Failed to credit settlement, invalid account: ${details}`
      )
    }

    // TODO Also atomically check that the account exists
    await tx
      .addSettlementCredit(accountId, amount.toFixed(), idempotencyKey)
      .exec()

    // TODO Log that the settlement was added to the database

    // Send initial request to connector to credit the settlement
    creditSettlement(redis, sendCreditNotification)(
      accountId,
      idempotencyKey,
      amount
    )
  },

  async refundSettlement(accountId, amount, tx = redis.multi()) {
    const amountId = uuid()
    const details = `amountToRefund=${amount} account=${accountId} amountId=${amountId}`

    if (amount.isZero()) {
      return
    }

    // Protects against saving `NaN` or `Infinity` to the database
    if (!isValidAmount(amount)) {
      return log(
        `Error: Failed to refund settlement, invalid amount: ${details}`
      )
    }

    if (!isSafeKey(accountId)) {
      return log(
        `Error: Failed to refund settlement, invalid account: ${details}`
      )
    }

    const pendingSettlementsKey = `accounts:${accountId}:pending-settlements`
    const settlementKey = `accounts:${accountId}:pending-settlements:${amountId}`

    // TODO Also atomically check that the account exists
    await tx
      .zadd(pendingSettlementsKey, '0', amountId)
      .set(settlementKey, amount.toFixed())
      .exec()

    // TODO Add a success log here that the settlement was refunded
  }
})
