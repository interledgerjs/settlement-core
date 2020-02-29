import BigNumber from 'bignumber.js'
import Redis, { Redis as IoRedis, Pipeline, RedisOptions } from 'ioredis'
import { isValidAmount } from '.'
import { Brand } from '../utils'
import { promises as fs } from 'fs'
import { resolve } from 'path'

/**
 * Redis Key Namespace
 * =========================================
 *
 * accounts
 * - Set of identifiers for all active accounts
 *
 * accounts:[account-id]:settlement-requests:[idempotency-key]
 * - Hash of each request from connector to send an outgoing settlement, set to expire 24 hours after the most recent request.
 *   `amount` -- Arbitrary precision string of amount queued for settlement
 *
 * accounts:[account-id]:pending-settlements
 * - Sorted set of pending settlement amount IDs, sorted by the UNIX timestamp of the lease expiration in milliseconds.
 * - Since Redis does not support arbitrary precision arithmetic/manipulation, a single settlement may be comprised
 *   of multiple settlement amounts, each with a unique ID, tracked by the client.
 * - When a settlement begins, a lease is created on one or multiple of these settlement amounts
 *   so the funds cannot be double spent until the lease expires or the settlement is committed.
 *
 * accounts:[account-id]:pending-settlements:[amount-id]
 * - Hash of each pending outgoing settlement
 *   `amount`           -- Arbitrary precision string of the settlement amount
 *   `lease_expiration` -- UNIX timestamp in milliseconds when the lease expires/this settlement can be retried
 *   `lease_nonce`      -- Nonce corresponding a unqiue settlement attempt to identify when this lock is released
 *
 * accounts:[account-id]:settlement-credits:[idempotency-key]
 * - Hash of each request to connector to credit an incoming settlement
 *   `amount`               -- Arbitrary precision string of amount to credit as an incoming settlement
 *   `next_retry_timestamp` -- UNIX timestamp in milliseconds after which the next request may be attempted
 *   `num_attempts`         -- Number of requests to the connector attempted to credit the settlement
 *   `idempotency_key`      -- Unique string for Idempotency-Key header, typically a UUID
 *   `account_id`           -- Account the settlement should be credited to
 *
 * pending-settlement-credits
 * - Sorted set of keys for corresponding credit hashes, sorted by UNIX timestamp of the next retry in milliseconds
 */

// TODO
// export interface DecoratedPipeline extends Pipeline {
//   bar(): Pipeline
// }

declare module 'ioredis' {
  interface Pipeline {
    foo(): boolean
  }
}

// TODO Remove all of this
export { Pipeline as DecoratedPipeline }
export { IoRedis as DecoratedRedis }

/** Configuration options for the connection to the Redis database */
export interface RedisConfig extends RedisOptions {
  client?: IoRedis
  uri?: string
}

export const createRedisClient = async (config: RedisConfig = {}): Promise<IoRedis> => {
  const { client, uri, ...opts } = config

  /**
   * After a close reading of IORedis, options set by left params supercede
   * options set by right params (due to the use Lodash _.defaults):
   * https://github.com/luin/ioredis/blob/1baff479b2abfb1cba73e84ce514b3330b2b0993/lib/redis/index.ts#L193
   */
  const redis = client || new Redis(uri, opts)

  const [
    createAccountScript,
    deleteAccountScript,
    addCreditScript,
    retryCreditScript,
    finalizeCreditScript,
    queueSettlementScript,
    prepareSettlementScript
  ] = await Promise.all(
    [
      // Account
      './scripts/account-create.lua', // TODO Remove/use JS?
      './scripts/account-delete.lua', // TODO Remove/use JS?
      // Credit
      './scripts/credit-add.lua',
      './scripts/credit-retry.lua',
      './scripts/credit-finalize.lua', // TODO Remove/use JS?
      // Settle
      './scripts/settlement-queue.lua',
      './scripts/settlement-prepare.lua'
    ].map(path => fs.readFile(resolve(__dirname, path)))
  ).then(buf => buf.toString())

  // Register scripts for account management

  redis.defineCommand('createAccount', {
    numberOfKeys: 0,
    lua: createAccountScript
  })

  redis.defineCommand('deleteAccount', {
    numberOfKeys: 0,
    lua: deleteAccountScript
  })

  // Register scripts for performing outgoing settlements

  redis.defineCommand('queueSettlement', {
    numberOfKeys: 0,
    lua: queueSettlementScript
  })

  redis.defineCommand('prepareSettlement', {
    numberOfKeys: 0,
    lua: prepareSettlementScript
  })

  // Register scripts for crediting incoming settlements

  redis.defineCommand('addSettlementCredit', {
    numberOfKeys: 0,
    lua: addCreditScript
  })

  redis.defineCommand('retrySettlementCredit', {
    numberOfKeys: 0,
    lua: retryCreditScript
  })

  redis.defineCommand('finalizeSettlementCredit', {
    numberOfKeys: 0,
    lua: finalizeCreditScript
  })

  return redis
}

/**
 * List of amounts available to settle, each with a unique ID to get around Redis' limitations
 * for manipulating BigNumbers. Flattened list of pairs of [amountId, amount]
 */
type SettlementAmounts = Brand<string[], 'SettlementAmounts'>

/** Is this a semantically valid list of amounts to settle from Redis? */
export const isSettlementAmounts = (o: any): o is SettlementAmounts =>
  Array.isArray(o) &&
  // Pairs of elements (id, amount)
  o.length % 2 === 0 &&
  // Every element is a string
  o.every(el => typeof el === 'string') &&
  // Ensure amounts are valid (all even elements: 1, 3, 5...)
  o
    .filter((_, i) => i % 2 !== 0)
    .map(el => new BigNumber(el))
    .every(isValidAmount)
