import bodyParser from 'body-parser'
import debug from 'debug'
import express from 'express'
import { createController } from './controller'
import { createConnectorServices } from './services'
import { CreateStore } from '../store'

const log = debug('settlement-core')

// TODO Rename this to "connectorServer" or something like that? startConnectorService?

export interface SettlementServerConfig {
  connectorUrl?: string
  sendMessageUrl?: string
  creditSettlementUrl?: string
  port?: string | number
}

export interface SettlementServer {
  /** Stop the server interacting with the connector and disconnect the settlement engine */
  shutdown(): Promise<void>
}

export const startServer = async (
  createStore: CreateStore,
  config: SettlementServerConfig = {}
): Promise<SettlementServer> => {
  const connectorUrl = config.connectorUrl || 'http://localhost:7771'

  const sendMessageUrl = config.sendMessageUrl || connectorUrl
  const creditSettlementUrl = config.creditSettlementUrl || connectorUrl

  // TODO Create the services and pass into the store
  const services = createConnectorServices({ sendMessageUrl, creditSettlementUrl })
  const store = await createStore(services)

  const {
    validateAccount,
    setupAccount,
    deleteAccount,
    settleAccount,
    handleMessage
  } = createController(store)

  const app = express()

  app.post('/accounts', bodyParser.json(), setupAccount)
  app.delete('/accounts/:id', validateAccount, deleteAccount)
  app.post('/accounts/:id/settlements', bodyParser.json(), validateAccount, settleAccount)
  app.post('/accounts/:id/messages', bodyParser.raw(), validateAccount, handleMessage)

  const port = config.port ? +config.port : 3000
  const server = app.listen(port)

  log('Started settlement engine server')

  return {
    async shutdown() {
      await new Promise(resolve => server.close(resolve))

      if (store.disconnect) {
        await store.disconnect()
      }
    }
  }
}
