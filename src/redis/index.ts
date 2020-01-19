import BigNumber from 'bignumber.js'
import { ConnectorServices } from '../connector/services'
import { SettlementStore } from '../store'
import { RedisStoreServices, setupSettlementServices } from './services'
import { createRedisClient, DecoratedPipeline, DecoratedRedis, RedisConfig } from './database'
import { Brand, sleep } from '../utils'
import debug from 'debug'

export { RedisStoreServices, DecoratedPipeline, DecoratedRedis, RedisConfig }

const log = debug('settlement-core')

/** TODO */
const REDIS_CREDIT_POLL_INTERVAL_MS = 50

/** TODO */
const KEY_NAMESPACE_DELIMITER = ':'

// TODO Should I setup typedoc?

// TODO Make sure I add docs here

export type ConnectRedisSettlementEngine = (
  services: RedisStoreServices
) => Promise<RedisSettlementEngine>

/**
 * TODO
 * Essential functionality to send and receive payments with peers
 * that every settlement engine must provide
 */
export interface RedisSettlementEngine {
  /**
   * Setup the given account and perform tasks as a pre-requisite to send settlements
   * - For example, send a message to the peer to exchange ledger identifiers
   * @param accountId Unique account identifier
   * @return Optional Redis transaction to atomically execute while creating the account
   */
  setupAccount?(accountId: SafeKey): Promise<DecoratedPipeline | void>

  /**
   * Delete or close the given account
   * - For example, clean up database records associated with the account
   * @param accountId Unique account identifier
   * @return Optional Redis transaction to atomically execute while deleting the account
   */
  closeAccount?(accountId: SafeKey): Promise<DecoratedPipeline | void>

  /**
   * Handle and respond to an incoming message from the given peer
   * @param accountId Unique account identifier
   * @param message Parsed JSON message from peer
   * @return Response message, to be serialized as JSON
   */
  handleMessage?(accountId: SafeKey, message: any): Promise<any>

  /**
   * Send a settlement to the peer for up to the given amount
   * - Use `prepareSettlement` callback to fetch the amount and commit the settlement
   * @param accountId Unique identifier of account to settle with
   */
  settle(accountId: SafeKey): Promise<void>

  /** Disconnect the settlement engine and gracefully close ledger connections */
  disconnect?(): Promise<void>
}

export const connectRedisStore = async (
  createEngine: ConnectRedisSettlementEngine,
  connectorServices: ConnectorServices,
  redisConfig: RedisConfig
): Promise<SettlementStore> => {
  const redis = await createRedisClient(redisConfig)

  const { sendMessage, sendCreditRequest } = connectorServices

  // Callback to send a request to connector to credit a settlement and if successful, finalize in Redis
  const notifyAndFinalizeCredit = tryToFinalizeCredit(redis)(sendCreditRequest)

  // Setup account services: callbacks to send messages, credit settlements, etc. to pass to the settlement engine
  const accountServices: RedisStoreServices = {
    redis,
    sendMessage,
    ...setupSettlementServices(redis, notifyAndFinalizeCredit)
  }

  // Create background task to poll Redis for when to retry notifying the connector of incoming settlements
  const stopCreditLoop = startCreditLoop(redis, notifyAndFinalizeCredit)

  // Connect the settlement engine
  const engine = await createEngine(accountServices)

  // TODO Try to settle with all accounts for queued settlements

  return {
    ...engine.handleMessage?.bind(engine),

    async createAccount(accountId) {
      // TODO Check for safe key
      return (await redis.sadd('accounts', accountId)) === 0 // SADD returns number of elements added to set
    },

    async isExistingAccount(accountId) {
      // TODO CHeck for safe key
      return (await redis.sismember('accounts', accountId)) === 1
    },

    async deleteAccount(accountId) {
      // TODO Check for safe key
      await redis.deleteAccount(accountId)
    },

    async handleSettlementRequest(accountId, idempotencyKey, amount) {
      if (!isSafeKey(accountId)) {
        return Promise.reject(new Error('Account ID contains unsafe characters'))
      }

      if (!isSafeKey(idempotencyKey)) {
        return Promise.reject(new Error('Idempotency key contains unsafe characters'))
      }

      if (!isValidAmount) {
        // TODO Implement this!
      }

      // TODO Perform validation on accountId? Amount? Or should error handling be in server code?

      const amountQueued = await redis.queueSettlement(accountId, idempotencyKey, amount.toFixed())

      // TODO Add logs here

      // Attempt to perform a settlement
      engine.settle(accountId)

      return new BigNumber(amountQueued)
    },

    async disconnect() {
      await stopCreditLoop()
      redis.disconnect()
    }
  }
}

/** TODO doc */
export type SafeKey = Brand<string, 'SafeKey'>

/** TODO doc */
export const isSafeKey = (o: any): o is SafeKey =>
  typeof o === 'string' && o.length > 0 && !o.includes(KEY_NAMESPACE_DELIMITER)

/** TODO doc */
export type ValidAmount = Brand<BigNumber, 'ValidAmount'>

/** Is the given amount a valid BigNumber, finite, and non-negative (positive or 0)? */
export const isValidAmount = (o: any): o is ValidAmount =>
  BigNumber.isBigNumber(o) && o.isGreaterThanOrEqualTo(0) && o.isFinite()

/** Credit an incoming settlement to the account's balance */
export type CreditSettlement = (
  accountId: SafeKey,
  idempotencyKey: SafeKey,
  amount: ValidAmount
) => Promise<void>

// prettier-ignore

/**
 * Create callback to send a request to the connector to credit an incoming settlement
 * and finalize the credited settlement in Redis if successful.
 */
export const tryToFinalizeCredit =
    (redis: DecoratedRedis) =>
    (sendCreditRequest: CreditSettlement): CreditSettlement =>
    (accountId, idempotencyKey, amount) =>
      sendCreditRequest(accountId, idempotencyKey, amount)
        .then(async () => {
          await redis.finalizeSettlementCredit(accountId, idempotencyKey)
          log(`Connector credited settlement: account=${accountId} amount=${amount}, idempotencyKey=${idempotencyKey}`)
        })
        .catch(err => // TODO Include the error here!
          log(`Connector failed to credit settlement, will retry: account=${accountId} amount=${amount}, idempotencyKey=${idempotencyKey}`)
        )

type StopCreditLoop = () => Promise<void>

/**
 * Start polling Redis for queued settlement credits to notify the connector
 * @param redis Connected ioredis client decorated with custom Lua scripts
 * @param notifyConnector Callback to send HTTP request to connector to notify accounting system of incoming settlement
 * @return Callback to stop polling, returning a Promise that resolves when the loop ends
 */
export const startCreditLoop = (
  redis: DecoratedRedis,
  sendCreditRequest: CreditSettlement
): StopCreditLoop => {
  let terminate = false

  const creditLoop = (async () => {
    while (true) {
      if (terminate) {
        return
      }

      // TODO Log error, but throttle so the logs don't fill up
      const credit = await redis.retrySettlementCredit().catch(() => null)
      if (!credit) {
        await sleep(REDIS_CREDIT_POLL_INTERVAL_MS)
        continue
      }

      const [accountId, idempotencyKey] = credit
      const amount = new BigNumber(credit[2])

      // TODO Validate accountId is SafeKey -- or update schema to say it MUST return a SafeKey?
      sendCreditRequest(accountId, idempotencyKey, amount)

      // Keep sending notifications with no delay until the queue is empty
    }
  })()

  return () => {
    terminate = true
    return creditLoop
  }
}
