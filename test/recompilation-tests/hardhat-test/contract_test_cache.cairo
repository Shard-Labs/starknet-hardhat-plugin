# Declare this file as a StarkNet contract.
%lang starknet

from starkware.cairo.common.cairo_builtins import HashBuiltin
from dependency import almost_equal as aeq

# Define a storage variable.
@storage_var
func balance() -> (res : felt):
end

# Increases the balance by the given amount.
@external
func increase_balance{
    syscall_ptr : felt*,
    pedersen_ptr : HashBuiltin*,
    range_check_ptr,
}(amount : felt):
    let (res) = balance.read()
    balance.write(res + amount)
    return ()
end

@view
func use_almost_equal(a, b) -> (res):
    let (res) = aeq(a=a, b=b)
    return (res)
end
