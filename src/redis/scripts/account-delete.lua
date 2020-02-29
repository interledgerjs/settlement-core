-- Signature: (account-id) => ()

local account_id = ARGV[1]

redis.call('SREM', 'accounts', account_id)

local pattern = 'accounts:' .. account_id .. '*'
redis.call('DEL', table.unpack(redis.call('KEYS', pattern)))

-- TODO Only delete the account if doesn't already exist
-- TODO Update this to the newer schema!
-- TODO Update this: `KEYS` is not recommended in production code: https://redis.io/commands/keys
