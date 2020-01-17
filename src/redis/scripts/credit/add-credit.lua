-- TODO Add document explaining what this does
-- Signature: (account_id, idempotency_key, amount) => ()

local RETRY_MIN_DELAY_MS = 100

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

local account_id, idempotency_key, amount = unpack(ARGV)

-- TODO Confirm the account exists? What if it's removed in interim? (Should this be in the SE or in core?)

-- (TODO incorrect) If a settlement credit with this ID already exists, don't continue
-- (there should be prior logic by SE to ensure this is the case)
local settlement_credit_key = 'accounts:' .. account_id .. ':settlement-credits:' .. idempotency_key

-- TODO Core needs to have a hook so a custom script runs *before this* to atomically check if the settlement was already credited

-- Determine next timestamp to attempt a retry
local unix_timestamp, microsec = unpack(redis.call('TIME'))
local timestamp_ms = (unix_timestamp * 1000) + math.floor(microsec / 1000)
local delay_ms = RETRY_MIN_DELAY_MS * (0.5 * (1 + math.random())) -- Randomize initial delay between 50-100ms
delay_ms = math.floor(delay_ms + 0.5)                             -- Round since too much precision

local next_retry_timestamp = timestamp_ms + delay_ms

-- MUST call this before any writes to support non-deterministic commands on Redis < 5
if redis.replicate_commands then
  redis.replicate_commands()
end

redis.call(
  'HSET', settlement_credit_key,
  'amount', amount,
  'next_retry_timestamp', next_retry_timestamp,
  'num_attempts', 1,
  'idempotency_key', idempotency_key,
  'account_id', account_id
)

redis.call('ZADD', 'pending-settlement-credits', next_retry_timestamp, settlement_credit_key)
