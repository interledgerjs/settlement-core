import BigNumber from 'bignumber.js'
import debug from 'debug'
import uuid from 'uuid/v4'
import { CreditSettlement, isSafeRedisKey, isValidAmount, SafeRedisKey, ValidAmount } from './'
import { DecoratedPipeline, DecoratedRedis, isSettlementAmounts } from './database'

const log = debug('settlement-core')

/** Callbacks for settlement engine to account for incoming and outgoing settlements */
interface RedisSettlementServices {
  /**
   * Acquire lease on funds queued for settlement. Used to perform async tasks before commiting the outgoing settlement
   * @param accountId Account to the send the settlement to
   * @param leaseDuration Number of milliseconds the funds should be on hold before they get rolled back (recommended to overestimate)
   * @return Tuple of maximum amount to settle and Redis transaction to commit the settlement.
   *         - Engine MUST truncate this amount to its precision and make sure it's not zero first.
   *         - Commitment transaction fails if the lease already expired, then removes the settlement as pending.
   *         - Engine MUST execute this transaction before unconditionally performing the settlement, and should
   *           include their own logic to safely rollback in case of failure.
   */
  prepareSettlement(
    accountId: string,
    leaseDuration: number
  ): Promise<[ValidAmount, DecoratedPipeline]>

  /**
   * Rollback a failed or partial outgoing settlement to retry again later
   * @param accountId Account that's the recipient of the settlements
   * @param amount Amount to refund and re-queue for settlement. If zero, tx will still be executed.
   * @param tx Redis transaction to execute atomically before rolling back the balance. Recommended to:
   *           1. Fail if this settlement was already rolled back
   *           2. Mark the settlement as complete to prevent rolling back this settlement more than once
   */
  refundSettlement(accountId: string, amount: BigNumber, tx?: DecoratedPipeline): Promise<void>

  /**
   * Credit an incoming settlement to the account balance of the sender
   * @param accountId Account of sender of the settlement
   * @param amount Amount received as an incoming settlement. If zero, tx will still be executed.
   * @param tx Redis transaction to execute atomically before crediting the balance. Recommended to:
   *           1. Fail if this settlement was already credited
   *           2. Prevent crediting this settlement more than once
   */
  creditSettlement(accountId: string, amount: BigNumber, tx?: DecoratedPipeline): Promise<void>
}

/** Callbacks for the settlement engine to account for settlements, integrate with Redis, and send messages */
export interface RedisStoreServices extends RedisSettlementServices {
  /** Connected ioredis client, decorated with custom Lua scripts for accounting */
  redis: DecoratedRedis

  /**
   * Send a message to the given account and return their response
   * @param accountId Unique account identifier to send message to
   * @param message Object to be serialized as JSON
   */
  sendMessage(accountId: SafeRedisKey, message: any): Promise<any>
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
    if (!isSafeRedisKey(accountId)) {
      return Promise.reject(new Error('Failed to prepare settlement, invalid account'))
    }

    const response = await redis.prepareSettlement(accountId, leaseDuration)
    if (!isSettlementAmounts(response)) {
      return Promise.reject(new Error('Failed to prepare settlement, database is corrupted'))
    }

    log(`Preparing lease for settlement amounts: account=${accountId} duration=${leaseDuration}`)

    // Sum all of the individual settlement amounts
    const amount = response
      // Only odd elements
      .filter((_, i) => i % 2 === 1)
      // Don't use BigNumber.sum: `NaN` if empty array!
      .reduce((a, b) => a.plus(b), new BigNumber(0))

    // `isSettlementAmounts` should already check the amounts are valid, but check again to be safe
    if (!isValidAmount(amount)) {
      return Promise.reject(new Error('Failed to prepare settlement, database is corrupted'))
    }

    if (amount.isZero()) {
      log(`No settlement amounts are available to lease: account=${accountId}`)
      return [new BigNumber(0) as ValidAmount, redis.multi()]
    }

    // Create transaction to atomically commit this settlement
    const amountIds = response.filter((_, i) => i % 2 === 0) // Even elements in response
    const commitTx = redis.multi().commitSettlement(accountId, ...amountIds)

    const details = `account=${accountId} amount=${amount} ids=${amountIds}`
    log(`Preparing settlement, funds on hold: ${details}`)

    return [amount, commitTx]
  },

  async creditSettlement(accountId, amount, tx = redis.multi()) {
    const idempotencyKey = uuid() as SafeRedisKey
    const details = `amountToCredit=${amount} account=${accountId} idempotencyKey=${idempotencyKey}`

    if (!isSafeRedisKey(accountId)) {
      return Promise.reject(new Error('Failed to credit settlement, invalid account'))
    }

    // Protects against saving `NaN` or `Infinity` to the database
    if (!isValidAmount(amount)) {
      return Promise.reject(new Error('Failed to credit settlement, invalid amount'))
    }

    // If amount is 0, still execute the transaction (no effect of credit)
    if (amount.isZero()) {
      log(`Ignoring credit for 0 amount, still executing provided Redis transaction: ${details}`)
      await tx.exec()
      return
    }

    // TODO Also atomically check that the account still exists (and add tests)
    await tx.addSettlementCredit(accountId, idempotencyKey, amount.toFixed()).exec()

    log(`Saved incoming settlement, attempting to notify connector: ${details}`)

    // Send initial request to connector to credit the settlement
    notifyAndFinalizeCredit(accountId, idempotencyKey, amount).catch(err =>
      log(`Error notifying connector of incoming settlement: ${details}`, err)
    )
  },

  async refundSettlement(accountId, amount, tx = redis.multi()) {
    const amountId = uuid()
    let details = `amountToRefund=${amount} account=${accountId} amountId=${amountId}`

    if (!isSafeRedisKey(accountId)) {
      return Promise.reject(new Error('Failed to refund settlement, invalid account'))
    }

    // Protects against saving `NaN` or `Infinity` to the database
    if (!isValidAmount(amount)) {
      return Promise.reject(new Error('Failed to refund settlement, invalid amount'))
    }

    // If amount is 0, still execute the transaction (no effect to refund)
    if (amount.isZero()) {
      log(`Ignoring refund for 0 amount, still executing provided Redis transaction: ${details}`)
      await tx.exec()
      return
    }

    const pendingSettlementsKey = `accounts:${accountId}:pending-settlements`
    const settlementKey = `accounts:${accountId}:pending-settlements:${amountId}`

    // TODO Also atomically check that the account still exists (and add tests)
    await tx
      .zadd(pendingSettlementsKey, '0', amountId)
      .set(settlementKey, amount.toFixed())
      .exec()

    details = `amountRefunded=${amount} account=${accountId} amountId=${amountId}`
    log(`Rolled back settlement to retry later: ${details}`)
  }
})
