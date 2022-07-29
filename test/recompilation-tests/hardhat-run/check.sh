#!/bin/bash
set -e

# Hardhat run command
echo "Testing Recompilation with deleted artifact on hardhat run"
rm -rf starknet-artifacts/contracts/contract.cairo
npx hardhat run --no-compile scripts/deploy.ts

echo "Testing Recompilation with cache file deleted on hardhat run"
rm -rf cache/cairo-files-cache.json
npx hardhat run --no-compile scripts/deploy.ts
