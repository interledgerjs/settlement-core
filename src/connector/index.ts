import debug from 'debug'
import { createController } from './controller'
import { createConnectorServices } from './services'
import { CreateStore } from '../store'

const log = debug('settlement-core')

/** Config for settlement engine to communicate with the connector */
export interface SettlementServerConfig {
  /** Base URL of connector for requests to credit settlements or send messages */
  connectorUrl?: string

  /** Base URL of connector to send an outgoing message to peer. Overrides `connectorUrl` */
  sendMessageUrl?: string

  /** Base URL of connector to credit an incoming settlement. Overrides `connectorUrl` */
  creditSettlementUrl?: string

  /** Port of server servicing incoming requests from connector */
  port?: string | number
}

export interface SettlementServer {
  /** Stop the server interacting with the connector, disconnect the store and settlement engine */
  shutdown(): Promise<void>
}

export const startServer = async (
  createStore: CreateStore,
  config: SettlementServerConfig = {}
): Promise<SettlementServer> => {
  const connectorUrl = config.connectorUrl || 'http://localhost:7771'

  const sendMessageUrl = config.sendMessageUrl || connectorUrl
  const creditSettlementUrl = config.creditSettlementUrl || connectorUrl

  // Create servers for outgoing webhooks to connector
  const services = createConnectorServices({ sendMessageUrl, creditSettlementUrl })

  const store = await createStore(services)

  // Create server for incoming requests from connector
  const app = createController(store)

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
