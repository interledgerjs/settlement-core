import BigNumber from 'bignumber.js'
import bodyParser from 'body-parser'
import debug from 'debug'
import express, { Express } from 'express'
import uuid from 'uuid/v4'
import { SettlementStore } from '../store'
import { fromQuantity, isQuantity } from './quantity'

const log = debug('settlement-core')

/** Create settlement engine server to handle requests from connector */
export const createController = (store: SettlementStore): Express => {
  const app = express()

  // Setup new accounts
  app.post('/accounts', bodyParser.json(), async (req, res) => {
    const accountId = req.body.id || uuid() // Create account ID if none was provided

    try {
      await store.createAccount(accountId)
    } catch (err) {
      log(`Failed to setup account: account=${accountId}`, err)
      return res.sendStatus(500)
    }

    res.sendStatus(201)
  })

  // Delete accounts
  app.delete('/accounts/:id', async (req, res) => {
    const accountId = req.params.id

    try {
      await store.deleteAccount(accountId)
      res.sendStatus(204)
    } catch (err) {
      log(`Failed to delete account: account=${accountId}`, err)
      res.sendStatus(500)
    }
  })

  // Perform outgoing settlements
  app.post('/accounts/:id/settlements', bodyParser.json(), async (req, res) => {
    const accountId = req.params.id
    let details = `account=${accountId}`

    const idempotencyKey = req.get('Idempotency-Key')
    if (!idempotencyKey) {
      log(`Request to settle failed: idempotency key missing: ${details}`)
      return res.status(400).send('Idempotency key missing')
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
  })

  // Respond to incoming messages
  app.post('/accounts/:id/messages', bodyParser.raw(), async (req, res) => {
    const accountId = req.params.id
    res.type('buffer')

    try {
      const parsedData = JSON.parse(req.body)
      if (!parsedData || typeof parsedData !== 'object') {
        return res.status(400).send('Engine only supports JSON messages')
      }

      const response = await store.handleMessage(accountId, parsedData)
      if (!response) {
        return res.sendStatus(201)
      }

      const rawResponse = Buffer.from(JSON.stringify(response))
      res.status(201).send(rawResponse)
    } catch (err) {
      log(`Error while handling message: account=${accountId}`, err)
      res.sendStatus(500)
    }
  })

  return app
}
