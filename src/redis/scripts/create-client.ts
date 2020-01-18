import BigNumber from 'bignumber.js'
import Redis, { MultiOptions, Pipeline, Redis as IoRedis, RedisOptions } from 'ioredis'
import { Brand } from '../../connector/quantity'
import DeleteAccountScript from './account/delete-account.lua'
import AddCreditScript from './credit/add-credit.lua'
import FinalizeCreditScript from './credit/finalize-credit.lua'
import RetryCreditScript from './credit/retry-credit.lua'
import CommitSettlementScript from './settle/commit-settlement.lua'
import PrepareSettlementScript from './settle/prepare-settlement.lua'
import QueueSettlementScript from './settle/queue-settlement.lua'

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
 * TODO Should I rename this slightly? e.g. "settlement-debits" or "settlement-amounts" ?
 * accounts:[account-id]:pending-settlements
 * - Sorted set of pending settlement IDs, sorted by the UNIX timestamp of the lease expiration in milliseconds.
 *   A total settlement may be the sum of several of these settlement amounts.
 *   When a settlement begins, a lease is created so the funds cannot be double spent until it expires or is committed.
 *
 * accounts:[account-id]:pending-settlements:[settlement-id]
 * - Arbitrary precision string of the amount corresponding to the settlement ID
 *
 * accounts:[account-id]:settlement-credits:[idempotency-key]
 * - Hash of each request to connector to credit an incoming settlement
 *   `amount`               -- Arbitrary precision string of amount to credit as an incoming settlement
 *   `next_retry_timestamp` -- UNIX timestamp in milliseconds after which the next request may be attempted
 *   `num_attempts`         -- Number of requests to the connector attempted to credit the settlement
 *   `idempotency_key`      -- Unique string for Idempotency-Key header, typically a UUID or settlement ID
 *   `account_id`           -- Account identifier the settlement should be credited to
 *
 * pending-settlement-credits
 * - Sorted set of keys for corresponding credit hashes, sorted by UNIX timestamp of the next retry in milliseconds
 */

// TODO Add docs to all of this!

export interface DecoratedPipeline extends Pipeline {
  commitSettlement(accountId: string, ...amountIds: string[]): DecoratedPipeline
  addSettlementCredit(accountId: string, idempotencyKey: string, amount: string): DecoratedPipeline
}

export interface DecoratedRedis extends IoRedis {
  multi(commands?: string[][], options?: MultiOptions): DecoratedPipeline
  multi(options: { pipeline: false }): Promise<string>
  queueSettlement(accountId: string, idempotencyKey: string, amount: string): Promise<string>
  prepareSettlement(accountId: string, leaseDuration: number): Promise<string[]>
  retrySettlementCredit(): Promise<[string, string, string] | null>
  finalizeSettlementCredit(accountId: string, idempotencyKey: string): Promise<void>
  deleteAccount(accountId: string): Promise<void>
}

/** Configuration options for the connection to the Redis database */
export interface RedisConfig extends RedisOptions {
  client?: IoRedis
  uri?: string
}

export const createRedisClient = ({ client, uri, ...opts }: RedisConfig = {}): DecoratedRedis => {
  /**
   * After a close reading of IORedis, options set by left params supercede
   * options set by right params (due to the use Lodash _.defaults):
   * https://github.com/luin/ioredis/blob/1baff479b2abfb1cba73e84ce514b3330b2b0993/lib/redis/index.ts#L193
   */
  const redis = client || new Redis(uri, opts)

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

  // TODO Return Promise and wait for Redis to connect?

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
