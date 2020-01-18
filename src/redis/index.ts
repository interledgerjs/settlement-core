import BigNumber from 'bignumber.js'
import debug from 'debug'
import { ConnectorServices } from '../connector/services'
import { SafeKey, SettlementStore } from '../store'
import { AccountServices, setupSettlementServices } from './account-services'
import { startCreditLoop } from './notify-settlement'
import { createRedisClient, DecoratedPipeline, RedisConfig } from './scripts/create-client'

// TODO Should I setup typedoc?

// TODO Make sure I add docs here

export type ConnectRedisSettlementEngine = (
  services: AccountServices
) => Promise<RedisSettlementEngine>

// TODO
// - How should the admin API functionality be extended/shared between a Store, Core, and the SE?
//      One idea: what if it provided an express server or function that could be extended?
//
// - Should an express `app` be passed from startServer -> store -> SE?

/**
 * TODO Add docs for this type
 *
 * "acquire lease"
 *
 * Put funds on hold to perform async tasks before executing a settlement.
 * Funds will be refunded & retried later if the lease expires before the settlement is committed.
 * @param leaseDuration
 * @returns Maximum amount to settle, in standard unit of the asset (arbitrary precision)
 *
 * Redis transaction which removes the settlement as pending, or fails if the lease already expired.
 * The consumer should execute this transaction directly before unconditionally performing the settlement,
 * with custom logic to rollback the settlement in case of failure. TODO
 */
export type PrepareSettlement = (leaseDuration: number) => Promise<[BigNumber, DecoratedPipeline]>

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
   * - Since the amount is provided in arbitrary precision, round to the correct
   *   precision first
   * - Use `prepare` to fetch the amount to settle and commitment transaction
   * - Execute the returned commitment transaction before unconditionally preforming the settlement
   *   to safely rollback in case of failure
   * @param accountId Unique identifier of account to settle with
   * @param prepare Callback to put funds on hold to begin the settlement. Returns the amount
   *        to settle and transaction to commit before unconditionally performing the settlement.
   */
  settle(accountId: SafeKey, prepare: PrepareSettlement): Promise<void>

  /** Disconnect the settlement engine and gracefully close ledger connections */
  disconnect?(): Promise<void>
}

export const connectRedisStore = async (
  createEngine: ConnectRedisSettlementEngine,
  { sendMessage, sendCreditNotification }: ConnectorServices,
  redisConfig: RedisConfig
): Promise<SettlementStore> => {
  const redis = createRedisClient(redisConfig)

  const log = debug('settlement-core:redis')

  // Setup account services: callbacks to send messages, credit settlements, etc. to pass to the settlement engine
  const accountServices: AccountServices = {
    redis,
    sendMessage,
    ...setupSettlementServices(redis, sendCreditNotification)
  }

  // Create background task to poll Redis for when to retry notifying the connector of incoming settlements
  const stopCreditLoop = startCreditLoop(redis, sendCreditNotification)

  // Connect the settlement engine
  const engine = await createEngine(accountServices)

  // TODO Try to settle with all accounts for queued settlements

  return {
    async createAccount(accountId) {
      return (await redis.sadd('accounts', accountId)) === 0 // SADD returns number of elements added to set
    },
    async isExistingAccount(accountId) {
      return (await redis.sismember('accounts', accountId)) === 1
    },
    async deleteAccount(accountId) {
      await redis.deleteAccount(accountId)
    },
    async handleSettlementRequest(accountId, idempotencyKey, amount) {
      // TODO Perform validation on accountId? Amount? Or should error handling be in server code?

      const amountQueued = await redis.queueSettlement(accountId, idempotencyKey, amount.toFixed())

      // TODO Add logs here

      // Attempt to perform a settlement
      accountServices.trySettlement(accountId, engine.settle) // TODO Will passing engine.settle as function cause issues? Should I use an internal callback?

      return new BigNumber(amountQueued)
    },
    async disconnect() {
      await stopCreditLoop()
      redis.disconnect()
    }
  }
}
