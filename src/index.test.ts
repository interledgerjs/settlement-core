import axios from 'axios'
import { startServer, createRedisStore } from '.'
import BigNumber from 'bignumber.js'
import getPort from 'get-port'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import { randomBytes } from 'crypto'
import { ConnectRedisSettlementEngine } from './redis'
import { sleep } from './utils' // TODO remove?
import { LogWaitStrategy } from 'testcontainers/dist/wait-strategy'

// const log = debug('settlement-test')

describe('Integration with Rust connector', () => {
  let redisContainer: StartedTestContainer
  let adminAuthToken: string
  let rustNodeContainer: StartedTestContainer
  let shutdownEngine: () => Promise<void>

  jest.setTimeout(600000) // TODO Reduce?

  beforeEach(async () => {
    // TODO Also test Java & multiple accounts/SE instances!
    // const javaContainer = await new GenericContainer('interledger4j/java-ilpv4-connector')

    // TODO Abstract this into reusable integration test that also tests many simultaneous settlements?

    // TODO Run this in a Docker network rather than on the host? Can I still run the SE on the host?

    // Setup Redis (index 0 for connector, index 1 for engine)
    // Don't use `host` network to prevent conflcits with host `redis-server` instance
    redisContainer = await new GenericContainer('redis').withExposedPorts(6379).start()
    const redisPort = redisContainer.getMappedPort(6379)

    // TODO Add a specific hostname for each container?
    // TODO Add a specific name for each container?

    // Setup the Rust connector
    adminAuthToken = 'admin'
    rustNodeContainer = await new GenericContainer('interledgerrs/ilp-node')
      .withNetworkMode('host')
      // TODO Use environment variables instead?
      .withCmd([
        '--secret_seed',
        randomBytes(32).toString('hex'),
        '--admin_auth_token',
        adminAuthToken,
        '--database_url',
        `redis://localhost:${redisPort}`,
        '--ilp_address',
        'g.corp',
        '--settlement_api_bind_address',
        '127.0.0.1:7771'
      ])
      .withWaitStrategy(new LogWaitStrategy('Settlement API listening'))
      .start()

    // Create a dummy settlement engine that "settles" by sending a message to
    // its peer for the amount of the settlement :P
    const createEngine: ConnectRedisSettlementEngine = async ({
      sendMessage,
      prepareSettlement,
      creditSettlement
    }) => ({
      async settle(accountId) {
        const [amount, commitTx] = await prepareSettlement(accountId, 1000)

        await sendMessage(accountId, { amount })
        await commitTx.exec()
      },

      async handleMessage(accountId, message) {
        if (message.hasOwnProperty('amount')) {
          await creditSettlement(accountId, new BigNumber(message.amount))
        }
      }
    })

    const connectStore = createRedisStore(createEngine, {
      port: redisPort,
      db: 1
    })

    const enginePort = await getPort()
    const engineUrl = `http://localhost:${enginePort}`
    const engineServer = await startServer(connectStore, {
      port: enginePort,
      connectorUrl: `http://localhost:7771`
    })
    shutdownEngine = engineServer.shutdown

    // TODO Create abstract function to make outgoing request to connector!

    await axios.post(
      'http://localhost:7770/accounts',
      {
        username: 'alice',
        asset_code: 'USD',
        asset_scale: 2,
        settle_to: -451,
        settle_threshold: 0,
        settlement_engine_url: engineUrl,
        ilp_over_http_url: 'http://localhost:7770/accounts/bob/ilp',
        ilp_over_http_outgoing_token: 'bob',
        ilp_over_http_incoming_token: 'alice'
      },
      {
        headers: {
          Authorization: `Bearer ${adminAuthToken}`
        }
      }
    )

    await axios.post(
      'http://localhost:7770/accounts',
      {
        username: 'bob',
        asset_code: 'USD',
        asset_scale: 2,
        settlement_engine_url: engineUrl, // TODO Can this have a slash at the end or not?
        ilp_over_http_url: 'http://localhost:7770/accounts/alice/ilp',
        ilp_over_http_outgoing_token: 'alice',
        ilp_over_http_incoming_token: 'bob'
      },
      {
        headers: {
          Authorization: `Bearer ${adminAuthToken}`
        }
      }
    )
  })

  // TODO Why won't the logs work!?!?
  afterEach(async () => {
    await Promise.all([shutdownEngine(), rustNodeContainer.stop()])
    await redisContainer.stop()
  })

  test('Settlement between two connector accounts adjusts Interledger balances', async () => {
    // Send a payment from Bob -> Alice in order to trigger settlement
    // Rust connector doesn't auto prefund: https://github.com/interledger-rs/interledger-rs/issues/591
    await axios.post(
      'http://localhost:7770/accounts/bob/payments',
      {
        receiver: 'http://localhost:7770/accounts/alice/spsp',
        source_amount: 10
      },
      {
        headers: {
          Authorization: `Bearer bob`
        }
      }
    )

    await sleep(500)

    const { data: aliceBalance } = await axios({
      method: 'GET',
      url: 'http://localhost:7770/accounts/alice/balance',
      headers: {
        Authorization: `Bearer alice`
      }
    })
    expect(aliceBalance.balance).toEqual(-4.51)

    const { data: bobBalance } = await axios({
      method: 'GET',
      url: 'http://localhost:7770/accounts/bob/balance',
      headers: {
        Authorization: `Bearer bob`
      }
    })
    expect(bobBalance.balance).toEqual(4.51)
  })
})

// TODO Should I add other integration test?
//      (1) Crash the connector before an incoming settlement can be credited, then retry, to ensure it retries?
//          (for this, I could even just use an SE that auto credits an account)
//      (2) Verify deleting an account from the connector deletes it on the SE?
//      (3) Try multiple simultaneous settlement requests, or for multiple accounts?

// TODO Delete/remove these tests?

// test('Triggers settlement for given amount', async () => {
//   const { settleMock, sendSettlementRequest, shutdown } = await prepareSettlementEngine()

//   const quantity = {
//     amount: '468200000',
//     scale: 8
//   }
//   const response = await sendSettlementRequest(quantity)
//   expect(response.data).toStrictEqual(quantity) // The entire amount should be queued for settlement
//   expect(response.status).toBe(201)

//   expect(settleMock.mock.calls.length).toBe(1)
//   expect(settleMock.mock.calls[0][1]).toStrictEqual(new BigNumber('4.682'))

//   await shutdown()
// })

// test('Same idempotency key only queues one settlement', async () => {
//   const { settleMock, sendSettlementRequest, shutdown } = await prepareSettlementEngine()

//   const quantity = {
//     amount: '468200000',
//     scale: 8
//   }
//   const idempotencyKey = uuid()

//   await sendSettlementRequest(quantity, idempotencyKey)

//   const response = await sendSettlementRequest(quantity, idempotencyKey)
//   expect(response.data).toStrictEqual(quantity)
//   expect(response.status).toBe(201)

//   expect(settleMock.mock.calls.length).toBe(1)
//   expect(settleMock.mock.calls[0][1]).toStrictEqual(new BigNumber('4.682'))

//   await shutdown()
// })

// test('Same idempotency key with different amount fails', async () => {
//   const { settleMock, sendSettlementRequest, shutdown } = await prepareSettlementEngine()

//   const idempotencyKey = uuid()

//   const quantity1 = {
//     amount: '999',
//     scale: 4
//   }
//   await sendSettlementRequest(quantity1, idempotencyKey)

//   const quantity2 = {
//     amount: '37843894895',
//     scale: 4
//   }
//   await expect(sendSettlementRequest(quantity2, idempotencyKey)).rejects.toHaveProperty(
//     'response.status',
//     400
//   )

//   expect(settleMock.mock.calls.length).toBe(1)
//   expect(settleMock.mock.calls[0][1]).toStrictEqual(new BigNumber('0.0999'))

//   await shutdown()
// })

// test('Retries unsettled amount after subsequent settlements are triggered', async () => {
//   const { settleMock, sendSettlementRequest, shutdown } = await prepareSettlementEngine()

//   // Request to settle 3.6, but only settle 1.207
//   settleMock.mockResolvedValueOnce(new BigNumber(1.207))
//   await sendSettlementRequest({
//     amount: '3600',
//     scale: 3
//   })

//   expect(settleMock.mock.calls.length).toBe(1)
//   expect(settleMock.mock.calls[0][1]).toStrictEqual(new BigNumber('3.6'))

//   // Request to settle 4.9001
//   await sendSettlementRequest({
//     amount: '490010000',
//     scale: 8
//   })

//   // Second settlement: 4.9001 new amount + 2.393 unsettled leftover = 7.2931
//   expect(settleMock.mock.calls.length).toBe(2)
//   expect(settleMock.mock.calls[1][1]).toStrictEqual(new BigNumber('7.2931'))

//   await shutdown()
// })

// test('Safely handles many simultaneous settlement requests', async () => {
//   const { settleMock, sendSettlementRequest, shutdown } = await prepareSettlementEngine()

//   // Settle 1 unit x 100 times
//   const requests = Array(100)
//     .fill(null)
//     .map(() =>
//       sendSettlementRequest({
//         amount: '1',
//         scale: 0
//       })
//     )
//   await Promise.all(requests)

//   expect(settleMock.mock.calls.length).toBe(100)

//   const totalSettled = settleMock.mock.calls
//     .map(([accountId, amount]) => amount)
//     .reduce((total, amount) => amount.plus(total), 0)
//   expect(totalSettled).toStrictEqual(new BigNumber('100'))

//   await shutdown()
// })
