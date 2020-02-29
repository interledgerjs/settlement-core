import axios from 'axios'
import BigNumber from 'bignumber.js'
import { isQuantity } from './quantity'

/** Callbacks to send requests to the connector's webhooks */
export interface ConnectorServices {
  /**
   * Send a single request to the connector to credit an incoming settlement. Resolves if successfully credited.
   * @param accountId Unique account identifier to credit the balance to
   * @param idempotencyKey Unique string identifying this settlement
   * @param amount Amount to credit in the standard unit of the asset, in arbitrary precision
   */
  sendCreditRequest(accountId: string, idempotencyKey: string, amount: BigNumber): Promise<void>

  /**
   * Send a message to the peer's settlement engine and return its response
   * @param accountId Account corresponding to peer settlement engine to handle message
   * @param message Body of message, serializable as JSON object
   * @return Response message from peer, which should be parsed as JSON
   */
  sendMessage(accountId: string, message: any): Promise<any>
}

interface ConnectorConfig {
  /** Connector URL to send requests to send messages to the peer's settlement engine */
  sendMessageUrl: string

  /** Connector URL to send requests to credit an incoming settlement to its accounting system */
  creditSettlementUrl: string
}

export const createConnectorServices = (config: ConnectorConfig): ConnectorServices => ({
  async sendCreditRequest(accountId, idempotencyKey, amount) {
    if (amount.isZero()) {
      return Promise.reject(new Error('Cannot request connector to credit amount for 0'))
    }

    const scale = amount.decimalPlaces()
    const quantityToCredit = {
      scale,
      amount: amount.shiftedBy(scale).toFixed(0) // `toFixed` always uses normal (not exponential) notation
    }

    if (!isQuantity(quantityToCredit)) {
      return Promise.reject(new Error('Cannot request connector to credit an invalid amount'))
    }

    // Caller should handle/log in response to all Promise rejections
    await axios({
      method: 'POST',
      url: `${config.creditSettlementUrl}/accounts/${accountId}/settlements`,
      data: quantityToCredit,
      timeout: 10000,
      headers: {
        'Idempotency-Key': idempotencyKey
      },
      validateStatus: status => status === 201 // Only resolve Promise on `201 Created`
    })
  },

  async sendMessage(accountId, message) {
    return axios({
      method: 'POST',
      url: `${config.sendMessageUrl}/accounts/${accountId}/messages`,
      data: Buffer.from(JSON.stringify(message)),
      timeout: 10000,
      headers: {
        Accept: 'application/octet-stream',
        'Content-type': 'application/octet-stream'
      }
    }).then(response => response.data)
  }
})
