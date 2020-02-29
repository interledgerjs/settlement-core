import BigNumber from 'bignumber.js'
import { ConnectorServices } from '../connector/services'
import { SettlementStore, CreateStore } from '../store'
import { RedisStoreServices, setupSettlementServices } from './services'
import { createRedisClient, DecoratedPipeline, DecoratedRedis, RedisConfig } from './database'
import { Brand, sleep, throttle } from '../utils'
import debug from 'debug'

export { RedisStoreServices, DecoratedPipeline, DecoratedRedis, RedisConfig }

const log = debug('settlement-core')

export type ConnectRedisSettlementEngine = (
  services: RedisStoreServices
) => Promise<RedisSettlementEngine>

/**
 * Essential functionality to send and receive payments with peers
 * using Redis as a database backend for accounting and persistence
 */
export interface RedisSettlementEngine {
  /**
   * Setup the given account and perform tasks as a pre-requisite to send settlements
   * - For example, send a message to the peer to exchange ledger identifiers
   * @param accountId Unique account identifier
   * @return Optional Redis transaction to atomically execute while creating the account
   */
  setupAccount?(accountId: SafeRedisKey): Promise<void>

  /**
   * Delete or close the given account
   * - For example, clean up database records associated with the account
   * @param accountId Unique account identifier
   * @return Optional Redis transaction to atomically execute while deleting the account
   */
  closeAccount?(accountId: SafeRedisKey): Promise<DecoratedPipeline | void>
  // TODO Is this the only thing specific to Redis? Could this be "SettlementEngine" instead of Redis-specific?

  /**
   * Handle and respond to an incoming message from the given peer
   * @param accountId Unique account identifier
   * @param message Parsed JSON message from peer
   * @return Response message, to be serialized as JSON
   */
  handleMessage(accountId: SafeRedisKey, message: any): Promise<any>

  /**
   * Send a settlement to the peer for up to the given amount
   * - Use `prepareSettlement` callback to fetch the amount and commit the settlement
   * @param accountId Unique identifier of account to settle with
   */
  settle(accountId: SafeRedisKey): Promise<void>

  /** Disconnect the settlement engine and gracefully close ledger connections */
  disconnect?(): Promise<void>
}

export const createRedisStore = (
  createEngine: ConnectRedisSettlementEngine,
  redisConfig?: RedisConfig
): CreateStore => async (connectorServices: ConnectorServices): Promise<SettlementStore> => {
  const redis = await createRedisClient(redisConfig)

  const { sendMessage, sendCreditRequest } = connectorServices

  // Setup account services: callbacks to send messages, credit settlements, etc. to pass to the settlement engine
  const accountServices: RedisStoreServices = {
    redis,
    sendMessage,
    ...setupSettlementServices(redis)
  }

  // Create background task to poll Redis for when to retry notifying the connector of incoming settlements
  const stopCreditLoop = startCreditLoop(redis, sendCreditRequest)

  // Connect the settlement engine
  const engine = await createEngine(accountServices)

  // TODO Try to settle with all accounts: Redis SCAN through accounts, then call `settle` on the engine for each of them

  return {
    // TODO Should all engines have to handle incoming messages?
    handleMessage(accountId, message) {
      if (!isSafeRedisKey(accountId)) {
        return Promise.reject(new Error('Account ID contains unsafe characters'))
      }

      if (engine.handleMessage) {
        return engine.handleMessage(accountId, message)
      } else {
        return Promise.reject(new Error('Settlement engine cannot handle incoming messages'))
      }
    },

    async createAccount(accountId) {
      if (!isSafeRedisKey(accountId)) {
        return Promise.reject(new Error('Account ID contains unsafe characters'))
      }

      if (engine.setupAccount) {
        await engine.setupAccount(accountId)
      }

      const didCreateAccount = (await redis.createAccount(accountId)) === 1
      return didCreateAccount
    },

    async deleteAccount(accountId) {
      if (!isSafeRedisKey(accountId)) {
        return Promise.reject(new Error('Account ID contains unsafe characters'))
      }

      const tx = (engine.closeAccount && (await engine.closeAccount(accountId))) || redis.multi()
      await tx.deleteAccount(accountId).exec()
    },

    async handleSettlementRequest(accountId, idempotencyKey, amount) {
      if (!isSafeRedisKey(accountId)) {
        return Promise.reject(new Error('Account ID contains unsafe characters'))
      }

      if (!isSafeRedisKey(idempotencyKey)) {
        return Promise.reject(new Error('Idempotency key contains unsafe characters'))
      }

      if (!isValidAmount(amount) || !amount.isGreaterThan(0)) {
        return Promise.reject(new Error('Invalid amount'))
      }

      const response = await redis.queueSettlement(accountId, idempotencyKey, amount.toFixed())

      const amountQueued = new BigNumber(response[0])
      const isOriginalRequest = response[1] === 1

      const details = `account=${accountId} amount=${amount} idempotencyKey=${idempotencyKey}`
      if (isOriginalRequest) {
        // Attempt to perform a settlement
        log(`Handling new request to settle, triggering settlement: ${details}`)
        engine.settle(accountId).catch(err => log(`Failed to settle: ${details}`, err))
      } else {
        log(`Handling retry request to settle, no settlement triggered: ${details}`)
      }

      return amountQueued
    },

    async disconnect() {
      await stopCreditLoop()
      redis.disconnect()
    }
  }
}

// TODO Move these helpers to separate files? `validate` and `credit-daemon`?

const REDIS_NAMESPACE_DELIMITER = ':'

/** String safe to use within a Redis key */
export type SafeRedisKey = Brand<string, 'SafeRedisKey'>

/** Is the this a safe, non-empty Redis key that doesn't break into another namespace? */
export const isSafeRedisKey = (o: any): o is SafeRedisKey =>
  typeof o === 'string' && o.length > 0 && !o.includes(REDIS_NAMESPACE_DELIMITER)

/** Amount safe to use in an accounting balance: not `NaN`, Infinity, or negative */
export type ValidAmount = Brand<BigNumber, 'ValidAmount'>

/** Is the given amount a BigNumber, finite, and non-negative (positive or 0)? */
export const isValidAmount = (o: any): o is ValidAmount =>
  BigNumber.isBigNumber(o) && o.isGreaterThanOrEqualTo(0) && o.isFinite()

/** Callback to credit an incoming settlement to the given account's balance */
export type CreditSettlement = (
  accountId: SafeRedisKey,
  idempotencyKey: SafeRedisKey,
  amount: ValidAmount
) => Promise<void>

/**
 * Start polling Redis for queued settlement credits to notify the connector
 * @param redis Connected ioredis client decorated with custom Lua scripts
 * @param notifyConnector Callback to send HTTP request to connector to notify accounting system of incoming settlement
 * @return Callback to stop polling, returning a Promise that resolves when the loop ends
 */
export const startCreditLoop = (redis: DecoratedRedis, sendCreditRequest: CreditSettlement) => {
  let terminate = false

  // If something goes very wrong, don't log too excessively
  const throttledLog = throttle(log, 30000)

  const creditLoop = (async () => {
    while (true) {
      if (terminate) {
        return
      }

      const credit = await redis
        .retrySettlementCredit()
        .catch(err => throttledLog('Failed to check for queued incoming settlements', err))
      if (!credit) {
        await sleep(50)
        continue
      }

      const [accountId, idempotencyKey] = credit
      const amount = new BigNumber(credit[2])

      if (!isSafeRedisKey(accountId) || !isSafeRedisKey(idempotencyKey) || !isValidAmount(amount)) {
        throttledLog(
          'Failed to notify connector of incoming settlements, database may be corrupted'
        )

        await sleep(50)
        continue
      }

      const details = `account=${accountId} amount=${amount} idempotencyKey=${idempotencyKey}`
      sendCreditRequest(accountId, idempotencyKey, amount)
        .then(async () => {
          await redis.finalizeSettlementCredit(accountId, idempotencyKey)
          log(`Connector credited incoming settlement: ${details}`)
        })
        .catch(err => log(`Connector failed to credit settlement, will retry: ${details}`, err))

      // Keep sending notifications with no delay until the queue is empty
    }
  })()

  return () => {
    terminate = true
    return creditLoop
  }
}
