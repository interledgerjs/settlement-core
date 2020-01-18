import BigNumber from 'bignumber.js'
import { Brand } from './connector/quantity'
import { ConnectorServices } from './connector/services'

// TODO Should SafeKey be moved to utils?

const KEY_NAMESPACE_DELIMITER = ':'

export type SafeKey = Brand<string, 'SafeKey'>

export const isSafeKey = (o: any): o is SafeKey =>
  typeof o === 'string' && !o.includes(KEY_NAMESPACE_DELIMITER)

export type CreateStore = (services: ConnectorServices) => Promise<SettlementStore>

export interface SettlementStore {
  /**
   * Create an account with the given ID
   *
   * @param accountId Unique account identifier
   * @return Did the account already exist?
   */
  createAccount(accountId: SafeKey): Promise<boolean>

  /**
   * Has the given account been instantiated via a call from the connector?
   *
   * @param accountId Unique account identifier
   */
  isExistingAccount(accountId: SafeKey): Promise<boolean>

  /**
   * Delete all state associated with the given account
   *
   * @param accountId Unique account identifier
   */
  deleteAccount(accountId: SafeKey): Promise<void>

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
    accountId: SafeKey,
    idempotencyKey: SafeKey,
    amount: BigNumber
  ): Promise<BigNumber>

  /**
   * Handle and respond to an incoming message from the given peer
   *
   * @param accountId Unique account identifier
   * @param message Parsed JSON message from peer
   * @return Response message, to be serialized as JSON
   */
  handleMessage?(accountId: string, message: any): Promise<any>

  /** Shutdown the database connection */
  disconnect?(): Promise<void>
}
