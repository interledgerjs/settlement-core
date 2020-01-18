import BigNumber from 'bignumber.js'
import debug from 'debug'
import { Dictionary, RequestHandler } from 'express-serve-static-core'
import uuid from 'uuid/v4'
import { isSafeKey, SafeKey, SettlementStore } from '../store'
import { fromQuantity, isQuantity } from './quantity'

const log = debug('settlement-core')

interface AccountParams extends Dictionary<string> {
  id: SafeKey
}

// TODO Add docs here!
interface ConnectorRequestController {
  setupAccount: RequestHandler
  validateAccount: RequestHandler // TODO Should I have validateAccount just exist as a separate function called by each?
  settleAccount: RequestHandler<AccountParams>
  handleMessage: RequestHandler<AccountParams>
  deleteAccount: RequestHandler<AccountParams>
}

export const createController = (store: SettlementStore): ConnectorRequestController => ({
  async setupAccount(req, res) {
    const accountId = req.body.id || uuid() // Create account ID if none was provided
    if (!isSafeKey(accountId)) {
      return res.status(400).send('Account ID includes unsafe characters')
    }

    /**
     * TODO
     * Before creating the accout/calling setup, ensure the peer is reachable:
     * Try pinging them and await either a response or a ping from said peer?
     */

    try {
      await store.createAccount(accountId)
    } catch (err) {
      log(`Failed to setup account: account=${accountId}`, err)
      return res.sendStatus(500)
    }

    res.status(201).send({
      id: accountId
    })
  },

  async validateAccount(req, res, next) {
    const accountId = req.params.id
    if (!isSafeKey(accountId)) {
      return res.status(400).send('Account ID is missing or includes unsafe characters')
    }

    const accountExists = await store.isExistingAccount(accountId)
    return !accountExists ? res.status(404).send(`Account doesn't exist`) : next()
  },

  async settleAccount(req, res) {
    const accountId = req.params.id
    let details = `account=${accountId}`

    const idempotencyKey = req.get('Idempotency-Key')
    if (!isSafeKey(idempotencyKey)) {
      log(`Request to settle failed: idempotency key missing or unsafe: ${details}`)
      return res.status(400).send('Idempotency key missing or includes unsafe characters')
    }

    details += ` idempotencyKey=${idempotencyKey}`

    const requestQuantity = req.body
    if (!isQuantity(requestQuantity)) {
      log(`Request to settle failed: invalid quantity: ${details}`)
      return res.status(400).send('Quantity to settle is invalid')
    }

    const amountToQueue = fromQuantity(requestQuantity)
    details += ` amount=${amountToQueue}`

    if (amountToQueue.isZero()) {
      log(`Request to settle failed: amount is 0: ${details}`)
      return res.status(400).send('Amount to settle is 0')
    }

    let amountQueued: BigNumber
    try {
      amountQueued = await store.handleSettlementRequest(accountId, idempotencyKey, amountToQueue)
    } catch (err) {
      log(`Error: Failed to queue settlement: ${details}`, err)
      return res.sendStatus(500)
    }

    // If the cached amount for that idempotency key is not the same... the client likely sent
    // a request with the same idempotency key, but a different amount
    if (!amountToQueue.isEqualTo(amountQueued)) {
      log(`Request to settle failed: reused idempotency key: ${details} oldAmount=${amountQueued}`)
      return res.status(400).send('Idempotency key was reused with a different amount')
    }

    res.sendStatus(201)
  },

  async handleMessage(req, res) {
    const accountId = req.params.id

    if (!store.handleMessage) {
      log(`Received incoming message that settlement engine cannot handle: account=${accountId}`)
      return res.status(400).send('Settlement engine does not support incoming messages')
    }

    try {
      const response = await store.handleMessage(accountId, JSON.parse(req.body))

      const rawResponse = Buffer.from(JSON.stringify(response))
      res.status(201).send(rawResponse)
    } catch (err) {
      log(`Error while handling message: account=${accountId}`, err)
      res.sendStatus(500)
    }
  },

  async deleteAccount(req, res) {
    const accountId = req.params.id

    try {
      await store.deleteAccount(accountId)
      res.sendStatus(204)
    } catch (err) {
      log(`Failed to delete account: account=${accountId}`, err)
      res.sendStatus(500)
    }
  }
})
