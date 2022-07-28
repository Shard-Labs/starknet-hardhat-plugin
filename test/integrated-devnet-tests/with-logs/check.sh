#!/bin/bash
set -e

source ../scripts/check-devnet-is-not-running.sh

check_devnet_is_not_running
npx hardhat starknet-compile contracts/contract.cairo

EXPECTED_STDOT="Account #0"
EXPECTED_WARNING="WARNING: Use these accounts and their keys ONLY for local testing. DO NOT use them on mainnet or other live networks because you will LOSE FUNDS."

output=$(npx hardhat test --no-compile test/integrated-devnet.test.ts)
# Checks if output contains the expected string from stdout
if ! echo "$output" | grep -q "$EXPECTED_STDOT"; then
    echo "Expected output to contain '$EXPECTED_STDOT'"
    exit 1
fi


# Checks if file logs/stderr.log exists and contains the expected warning string
if [ -f logs/stderr.log ]; then
    if ! grep -q "$EXPECTED_WARNING" logs/stderr.log; then
        echo "Expected warning to contain '$EXPECTED_WARNING'"
        exit 1
    fi
else
    echo "Expected logs/stderr.log to exist"
    exit 1
fi

echo "Success"
check_devnet_is_not_running
