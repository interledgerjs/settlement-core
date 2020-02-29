-- Handle an incoming request to settle
-- If an original request, add the amount to the pending settlements queue so it's available to settle
-- If it's a retry request, reset the expiration for this idempotency key, and return the amount already queued

-- (account_id: string, idempotency_key: string, amount: string) => (amount_queued: string, is_original_request: boolean)

local DAY_IN_SECONDS = 86400

-- From Lua 5.2+, unpack -> table.unpack, so workaround for backwards compatibility
-- http://lua-users.org/lists/lua-l/2015-03/msg00220.html
local unpack = unpack or table.unpack

local account_id, idempotency_key, request_amount = unpack(ARGV)

-- Check for an existing idempotency key for this settlement
local settlement_request_key = 'accounts:' .. account_id .. ':settlement-requests:' .. idempotency_key
local amount_queued = redis.call('HGET', settlement_request_key, 'amount')

-- If no idempotency key exists...
local is_original_request = not amount_queued
if is_original_request then
  amount_queued = request_amount

  -- Cache the idempotency key
  redis.call('HSET', settlement_request_key, 'amount', amount_queued)

  -- Add the settlement to queue
  local pending_settlements_key = 'accounts:' .. account_id .. ':pending-settlements'
  redis.call('ZADD', pending_settlements_key, 0, idempotency_key) -- Lease expiration is 0 to indicate no lease

  -- Save the settlement amount
  local settlement_amount_key = 'accounts:' .. account_id .. ':pending-settlements:' .. idempotency_key
  redis.call('HSET', settlement_amount_key, 'amount', amount_queued)
end

-- Reset expiration to purge this idempotency key 1 day after the most recent request
redis.call('EXPIRE', settlement_request_key, DAY_IN_SECONDS)

return {amount_queued, is_original_request}
