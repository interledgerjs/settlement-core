import BigNumber from 'bignumber.js'

// TODO Move logic from the controller into this file? (e.g. other controllers)

export interface ConnectorServices {
  notifySettlement(
    accountId: string,
    idempotencyKey: string,
    amount: BigNumber
  ): Promise<void>
  sendMessage(accountId: string, message: any): Promise<any>
}
