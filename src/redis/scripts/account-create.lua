-- Create a new account only it doesn't already exist, otherwise discard transaction
-- Signature: (account-id) => (did-create-account)

local account_id = ARGV[1]

-- Only add the account if it doesn't already exist, otherwise discard transaction
if redis.call('SISMEMBER', 'accounts', account_id) then
  redis.call('DISCARD') -- TODO This won't work, so remove this script...
   return false
else
  redis.call('SADD', 'accounts', account_id)
  return true -- Indicates the account was created
end
