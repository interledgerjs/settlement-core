import BigNumber from 'bignumber.js'
import { ConnectorServices } from './connector/services'

export type CreateStore = (services: ConnectorServices) => Promise<SettlementStore>

export interface SettlementStore {
  /**
   * Create an account with the given ID
   * @param accountId Unique account identifier
   * @return Did the account already exist?
   */
  createAccount(accountId: string): Promise<boolean>

  /**
   * Delete all state associated with the given account
   * @param accountId Unique account identifier
   */
  deleteAccount(accountId: string): Promise<void>

  /**
   * Save the amount to settle corresponding to the given idempotency key
   * - If the idempotency key is already cached, return the amount already queued for settlement
   * - If the idempotency key is new, queue the amount for settlement and save the idempotency key,
   *   returning the same amount
   *
   * @param accountId Unique account identifier
   * @param idempotencyKey Unique identifier for this settlement request
   * @param amount Amount to queue for settlement corresponding to this idempotency key
   * @return Amount queued for settlement corresponding to this idempotency key
   */
  handleSettlementRequest(
    accountId: string,
    idempotencyKey: string,
    amount: BigNumber
  ): Promise<BigNumber>

  /**
   * Handle and respond to an incoming message from the given peer
   *
   * @param accountId Unique account identifier
   * @param message Parsed JSON message from peer
   * @return Response message, to be serialized as JSON
   */
  handleMessage(accountId: string, message: object): Promise<object | void>

  /** Shutdown the database connection */
  disconnect?(): Promise<void>
}
