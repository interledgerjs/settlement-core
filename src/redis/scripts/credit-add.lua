-- TODO Add document explaining what this does
-- Signature: (account_id, idempotency_key, amount) => ()

local RETRY_MIN_DELAY_MS = 100

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

local account_id, idempotency_key, amount = unpack(ARGV)

-- TODO Confirm the account exists? What if it's removed in interim? (Should this be in the SE or in core?)

-- If a settlement credit with this ID already exists, don't continue

local settlement_credit_key = 'accounts:' .. account_id .. ':settlement-credits:' .. idempotency_key

-- TODO Core needs to have a hook so a custom script runs *before this* to atomically check if the settlement was already credited

-- Determine next timestamp to attempt a retry
local unix_timestamp, microsec = unpack(redis.call('TIME'))
local timestamp_ms = (unix_timestamp * 1000) + math.floor(microsec / 1000)

-- MUST call this before any writes to support non-deterministic commands on Redis < 5
if redis.replicate_commands then
  redis.replicate_commands()
end

-- TODO Run custom code here to ensure settlement was NOT already credited

-- TODO Run custom code here to ensure settlement will not be credited again

redis.call(
  'HSET', settlement_credit_key,
  'amount', amount,
  'next_retry_timestamp', timestamp_ms,
  'num_attempts', 0,
  'idempotency_key', idempotency_key,
  'account_id', account_id
)

redis.call('ZADD', 'pending-settlement-credits', timestamp_ms, settlement_credit_key)
