import BigNumber from 'bignumber.js'
import Redis, { Redis as IoRedis } from 'ioredis'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import uuid from 'uuid/v4'
import {
  createRedisStore,
  RedisSettlementEngine,
  ConnectRedisSettlementEngine,
  RedisStoreServices,
  SafeRedisKey,
  isValidAmount
} from './'
import { SettlementStore } from '../store'
import { ConnectorServices } from '../connector/services'
import debug from 'debug'

const log = debug('settlement-core')

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

    // TODO For debugging! (Remove?)
    log('Redis port', redisContainer.getMappedPort(6379))

    mockEngine = {
      settle: jest.fn(async () => Promise.resolve()),
      handleMessage: jest.fn()
    }

    const connectMockEngine: ConnectRedisSettlementEngine = async services => {
      prepareSettlement = services.prepareSettlement
      return mockEngine
    }

    const mockServices: ConnectorServices = {
      sendCreditRequest: jest.fn(),
      sendMessage: jest.fn()
    }

    const connectStore = createRedisStore(connectMockEngine, { client })
    store = await connectStore(mockServices)

    // TODO Create an account for `alice` too? Or should this be within individual test?
  })

  afterEach(async () => {
    if (store.disconnect) {
      await store.disconnect()
    }

    await redisContainer.stop()
  })

  describe('Queues new settlements', () => {
    test('Requests with same idempotency key return amount in original request', async () => {
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

    test('Requests with same idempotency key queue a settlement exactly once', async () => {
      const accountId = 'alice' as SafeRedisKey
      const idempotencyKey = uuid()
      const requestAmount = new BigNumber(3.21)

      // (1) Initially, zero should be queued for settlement
      const [initialQueuedAmount] = await prepareSettlement(accountId, 1000)
      expect(initialQueuedAmount).toStrictEqual(new BigNumber(0))

      const amountQueued1 = await store.handleSettlementRequest(
        accountId,
        idempotencyKey,
        requestAmount
      )
      expect(amountQueued1).toStrictEqual(requestAmount)

      // Settlement be triggered after the original request
      // await sleep(10) // Allow event queue to call `settle` // TODO Is this necessary?
      expect(mockEngine.settle).toHaveBeenCalledWith(accountId)
      expect(mockEngine.settle).toBeCalledTimes(1)

      // (2) After original request, 3.21 should be queued for settlement and available to lease
      const [amountToSettle1, commitSettlement] = await prepareSettlement(accountId, 1000)
      expect(amountToSettle1).toStrictEqual(requestAmount)

      const amountQueued2 = await store.handleSettlementRequest(
        accountId,
        idempotencyKey,
        requestAmount
      )
      expect(amountQueued2).toStrictEqual(requestAmount)

      // (3) After amount is leased + 2nd idempotent request, no additional amount should be available to settle
      const [amountToSettle2] = await prepareSettlement(accountId, 1000)
      expect(amountToSettle2).toStrictEqual(new BigNumber(0))

      await commitSettlement.exec()

      const amountQueued3 = await store.handleSettlementRequest(
        accountId,
        idempotencyKey,
        requestAmount
      )
      expect(amountQueued3).toStrictEqual(requestAmount)

      // (4) After settlement is committed + 3rd idempotent request, no additional amount should be available to settle
      const [amountToSettle3] = await prepareSettlement(accountId, 1000)
      expect(amountToSettle3).toStrictEqual(new BigNumber(0))

      // Settlement should still only be triggered once
      expect(mockEngine.settle).toBeCalledTimes(1)
    })
  })

  // TODO Add more tests!

  test.todo('retry returns no settlements if there are no credits')
  test.todo('retry returns no settlements if none are ready to retry')
})

describe('#isValidAmount', () => {
  test('True for very large positive numbers', () => {
    expect(isValidAmount(new BigNumber('134839842444364732'))).toBe(true)
  })

  test('True for very small positive numbers', () => {
    expect(isValidAmount(new BigNumber('32.23843824832838489999999e-150'))).toBe(true)
  })

  test('True for positive 0', () => {
    expect(isValidAmount(new BigNumber(0))).toBe(true)
  })

  test('True for negative 0', () => {
    expect(isValidAmount(new BigNumber('-0'))).toBe(true)
  })

  test('False for Infinity', () => {
    expect(isValidAmount(new BigNumber(Infinity))).toBe(false)
  })

  test('False for NaN', () => {
    expect(isValidAmount(new BigNumber(NaN))).toBe(false)
  })

  test('False for negative numbers', () => {
    expect(isValidAmount(new BigNumber('-3248'))).toBe(false)
  })
})
