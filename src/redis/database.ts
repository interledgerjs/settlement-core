import BigNumber from 'bignumber.js'
import Redis, { MultiOptions, Pipeline, Redis as IoRedis, RedisOptions } from 'ioredis'
import { SafeKey } from '.'
import { Brand } from '../utils'
import DeleteAccountScript from './scripts/account/delete-account.lua'
import AddCreditScript from './scripts/credit/add-credit.lua'
import FinalizeCreditScript from './scripts/credit/finalize-credit.lua'
import RetryCreditScript from './scripts/credit/retry-credit.lua'
import CommitSettlementScript from './scripts/settle/commit-settlement.lua'
import PrepareSettlementScript from './scripts/settle/prepare-settlement.lua'
import QueueSettlementScript from './scripts/settle/queue-settlement.lua'

// TODO Rename this file to... database ?

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
 * - Arbitrary precision string of the settlement amount corresponding to the amount ID
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

// TODO Add docs to all of this!

// TODO Add stronger type checking to all of this

export interface DecoratedPipeline extends Pipeline {
  commitSettlement(accountId: SafeKey, ...amountIds: string[]): DecoratedPipeline
  addSettlementCredit(
    accountId: SafeKey,
    idempotencyKey: SafeKey,
    amount: string
  ): DecoratedPipeline
}

export interface DecoratedRedis extends IoRedis {
  multi(commands?: string[][], options?: MultiOptions): DecoratedPipeline
  multi(options: { pipeline: false }): Promise<string>
  queueSettlement(accountId: SafeKey, idempotencyKey: SafeKey, amount: string): Promise<string>
  prepareSettlement(accountId: SafeKey, leaseDuration: number): Promise<string[]>
  retrySettlementCredit(): Promise<[string, string, string] | null>
  finalizeSettlementCredit(accountId: SafeKey, idempotencyKey: SafeKey): Promise<void>
  deleteAccount(accountId: SafeKey): Promise<void>
}

/** Configuration options for the connection to the Redis database */
export interface RedisConfig extends RedisOptions {
  client?: IoRedis
  uri?: string
}

export const createRedisClient = async (config: RedisConfig = {}): Promise<DecoratedRedis> => {
  const { client, uri, ...opts } = config

  /**
   * After a close reading of IORedis, options set by left params supercede
   * options set by right params (due to the use Lodash _.defaults):
   * https://github.com/luin/ioredis/blob/1baff479b2abfb1cba73e84ce514b3330b2b0993/lib/redis/index.ts#L193
   */
  const redis = client || new Redis(uri, opts)

  await redis.connect()

  // Register scripts for account management

  redis.defineCommand('deleteAccount', {
    numberOfKeys: 0,
    lua: DeleteAccountScript
  })

  // Register scripts for performing outgoing settlements

  redis.defineCommand('queueSettlement', {
    numberOfKeys: 0,
    lua: QueueSettlementScript
  })

  redis.defineCommand('prepareSettlement', {
    numberOfKeys: 0,
    lua: PrepareSettlementScript
  })

  redis.defineCommand('commitSettlement', {
    numberOfKeys: 0,
    lua: CommitSettlementScript
  })

  // Register scripts for crediting incoming settlements

  redis.defineCommand('addSettlementCredit', {
    numberOfKeys: 0,
    lua: AddCreditScript
  })

  redis.defineCommand('retrySettlementCredit', {
    numberOfKeys: 0,
    lua: RetryCreditScript
  })

  redis.defineCommand('finalizeSettlementCredit', {
    numberOfKeys: 0,
    lua: FinalizeCreditScript
  })

  return redis as DecoratedRedis
}

// TODO Explain what a settlement amount is and the rationale for this design
type SettlementAmount = Brand<string[], 'SettlementAmount'>

export const isSettlementAmount = (o: any): o is SettlementAmount =>
  Array.isArray(o) &&
  o.length > 0 && // At least one amount
  o.length % 2 === 0 && // Pairs of elements (id, amount)
  o.every(el => typeof el === 'string') && // Every element is a string
  o // Ensure valid amounts (all even elements: 1, 3, 5...)
    .filter((_, i) => i % 2 !== 0)
    .every(amount => {
      const bn = new BigNumber(amount)
      return bn.isGreaterThanOrEqualTo(0) && bn.isFinite()
    })
