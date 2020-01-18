-- TODO Add document explaining what this does
-- Signature: (accountId, idempotencyKey, amount) => amount

local DAY_IN_SECONDS = 86400

-- Check for an existing idempotency key for this settlement
local settlement_request_key = 'accounts:' .. ARGV[1] .. ':settlement-requests:' .. ARGV[2]
local amount = redis.call('HGET', settlement_request_key, 'amount')

-- If no idempotency key exists, cache idempotency key and enqueue the settlement
if not amount then
  redis.call('HSET', settlement_request_key, 'amount', ARGV[3])
  amount = ARGV[3]

  -- TODO Update this for new schema (it's old!!
  local queued_settlements_key = 'accounts:' .. ARGV[1] .. ':queued-settlements'
  redis.call('LPUSH', queued_settlements_key, ARGV[3])
end

-- Reset expiration to purge this idempotency key 1 day after the most recent request
redis.call('EXPIRE', settlement_request_key, DAY_IN_SECONDS)

return amount
