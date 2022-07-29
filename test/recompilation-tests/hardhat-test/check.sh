#!/bin/bash
set -e

CONTRACT_NAME=contract_test_cache.cairo
CONTRACT_PATH="contracts/${CONTRACT_NAME}"

DEPENDENCY_NAME=dependency.cairo
DEPENDENCY_PATH="contracts/${DEPENDENCY_NAME}"

rm -rf $DEPENDENCY_PATH $CONTRACT_PATH
# Hardhat test command
echo "Testing Recompilation with new contract added"
cp "$(dirname "$0")/$CONTRACT_NAME" "$CONTRACT_PATH"
cp "$(dirname "$0")/$DEPENDENCY_NAME" "$DEPENDENCY_PATH"
npx hardhat test --no-compile test/recompilation/recompilation-main-test.ts

echo "Testing Recompilation with artifacts deleted"
rm -rf starknet-artifacts/contracts/contract.cairo
npx hardhat test --no-compile test/recompilation/recompilation-main-test.ts

echo "Testing Recompilation with updated contract"
# Appending a new function to the contract
cat "$(dirname "$0")/get_balance.cairo" >> contracts/contract_test_cache.cairo
npx hardhat test --no-compile test/recompilation/recompilation-update-test.ts

echo "Testing Recompilation with cache file deleted"
rm -rf cache/cairo-files-cache.json
npx hardhat test --no-compile test/recompilation/recompilation-main-test.ts

echo "Testing Recompilation with dependency changed"
echo "#" >> "$DEPENDENCY_PATH"
npx hardhat test --no-compile test/recompilation/recompilation-dependency-test.ts

echo "Testing Recompilation with source deleted"
cp cache/cairo-files-cache.json cache-content-before.json
rm -rf contracts/contract_test_cache.cairo
npx hardhat test --no-compile test/recompilation/recompilation-main-test.ts
# Check that the cache file was updated using diff
if diff -q cache-content-before.json cache/cairo-files-cache.json; then
    echo "Cache file was not updated"
    exit 1
fi

# echo "Testing Recompilation one contract added another deleted"
# rm -f contracts/contract_test_cache.cairo
# # contract_test contract with original content
# cp "$(dirname "$0")/$CONTRACT_NAME" "$CONTRACT_PATH"
# rm -f contracts/dependency.cairo
# npx hardhat test test/recompilation/recompilation-main-test.ts
