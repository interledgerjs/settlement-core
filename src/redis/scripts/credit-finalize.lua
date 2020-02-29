-- TODO Add document explaining what this does
-- Signature: (accountId, idempotencyKey) => ()

local settlement_credit_key = 'accounts:' .. ARGV[1] .. ':settlement-credits:' .. ARGV[2]
redis.call('ZREM', 'pending-settlement-credits', settlement_credit_key)
redis.call('DEL', settlement_credit_key)
