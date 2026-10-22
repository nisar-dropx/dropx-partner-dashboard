select deep_link, blocker, case_key
from nl_loss_recovery_action_items('43866344-b550-4e8a-9a2d-9d23f3d8a997')
where case_key = 'slp:Aug-Sep|23062026_KDJE_79238|369420994895|369420994895'
limit 1;
