-- TODO Doc what this does
-- Signature: (account_id, lease_duration) => {settlement_id, amount, ...}

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

local account_id, lease_duration_ms = unpack(ARGV)

-- Determine next timestamp to attempt a retry
local unix_timestamp, microsec = unpack(redis.call('TIME'))
local timestamp_ms = (unix_timestamp * 1000) + math.floor(microsec / 1000)
local lease_expiration_timestamp = timestamp_ms + lease_duration_ms

local pending_settlements_key = 'accounts:' .. account_id .. ':pending-settlements'

-- TODO settlement IDs to prepare
local amounts_to_settle = redis.call('ZRANGEBYSCORE', pending_settlements_key, 0, timestamp_ms)

local settlement_amounts = {}
for _, amount_id in ipairs(amounts_to_settle) do
  redis.call('ZADD', pending_settlements_key, lease_expiration_timestamp, amount_id)
  local amount = redis.call('GET', 'accounts:' .. account_id .. ':pending-settlements:' .. amount_id)

  table.insert(settlements, amount_id)
  table.insert(settlements, amount)
end

return settlement_amounts
