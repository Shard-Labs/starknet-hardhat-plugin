#!/bin/bash
set -e

# Hardhat starknet-invoke command
echo "Testing Recompilation with deleted artifact on hardhat starknet-invoke"
output=$(npx hardhat starknet-deploy --starknet-network "$NETWORK" starknet-artifacts/contracts/contract.cairo/ --inputs 10)
# Grab the output Contract address to a variable using parameter expansion
tail=${output#*$'\n'Contract address: }
address=${tail%%$'\n'*}
# Remove artifact contract
rm -rf starknet-artifacts/contracts/contract.cairo
npx hardhat starknet-invoke --starknet-network "$NETWORK" --contract contract --function increase_balance --address "$address" --inputs "10 20"
