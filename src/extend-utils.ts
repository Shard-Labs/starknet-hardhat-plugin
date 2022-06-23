import { HardhatPluginError } from "hardhat/plugins";
import { Block, HardhatRuntimeEnvironment } from "hardhat/types";
import * as path from "path";

import { ABI_SUFFIX, PLUGIN_NAME, SHORT_STRING_MAX_CHARACTERS } from "./constants";
import {
    AccountImplementationType,
    BlockIdentifier,
    DeployAccountOptions,
    StarknetContractFactory,
    Uint256
} from "./types";
import { Account, ArgentAccount, OpenZeppelinAccount } from "./account";
import { checkArtifactExists, findPath, getAccountPath } from "./utils";
import { Transaction, TransactionReceipt } from "./starknet-types";

export async function getContractFactoryUtil(hre: HardhatRuntimeEnvironment, contractPath: string) {
    const artifactsPath = hre.config.paths.starknetArtifacts;
    checkArtifactExists(artifactsPath);

    contractPath = contractPath.replace(/\.[^/.]+$/, ""); // remove extension

    const metadataSearchTarget = path.join(
        `${contractPath}.cairo`,
        `${path.basename(contractPath)}.json`
    );

    const metadataPath = await findPath(artifactsPath, metadataSearchTarget);
    if (!metadataPath) {
        throw new HardhatPluginError(
            PLUGIN_NAME,
            `Could not find metadata for contract "${contractPath}.cairo"`
        );
    }

    const abiSearchTarget = path.join(
        `${contractPath}.cairo`,
        `${path.basename(contractPath)}${ABI_SUFFIX}`
    );
    const abiPath = await findPath(artifactsPath, abiSearchTarget);
    if (!abiPath) {
        throw new HardhatPluginError(
            PLUGIN_NAME,
            `Could not find ABI for contract "${contractPath}.cairo"`
        );
    }

    return new StarknetContractFactory({
        starknetWrapper: hre.starknetWrapper,
        metadataPath,
        abiPath,
        networkID: hre.config.starknet.network,
        chainID: hre.config.starknet.networkConfig.starknetChainId,
        gatewayUrl: hre.config.starknet.networkUrl,
        feederGatewayUrl: hre.config.starknet.networkUrl
    });
}

export function shortStringToBigIntUtil(convertableString: string) {
    if (!convertableString) {
        throw new HardhatPluginError(PLUGIN_NAME, "A non-empty string must be provided");
    }

    if (convertableString.length > SHORT_STRING_MAX_CHARACTERS) {
        const msg = `Short strings must have a max of ${SHORT_STRING_MAX_CHARACTERS} characters.`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }

    const invalidChars: { [key: string]: boolean } = {};
    const charArray = [];
    for (const c of convertableString.split("")) {
        const charCode = c.charCodeAt(0);
        if (charCode > 127) {
            invalidChars[c] = true;
        }
        charArray.push(charCode.toString(16));
    }

    const invalidCharArray = Object.keys(invalidChars);
    if (invalidCharArray.length) {
        const msg = `Non-standard-ASCII character${
            invalidCharArray.length === 1 ? "" : "s"
        }: ${invalidCharArray.join(", ")}`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }

    return BigInt("0x" + charArray.join(""));
}

export function bigIntToShortStringUtil(convertableBigInt: BigInt) {
    return Buffer.from(convertableBigInt.toString(16), "hex").toString();
}

export function getWalletUtil(name: string, hre: HardhatRuntimeEnvironment) {
    const wallet = hre.config.starknet.wallets[name];
    if (!wallet) {
        const available = Object.keys(hre.config.starknet.wallets).join(", ");
        const msg = `Invalid wallet name provided: ${name}.\nValid wallets: ${available}`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }
    wallet.accountPath = getAccountPath(wallet.accountPath, hre);
    return wallet;
}

export function bigIntToUint256Util(convertableBigInt: BigInt): Uint256 {
    const lowMask = (BigInt(1) << BigInt(128)) - BigInt(1);
    return {
        low: convertableBigInt.valueOf() & lowMask,
        high: convertableBigInt.valueOf() >> BigInt(128)
    };
}

export function uint256ToBigIntUtil(uint256: Uint256): BigInt {
    return (BigInt(uint256.high) << BigInt(128)) + BigInt(uint256.low);
}

export async function deployAccountUtil(
    accountType: AccountImplementationType,
    hre: HardhatRuntimeEnvironment,
    options?: DeployAccountOptions
): Promise<Account> {
    let account: Account;
    switch (accountType) {
        case "OpenZeppelin":
            account = await OpenZeppelinAccount.deployFromABI(hre, options);
            break;
        case "Argent":
            account = await ArgentAccount.deployFromABI(hre, options);
            break;
        default:
            throw new HardhatPluginError(PLUGIN_NAME, "Invalid account type requested.");
    }

    return account;
}

export async function getAccountFromAddressUtil(
    address: string,
    privateKey: string,
    accountType: AccountImplementationType,
    hre: HardhatRuntimeEnvironment
): Promise<Account> {
    let account: Account;
    switch (accountType) {
        case "OpenZeppelin":
            account = await OpenZeppelinAccount.getAccountFromAddress(address, privateKey, hre);
            break;
        case "Argent":
            account = await ArgentAccount.getAccountFromAddress(address, privateKey, hre);
            break;
        default:
            throw new HardhatPluginError(PLUGIN_NAME, "Invalid account type requested.");
    }

    return account;
}

export async function getTransactionUtil(
    txHash: string,
    hre: HardhatRuntimeEnvironment
): Promise<Transaction> {
    const executed = await hre.starknetWrapper.getTransaction({
        feederGatewayUrl: hre.config.starknet.networkUrl,
        gatewayUrl: hre.config.starknet.networkUrl,
        hash: txHash
    });
    if (executed.statusCode) {
        const msg = `Could not get the transaction. ${executed.stderr.toString()}`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }
    const txReceipt = JSON.parse(executed.stdout.toString()) as Transaction;
    return txReceipt;
}

export async function getTransactionReceiptUtil(
    txHash: string,
    hre: HardhatRuntimeEnvironment
): Promise<TransactionReceipt> {
    const executed = await hre.starknetWrapper.getTransactionReceipt({
        feederGatewayUrl: hre.config.starknet.networkUrl,
        gatewayUrl: hre.config.starknet.networkUrl,
        hash: txHash
    });
    if (executed.statusCode) {
        const msg = `Could not get the transaction receipt. Error: ${executed.stderr.toString()}`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }
    const txReceipt = JSON.parse(executed.stdout.toString()) as TransactionReceipt;
    return txReceipt;
}

export async function getBlockUtil(
    hre: HardhatRuntimeEnvironment,
    identifier?: BlockIdentifier
): Promise<Block> {
    const blockOptions = {
        feederGatewayUrl: hre.config.starknet.networkUrl,
        gatewayUrl: hre.config.starknet.networkUrl,
        number: identifier?.blockNumber,
        hash: identifier?.blockHash
    };

    if (blockOptions.number == null && !blockOptions.hash) {
        blockOptions.number = "latest";
    }

    const executed = await hre.starknetWrapper.getBlock(blockOptions);

    if (executed.statusCode) {
        const msg = `Could not get block. Error: ${executed.stderr.toString()}`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }
    const block = JSON.parse(executed.stdout.toString()) as Block;
    return block;
}
