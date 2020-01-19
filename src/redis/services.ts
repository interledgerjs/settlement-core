import BigNumber from 'bignumber.js'
import debug from 'debug'
import uuid from 'uuid/v4'
import { isValidAmount, isSafeKey, SafeKey, CreditSettlement, ValidAmount } from './'
import { DecoratedPipeline, DecoratedRedis, isSettlementAmount } from './database'

const log = debug('settlement-core')

// TODO Should the type signature be (SafeKey, ValidAmount) so SEs *MUST* do the type checking, or should it be string, amount and
//      should WE do all the validation and checking here, then promise rejects if it's wrong?

/** TODO explain this */
interface RedisSettlementServices {
  /**
   * Acquire lease on funds queued for settlement. Used to perform async tasks before commiting the outgoing settlement
   * @param accountId Account to the send the settlement to
   * @param leaseDuration Number of milliseconds the funds should be on hold before they get rolled back (recommended to overestimate)
   * @return Tuple of maximum amount to settle and Redis transaction to commit the settlement.
   *         - Commitment transaction fails if the lease already expired, then removes the settlement as pending.
   *         - Consumer MUST execute this transaction before unconditionally performing the settlement, and should
   *           include their own logic to safely rollback in case of failure.
   */
  prepareSettlement(
    accountId: SafeKey,
    leaseDuration: number
  ): Promise<[ValidAmount, DecoratedPipeline]>

  /**
   * Rollback a failed or partial outgoing settlement to retry again later TODO
   * @param accountId Account
   * @param amount Amount to refund ... TODO
   * @param tx Redis transaction to execute atomically before rolling back the balance. Recommended to:
   *           1. Fail if this settlement was already rolled back
   *           2. Mark the settlement as complete to prevent rolling back this settlement more than once
   */
  refundSettlement(accountId: SafeKey, amount: ValidAmount, tx?: DecoratedPipeline): Promise<void>

  /**
   * Credit an incoming settlement to the account balance of the sender
   * @param accountId Account of sender of the settlement
   * @param amount Amount received as an incoming settlement, in arbitrary precision, standard units of asset
   * @param tx Redis transaction to execute atomically before crediting the balance. Recommended to:
   *           1. Fail if this settlement was already credited
   *           2. Prevent crediting this settlement more than once
   */
  creditSettlement(accountId: SafeKey, amount: ValidAmount, tx?: DecoratedPipeline): Promise<void>
}

/** TODO explain this */
export interface RedisStoreServices extends RedisSettlementServices {
  /** Connected ioredis client, decorated with custom Lua scripts for accounting */
  redis: DecoratedRedis

  /**
   * Send a message to the given account and return their response
   * @param accountId Unique account identifier to send message to
   * @param message Object to be serialized as JSON
   */
  sendMessage(accountId: SafeKey, message: any): Promise<any>
}

/**
 * Create callbacks to pass to the settlement to atomically prepare, commit, credit and refund settlements
 * @param redis Connected ioredis instance decorated with Lua scripts for accounting
 * @param sendCreditNotification Callback to send request to connector to credit an incoming settlement and finalize in Redis
 */
export const setupSettlementServices = (
  redis: DecoratedRedis,
  notifyAndFinalizeCredit: CreditSettlement
): RedisSettlementServices => ({
  async prepareSettlement(accountId, leaseDuration) {
    const rawAmounts = await redis.prepareSettlement(accountId, leaseDuration)
    if (!isSettlementAmount(rawAmounts)) {
      return Promise.reject(
        new Error(`Failed to prepare settlement, database is corrupted: account=${accountId}`)
      )
    }

    // Sum all of the individual settlement amounts (odd elements)
    const amount: BigNumber = rawAmounts
      .filter((_, i) => i % 2 === 1)
      .reduce((a, b) => a.plus(b), new BigNumber(0))

    // Create transaction to atomically commit this settlement
    const amountIds = rawAmounts.filter((_, i) => i % 2 === 0) // Even elements in response
    const commitTx = redis.multi().commitSettlement(accountId, ...amountIds)

    const details = `account=${accountId} amount=${amount} ids=${amountIds}`
    log(`Preparing settlement, funds on hold: ${details}`)

    return [amount, commitTx]
  },

  async creditSettlement(accountId, amount, tx = redis.multi()) {
    const idempotencyKey = uuid() as SafeKey
    const details = `amountToCredit=${amount} account=${accountId} idempotencyKey=${idempotencyKey}`

    if (amount.isZero()) {
      return
    }

    // TODO
    // Protects against saving `NaN` or `Infinity` to the database
    // if (!isValidAmount(amount)) {
    //   return log(`Error: Failed to credit settlement, invalid amount: ${details}`)
    // }

    if (!isSafeKey(accountId)) {
      return log(`Error: Failed to credit settlement, invalid account: ${details}`)
    }

    // TODO Also atomically check that the account still exists
    await tx.addSettlementCredit(accountId, amount.toFixed(), idempotencyKey).exec()

    log(`Saved incoming settlement, attempting to notify connector: ${details}`)

    // Send initial request to connector to credit the settlement
    notifyAndFinalizeCredit(accountId, idempotencyKey, amount)
  },

  async refundSettlement(accountId, amount, tx = redis.multi()) {
    const amountId = uuid()
    let details = `amountToRefund=${amount} account=${accountId} amountId=${amountId}`

    if (amount.isZero()) {
      return
    }

    // TODO
    // Protects against saving `NaN` or `Infinity` to the database
    // if (!isValidAmount(amount)) {
    //   return log(`Error: Failed to refund settlement, invalid amount: ${details}`)
    // }

    if (!isSafeKey(accountId)) {
      return log(`Error: Failed to refund settlement, invalid account: ${details}`)
    }

    const pendingSettlementsKey = `accounts:${accountId}:pending-settlements`
    const settlementKey = `accounts:${accountId}:pending-settlements:${amountId}`

    // TODO Also atomically check that the account still exists
    await tx
      .zadd(pendingSettlementsKey, '0', amountId)
      .set(settlementKey, amount.toFixed())
      .exec()

    details = `amountRefunded=${amount} account=${accountId} amountId=${amountId}`
    log(`Rolled back settlement to retry later: ${details}`)
  }
})
