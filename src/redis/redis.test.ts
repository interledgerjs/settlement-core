import BigNumber from 'bignumber.js'
import Redis from 'ioredis'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import uuid from 'uuid/v4'
import { connectRedis, RedisSettlementStore } from './redis'

let redisContainer: StartedTestContainer
let store: RedisSettlementStore
let client: Redis.Redis

describe('Redis store', () => {
  beforeEach(async () => {
    redisContainer = await new GenericContainer('redis')
      .withExposedPorts(6379)
      .start()

    client = new Redis(
      redisContainer.getMappedPort(6379),
      redisContainer.getContainerIpAddress()
    )

    store = await connectRedis({
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

    nextCredit = await store.retrySettlementCredit()
    expect(nextCredit).toEqual(credit)
  })

  test('retry returns no settlements if there are no credits', async () => {
    const credit = await store.retrySettlementCredit()
    expect(credit).toBeUndefined()
  })

  test.todo('test calling retry when no queued settlements are ready yet')
})
