-- Signature (account-id, [settlement-id, ...]) -> ()

local account_id = table.remove(ARGV, 1)
local settlement_ids = ARGV

-- (1) Check EXISTS on the key for each settlement ID. If no exists, fail!

for settlement_id in settlement_ids do
  local is_pending = redis.call('EXISTS', 'accounts:' .. account_id .. ':pending-settlements:' .. settlement_id)
  if is_pending == 0 then
    -- TODO Fail/scream here
  end
end

-- TODO What if only some of the IDs are still pending? Is that an exception state?

for settlement_id in settlement_ids do
  redis.call('DEL', 'accounts:' .. account_id .. ':pending-settlements:' .. settlement_id)
  redis.call('ZREM', 'accounts:' .. account_id .. ':pending-settlements', settlement_id)
end
