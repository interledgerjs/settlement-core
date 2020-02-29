-- TODO Add document explaining what this does
-- Signature: () => (accountId, idempotencyKey, amount)

local RETRY_MIN_DELAY_MS = 100
local RETRY_MAX_DELAY_MS = 3600000 -- 1 hour

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

-- In Redis script replication mode (enabled by default in Redis > 5, supported in Redis > 3.2),
-- we have access to PRNG and TIME:
-- https://redis.io/commands/eval#replicating-commands-instead-of-scripts
-- https://www.reddit.com/r/redis/comments/3qtvoz/new_feature_single_commands_replication_for_lua/

local unix_timestamp, microsec = unpack(redis.call('TIME'))
local timestamp_ms = (unix_timestamp * 1000) + math.floor(microsec / 1000)

-- Get the earliest pending credit that is ready to retry (returns empty list if sorted set doesn't exist)
local pending_credits = redis.call('ZRANGEBYSCORE', 'pending-settlement-credits', '-inf', timestamp_ms, 'LIMIT', 0, 1)

-- If there are no queued credits that are ready to retry, exit
local _, settlement_credit_key = next(pending_credits)
if settlement_credit_key == nil then
  return
end

local account_id, amount, num_attempts, idempotency_key = unpack(redis.call(
  'HMGET', settlement_credit_key,
  'account_id',
  'amount',
  'num_attempts',
  'idempotency_key'
))

-- MUST call this before any writes to support non-deterministic commands on Redis < 5
if redis.replicate_commands then
  redis.replicate_commands()
end

-- Atomically schedule the next retry attempt

-- Adaptation of backoff algorithm from Stripe:
-- https://github.com/stripe/stripe-ruby/blob/1bb9ac48b916b1c60591795cdb7ba6d18495e82d/lib/stripe/stripe_client.rb#L78-L92

local delay_ms = RETRY_MIN_DELAY_MS * (2 ^ tonumber(num_attempts)) -- Exponentially backoff before next attempt
delay_ms = math.min(delay_ms, RETRY_MAX_DELAY_MS)                  -- Wait at most the maximum
delay_ms = delay_ms * (0.5 * (1 + math.random()))                  -- Random "jitter" in range of (delay_ms / 2) to (delay_ms)
delay_ms = math.floor(delay_ms + 0.5)                              -- Round since too much precision
delay_ms = math.max(RETRY_MIN_DELAY_MS, delay_ms)                  -- Wait at least the minimum

local next_retry_timestamp = timestamp_ms + delay_ms
redis.call('ZADD', 'pending-settlement-credits', next_retry_timestamp, settlement_credit_key)
redis.call('HSET', settlement_credit_key, 'next_retry_timestamp', next_retry_timestamp)
redis.call('HINCRBY', settlement_credit_key, 'num_attempts', 1)

return {account_id, idempotency_key, amount}
