#!/bin/bash
set -e

echo "Testing Recompilation with deleted artifact on starknet-call"
output=$(npx hardhat starknet-deploy --starknet-network "$NETWORK" starknet-artifacts/contracts/contract.cairo/ --inputs 10)

tail=${output#*$'\n'Contract address: }
address=${tail%%$'\n'*}

rm -rf starknet-artifacts/contracts/contract.cairo
npx hardhat starknet-call --starknet-network "$NETWORK" --contract contract --function sum_points_to_tuple --address "$address" --inputs "10 20 30 40"
