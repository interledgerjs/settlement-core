import axios from 'axios'
import BigNumber from 'bignumber.js'
import { isValidAmount } from '../redis'
import debug from 'debug'

const log = debug('settlement-core')

export interface ConnectorServices {
  // TODO resolves if acked, rejects if not
  sendCreditRequest(accountId: string, idempotencyKey: string, amount: BigNumber): Promise<void>
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
    let details = `amountToCredit=${amount} account=${accountId} idempotencyKey=${idempotencyKey}`

    // TODO Should this logic even be here? Can I do anything about it? It should never get added to the DB in the first place

    if (amount.isZero()) {
      return
    }

    // TODO Validate the resulting quantity instead of the amount? idk
    if (!isValidAmount(amount)) {
      return log(`Error: Failed to credit settlement, invalid amount: ${details}`)
    }

    // TODO quantity to credit
    // amountToCredit must be positive and finite due to validation on amount & uncreditedAmounts
    // ...so this Quantity should always be valid
    const scale = amount.decimalPlaces()
    const quantityToCredit = {
      scale,
      amount: amount.shiftedBy(scale).toFixed(0) // `toFixed` always uses normal (not exponential) notation
    }

    // TODO Validate the quantity instead of the amount so I don't have an import from Redis

    // TODO How to handle promise rejections here?
    const { status } = await axios({
      method: 'POST',
      url: `${config.creditSettlementUrl}/accounts/${accountId}/settlements`,
      data: quantityToCredit,
      timeout: 10000,
      headers: {
        'Idempotency-Key': idempotencyKey
      }
    })

    if (status !== 201) {
      return Promise.reject('TODO error crediting settlement')
    }

    log(`Connector credited incoming settlement ${details}`)
  },

  async sendMessage(accountId, message) {
    const url = `${config.sendMessageUrl}/accounts/${accountId}/messages`
    return axios
      .post(url, Buffer.from(JSON.stringify(message)), {
        timeout: 10000,
        headers: {
          'Content-type': 'application/octet-stream'
        }
      })
      .then(response => response.data)
  }
})
