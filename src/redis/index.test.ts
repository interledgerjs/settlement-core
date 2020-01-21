import BigNumber from 'bignumber.js'
import Redis, { Redis as IoRedis } from 'ioredis'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import uuid from 'uuid/v4'
import {
  connectRedisStore,
  RedisSettlementEngine,
  ConnectRedisSettlementEngine,
  RedisStoreServices,
  SafeKey
} from './'
import { SettlementStore } from '../store'
import { ConnectorServices } from '../connector/services'

let redisContainer: StartedTestContainer
let client: IoRedis
let mockEngine: RedisSettlementEngine
let store: SettlementStore
let prepareSettlement: RedisStoreServices['prepareSettlement']

describe('Redis settlement store', () => {
  jest.setTimeout(60000) // TODO Seems like stopping the container takes awhile?

  beforeEach(async () => {
    redisContainer = await new GenericContainer('redis').withExposedPorts(6379).start()

    client = new Redis(redisContainer.getMappedPort(6379), redisContainer.getContainerIpAddress())

    mockEngine = {
      settle: jest.fn()
    }

    const connectMockEngine: ConnectRedisSettlementEngine = async services => {
      prepareSettlement = services.prepareSettlement
      return mockEngine
    }

    const mockServices: ConnectorServices = {
      sendCreditRequest: jest.fn(),
      sendMessage: jest.fn()
    }

    store = await connectRedisStore(connectMockEngine, mockServices, { client })

    // TODO Create an account for `alice` too? Or should this be within individual test?
  })

  afterEach(async () => {
    await redisContainer.stop()

    if (store.disconnect) {
      await store.disconnect()
    }
  })

  describe('Queues new settlements', () => {
    test('Ignores requests with different amounts and the same idempotency key', async () => {
      const accountId = uuid()
      const idempotencyKey = uuid()
      const requestAmount = new BigNumber(40001348)

      const amountQueued1 = await store.handleSettlementRequest(
        accountId,
        idempotencyKey,
        requestAmount
      )
      expect(amountQueued1).toStrictEqual(requestAmount)

      const amountQueued2 = await store.handleSettlementRequest(
        accountId,
        idempotencyKey,
        new BigNumber(40001348.1)
      )
      expect(amountQueued2).toStrictEqual(requestAmount)
    })

    test('Only queues a single TODO', async () => {
      const accountId = 'alice' as SafeKey
      const idempotencyKey = uuid()
      const requestAmount = new BigNumber(3.21)

      // Initially, zero should be queued for settlement
      const [initialQueuedAmount] = await prepareSettlement(accountId, 1000)
      expect(initialQueuedAmount).toStrictEqual(new BigNumber(0))

      // Create an arbitrary race condition: send 20 requests for the same settlement all at once
      // Goal is to ensure Redis only queues the amount once
      const amountsQueued = await Promise.all(
        [...Array(20)].map(() =>
          store.handleSettlementRequest(accountId, idempotencyKey, requestAmount)
        )
      )

      expect(amountsQueued).resolves.toStrictEqual(Array(20).fill(requestAmount))

      // TODO This needs to be after the pending requests complete
      expect(mockEngine.settle).toHaveBeenCalledWith(accountId)
      expect(mockEngine.settle).toBeCalledTimes(20)

      // Test that Redis only queued the amount once
      const [amountToSettle1, commitSettlement] = await prepareSettlement(accountId, 1000)
      expect(amountToSettle1).toStrictEqual(requestAmount) // TODO

      await store.handleSettlementRequest(accountId, idempotencyKey, requestAmount)
      const [amountToSettle2] = await prepareSettlement(accountId, 1000)
      expect(amountToSettle2).toStrictEqual(new BigNumber(0))

      await commitSettlement.exec()

      await store.handleSettlementRequest(accountId, idempotencyKey, requestAmount)
      const [amountToSettle3] = await prepareSettlement(accountId, 1000)
      expect(amountToSettle3).toStrictEqual(new BigNumber(0))

      // const savedAmount = await store.handleSettlementRequest(accountId, idempotencyKey, amount)

      // TODO What should I check?
    })
  })

  // TODO Add other `describe` and `todo` blocks

  // test('retry returns no settlements if there are no credits', async () => {
  //   const credit = await store.retrySettlementCredit()
  //   expect(credit).toBeUndefined()
  // })

  // test.todo('test calling retry when no queued settlements are ready yet')
})
