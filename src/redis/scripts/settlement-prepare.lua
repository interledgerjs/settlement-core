-- TODO Doc what this does
-- (account_id: string, lease_duration: integer) => {amount_id: string, amount: string, ...}

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

local account_id, lease_duration_ms = unpack(ARGV)

local unix_timestamp, microsec = unpack(redis.call('TIME'))
local timestamp_ms = (unix_timestamp * 1000) + math.floor(microsec / 1000)

local pending_settlements_key = 'accounts:' .. account_id .. ':pending-settlements'

-- Collect all settlement amounts that have yet to be settled, or the lease for the current settlement expired
local amounts_to_settle = redis.call('ZRANGEBYSCORE', pending_settlements_key, 0, timestamp_ms)

-- MUST call this before any writes to support non-deterministic commands on Redis < 5
if redis.replicate_commands then
  redis.replicate_commands()
end

local lease_expiration_timestamp = timestamp_ms + lease_duration_ms
local settlement_amounts = {}

for _, amount_id in ipairs(amounts_to_settle) do
  -- Update lease expiration in sorted set
  redis.call('ZADD', pending_settlements_key, lease_expiration_timestamp, amount_id)

  local amount_key = 'accounts:' .. account_id .. ':pending-settlements:' .. amount_id)

  -- Get settlement amount and add to list
  local amount = redis.call('HGET', amount_key, 'amount')
  table.insert(settlement_amounts, amount_id)
  table.insert(settlement_amounts, amount)

  -- Update metadata so Redis WATCH will fail any concurrent settlements (if lease is expired)
  redis.call(
    'HSET', amount_key,
    'lease_expiration', lease_expiration_timestamp,
    'lease_nonce', math.random() -- Nonce corresponding to this unique settlement attempt
  )
end

return settlement_amounts
