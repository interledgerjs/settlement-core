import BigNumber from 'bignumber.js'
import Redis from 'ioredis'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import uuid from 'uuid/v4'
import { connectRedisStore } from './'
import { SettlementStore } from '../store'

let redisContainer: StartedTestContainer
let store: SettlementStore
let client: Redis.Redis

describe('Redis store', () => {
  beforeEach(async () => {
    redisContainer = await new GenericContainer('redis').withExposedPorts(6379).start()

    client = new Redis(redisContainer.getMappedPort(6379), redisContainer.getContainerIpAddress())

    // TODO Mock the engine?
    store = await connectRedisStore({
      client
    })
  })

  afterEach(async () => {
    await redisContainer.stop()
    await store.disconnect()
  })

  test('foo', async () => {
    const settlementId = uuid()
    const credit = {
      accountId: 'alice',
      amount: new BigNumber(3),
      settlementId
    }

    // TODO Call "queueSettlement" instead, and use a spy to see if it calls the callback
    console.log(await store.addSettlementCredit(credit))

    const foo = await client.hmget(
      `accounts:alice:settlement-credits:${settlementId}`,
      'next_retry_timestamp'
    )
    console.log(foo)

    const foo2 = await client.hmget(
      `accounts:alice:settlement-credits:${settlementId}`,
      'next_retry_timestamp'
    )
    console.log(foo2)

    // expect(nextCredit).toBeUndefined()

    // TODO Advance the time of the container by changing its date? Then, also use Jest timer mocks to fast-forward time?
    // await redisContainer.exec([''])

    await new Promise(r => setTimeout(r, 200))

    nextCredit = await store.retrySettlementCredit() // TODO Don't need to use/test this directly
    expect(nextCredit).toEqual(credit)
  })

  test('retry returns no settlements if there are no credits', async () => {
    const credit = await store.retrySettlementCredit()
    expect(credit).toBeUndefined()
  })

  test.todo('test calling retry when no queued settlements are ready yet')
})
