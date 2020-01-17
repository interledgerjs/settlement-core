-- TODO Doc what this does
-- TODO Should the client generate the settlement-id and entropy? Is that fine?
--      (then I don't need to figure out how to generate a random string within Lua)
-- Signature: (account-id, lease-duration) => {settlement-id, amount, ...}

-- TODO

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

local account_id, lease_duration_ms = unpack(ARGV)

-- Determine next timestamp to attempt a retry
local unix_timestamp, microsec = unpack(redis.call('TIME'))
local timestamp_ms = (unix_timestamp * 1000) + math.floor(microsec / 1000)
local lease_expiration_timestamp = timestamp_ms + lease_duration_ms -- TODO leaseDuration arg

local pending_settlements_key = 'accounts:' .. account_id .. ':pending-settlements'

-- TODO settlement IDs to prepare
local settlements_to_prepare = redis.call('ZRANGEBYSCORE', pending_settlements_key, 0, timestamp_ms)

local settlements = {}

for settlement_id in settlements_to_prepare do
  redis.call('ZADD', pending_settlements_key, lease_expiration_timestamp, settlement_id)
  local amount = redis.call('GET', 'accounts:' .. account_id .. ':pending-settlements:' .. settlement_id)

  table.insert(settlements, settlement_id)
  table.insert(settlements, amount)
end

return settlements
