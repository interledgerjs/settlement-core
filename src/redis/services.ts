import BigNumber from 'bignumber.js'
import debug from 'debug'
import uuid from 'uuid/v4'
import {
  CreditSettlement,
  isSafeRedisKey,
  isValidAmount,
  SafeRedisKey,
  ValidAmount,
  DecoratedPipeline
} from './'
import { isSettlementAmounts } from './database'
import { Redis, Pipeline } from 'ioredis'

const log = debug('settlement-core')

/** Callbacks for settlement engine to account for incoming and outgoing settlements */
interface RedisSettlementServices {
  /**
   * Acquire lease on funds queued for settlement. Used to perform async tasks before commiting the outgoing settlement
   * @param accountId Account to the send the settlement to
   * @param leaseDuration Number of milliseconds the funds should be on hold before they get rolled back (recommended to overestimate)
   * @return Tuple of maximum amount to settle and Redis transaction to commit the settlement.
   *         - Engine MUST truncate this amount to its precision and make sure it's not zero first.
   *         - Engine MUST execute this transaction before unconditionally performing the settlement, and should
   *           include their own logic to safely rollback in case of failure.
   *         - If the lease already expired, the commitment transaction will fail; if it succeeds, it will
   *           remove the lease as pending.
   */
  prepareSettlement(accountId: string, leaseDuration: number): Promise<[ValidAmount, Pipeline]>

  // TODO The signatures/documentation for these should be updated

  /**
   * Rollback a failed or partial outgoing settlement to retry again later
   * @param accountId Account that's the recipient of the settlements
   * @param amount Amount to refund and re-queue for settlement. If zero, tx will still be executed.
   * @param tx Redis transaction to execute atomically before rolling back the balance. Engine is recommended to:
   *           1. Early return if this settlement was already rolled back
   *           2. Mark the settlement as complete to prevent rolling back this settlement more than once
   */
  refundSettlement(accountId: string, amount: BigNumber, tx?: Pipeline): Pipeline

  /**
   * Credit an incoming settlement to the account balance of the sender
   * @param accountId Account of sender of the settlement
   * @param amount Amount received as an incoming settlement. If zero, tx will still be executed.
   * @param tx Redis transaction to execute atomically before crediting the balance. Engine is recommended to:
   *           1. Fail if this settlement was already credited using Redis DISCARD
   *           2. Prevent crediting this settlement more than once
   */
  creditSettlement(accountId: string, amount: BigNumber, tx?: Pipeline): Pipeline
}

/** Callbacks for the settlement engine to account for settlements, integrate with Redis, and send messages */
export interface RedisStoreServices extends RedisSettlementServices {
  /** Connected ioredis client, decorated with custom Lua scripts for accounting */
  redis: Redis

  /**
   * Send a message to the given account and return their response
   * @param accountId Unique account identifier to send message to
   * @param message Object to be serialized as JSON
   */
  sendMessage(accountId: string, message: any): Promise<any>
}

/**
 * Create callbacks to pass to the settlement to atomically prepare, commit, credit and refund settlements
 * @param redis Connected ioredis instance decorated with Lua scripts for accounting
 */
export const setupSettlementServices = (redis: Redis): RedisSettlementServices => ({
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
      return Promise.reject(
        new Error(`No settlement amounts are available to lease: account=${accountId}`)
      )
    }

    // Create transaction to atomically commit this settlement
    const amountIds = response.filter((_, i) => i % 2 === 0) // Even elements in response

    // If we use a single Redis instance, our Redis WATCH blocks may not work correctly, since the
    // settlement engine could be executing other concurrent Redis transactions:
    // https://github.com/luin/ioredis/issues/999
    // https://github.com/luin/ioredis/issues/266#issuecomment-332441562

    // So, create a new Redis connection for this settlement to workaround
    // Automatically disconnect it after the settlement lease expires!
    const redisCopy = redis.duplicate()
    setTimeout(() => redisCopy.disconnect(), leaseDuration * 2)

    // Fail this settlement if a leases expires and any of these settlement amount are retried
    await amountIds
      .reduce(
        (pipeline, amountId) =>
          pipeline.watch(`accounts:${accountId}:pending-settlements:${amountId}`),
        redisCopy.pipeline()
      )
      .exec()

    // TODO How/when should I call UNWATCH? Is that not important if I disconnect the instance after the lease expires?

    const details = `account=${accountId} amount=${amount} ids=${amountIds}`
    log(`Preparing settlement, funds on hold: ${details}`)

    // Compose an atomic transaction to delete each pending settlement amount when
    // the settlement engine commits the settlement
    const pendingSettlementsKey = `accounts:${accountId}:pending-settlements`
    const commitTransaction = amountIds.reduce(
      (transaction, amountId) =>
        transaction
          .del(`accounts:${accountId}:pending-settlements:${amountId}`)
          .zrem(pendingSettlementsKey, amountId),
      redisCopy.multi()
    )

    return [amount, commitTransaction]
  },

  // TODO Should I change this signature to *return* a Redis multi instance, or decorate one?
  creditSettlement(accountId, amount, tx = redis.multi()) {
    const idempotencyKey = uuid() as SafeRedisKey
    const details = `amountToCredit=${amount} account=${accountId} idempotencyKey=${idempotencyKey}`

    if (!isSafeRedisKey(accountId)) {
      log('Failed to credit settlement, invalid account')
      return tx
    }

    // Protects against saving `NaN` or `Infinity` to the database
    if (!isValidAmount(amount)) {
      log('Failed to credit settlement, invalid amount')
      return tx
    }

    // If amount is 0, still execute the transaction (no effect of credit)
    if (amount.isZero()) {
      log(`Ignoring credit for 0 amount, still executing provided Redis transaction: ${details}`)
      return tx
    }

    // TODO Also atomically check that the account still exists (and add tests)
    // log(`Saved incoming settlement, queued task to notify connector: ${details}`) // TODO Cannot log here if it fails, right?
    return tx.addSettlementCredit(accountId, idempotencyKey, amount.toFixed())
  },

  refundSettlement(accountId, amount, tx = redis.multi()): DecoratedPipeline {
    const amountId = uuid()
    let details = `amountToRefund=${amount} account=${accountId} amountId=${amountId}`

    if (!isSafeRedisKey(accountId)) {
      log('Failed to refund settlement, invalid account')
      return tx
    }

    // Protects against saving `NaN` or `Infinity` to the database
    if (!isValidAmount(amount)) {
      log('Failed to refund settlement, invalid amount')
      return tx
    }

    // If amount is 0, still execute the transaction (no effect to refund)
    if (amount.isZero()) {
      log(`Ignoring refund for 0 amount: ${details}`)
      return tx
    }

    const pendingSettlementsKey = `accounts:${accountId}:pending-settlements`
    const settlementKey = `accounts:${accountId}:pending-settlements:${amountId}`

    // TODO Also atomically check that the account still exists? Use a WATCH on the account?
    return redis
      .multi()
      .zadd(pendingSettlementsKey, '0', amountId)
      .hset(settlementKey, 'amount', amount.toFixed())
  }
})
