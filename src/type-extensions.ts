import "hardhat/types/config";
import "hardhat/types/runtime";
import {
    AccountImplementationType,
    BlockIdentifier,
    DeployAccountOptions,
    StarknetContract,
    StarknetContractFactory,
    StringMap,
    Uint256
} from "./types";
import { StarknetWrapper } from "./starknet-wrappers";
import {
    FlushResponse,
    IncreaseTimeResponse,
    LoadL1MessagingContractResponse,
    SetTimeResponse
} from "./devnet-utils";
import { Account, ArgentAccount, OpenZeppelinAccount } from "./account";
import { Transaction, TransactionReceipt, Block } from "./starknet-types";
import { HardhatNetworkConfig, NetworkConfig } from "hardhat/types/config";

type StarknetConfig = {
    dockerizedVersion?: string;
    venv?: string;
    wallets?: WalletUserConfig;
    network?: string;
    networkUrl?: string;
    networkConfig?: NetworkConfig;
};

type WalletUserConfig = {
    [walletName: string]: WalletConfig | undefined;
};

type WalletConfig = {
    modulePath: string;
    accountName?: string;
    accountPath?: string;
};

declare module "hardhat/types/config" {
    export interface ProjectPathsUserConfig {
        starknetArtifacts?: string;
        starknetSources?: string;
        cairoPaths?: string[];
    }

    export interface ProjectPathsConfig {
        starknetArtifacts: string;
        starknetSources?: string;
        cairoPaths?: string[];
    }

    export interface HardhatConfig {
        starknet: StarknetConfig;
    }

    export interface HardhatUserConfig {
        starknet?: StarknetConfig;
    }

    export interface NetworksConfig {
        alpha: HttpNetworkConfig;
        alphaMainnet: HttpNetworkConfig;
        integratedDevnet: HardhatNetworkConfig;
    }

    export interface NetworksUserConfig {
        integratedDevnet?: HardhatNetworkUserConfig;
    }

    export interface HttpNetworkConfig {
        verificationUrl?: string;
        verifiedUrl?: string;
        starknetChainId?: string;
    }

    export interface HardhatNetworkConfig {
        url?: string;
        venv?: string;
        dockerizedVersion?: string;
        starknetChainId?: string;
    }

    export interface HardhatNetworkUserConfig {
        url?: string;
        venv?: string;
        dockerizedVersion?: string;
    }
}

type StarknetContractType = StarknetContract;
type StarknetContractFactoryType = StarknetContractFactory;
type StringMapType = StringMap;
type AccountType = Account;
type OpenZeppelinAccountType = OpenZeppelinAccount;
type ArgentAccountType = ArgentAccount;
type TransactionReceiptType = TransactionReceipt;
type TransactionType = Transaction;
type BlockType = Block;

declare module "hardhat/types/runtime" {
    interface Devnet {
        /**
         * Restarts the devnet.
         * @returns void
         * @throws {@link HardhatPluginError}
         */
        restart(): Promise<void>;

        /**
         * Handles all pending L1 to L2 messages and sends them to the other layer
         * @returns {Promise} - Metadata for the flushed messages
         */
        flush: () => Promise<FlushResponse>;

        /**
         * Deploys or loads the L1 messaging contract.
         * @param {string} networkUrl - L1 network url.
         * @param {string} [address] - Address of the contract to be loaded.
         * @param {string} [networkId] - Determines if the ganache or tesnet should be used/
         * @returns
         */
        loadL1MessagingContract: (
            networkUrl: string,
            address?: string,
            networkId?: string
        ) => Promise<LoadL1MessagingContractResponse>;

        /**
         * Increases block time offset
         * @param seconds the offset increase in seconds
         * @returns an object containing the increased block time offset
         */
        increaseTime: (seconds: number) => Promise<IncreaseTimeResponse>;

        /**
         * Sets the timestamp of next block
         * @param seconds timestamp in seconds
         * @returns an object containg next block timestamp
         */
        setTime: (seconds: number) => Promise<SetTimeResponse>;
    }

    interface HardhatRuntimeEnvironment {
        starknetWrapper: StarknetWrapper;

        starknet: {
            /**
             * Fetches a compiled contract by name. E.g. if the contract is defined in MyContract.cairo,
             * the provided string should be `MyContract`.
             * @param name the case-sensitive contract name
             * @returns a factory for generating instances of the desired contract
             */
            getContractFactory: (name: string) => Promise<StarknetContractFactory>;

            /**
             * Cairo and Starknet source files may contain short string literals,
             * which are interpreted as numbers (felts) during Starknet runtime.
             * Use this utility function to provide short string arguments to your contract functions.
             *
             * This function converts such a short string (max 31 characters) to its felt representation (wrapped in a `BigInt`).
             * Only accepts standard ASCII characters, i.e. characters with charcode between 0 and 127, inclusive.
             * @param convertableString the input short string
             * @returns the numeric equivalent of the input short string, wrapped in a `BigInt`
             */
            shortStringToBigInt: (convertableString: string) => BigInt;

            /**
             * Converts a BigInt to a string. The opposite of {@link shortStringToBigInt}.
             * @param convertableBigInt the input BigInt
             * @returns a string which is the result of converting a BigInt's hex value to its ASCII equivalent
             */
            bigIntToShortString: (convertableBigInt: BigInt) => string;

            /**
             * Converts a Uint256 to a bigint. The opposite of {@link bigIntToUint256}.
             * @param uint256 the input uint256 to be converted
             * @returns the corresponding bigInt value
             */
            uint256toBigInt: (uint256: Uint256) => BigInt;

            /**
             * Converts a bigint to Uint256. The opposite of {@link uint256ToBigInt}.
             * @param bigInt the input to be converted
             * @returns the corresponding Uint256 value
             */
            bigIntToUint256: (bigInt: BigInt) => Uint256;

            /**
             * The selected starknet-network name.
             * Present if the called task relies on `--starknet-network` or `starknet["network"]` in the config object.
             */
            network?: string;

            /**
             * The selected starknet-network url.
             * Present if the called task relies on `--starknet-network` or `starknet["network"]` in the config object.
             */
            networkUrl?: string;

            /**
             * The configuration object of the selected starknet-network.
             */
            networkConfig?: HardhatNetworkConfig;

            /**
             * @param name the name of the wallet to get
             * @returns a wallet
             */
            getWallet: (name: string) => WalletConfig;

            devnet: Devnet;

            /**
             * Deploys an Account contract based on the ABI and the type of Account selected
             * @param accountType the enumerator value of the type of Account to use
             * @param options optional deployment options
             * @returns an Account object
             */
            deployAccount: (
                accountType: AccountImplementationType,
                options?: DeployAccountOptions
            ) => Promise<Account>;

            /**
             * Returns an Account already deployed based on the address and validated by the private key
             * @param address the address where the account is deployed
             * @param privateKey the private key of the account
             * @param accountType the enumerator value of the type of Account to use
             * @returns an Account object
             */
            getAccountFromAddress: (
                address: string,
                privateKey: string,
                accountType: AccountImplementationType
            ) => Promise<Account>;

            getTransaction: (txHash: string) => Promise<Transaction>;

            getTransactionReceipt: (txHash: string) => Promise<TransactionReceipt>;

            /**
             * Returns an entire block and the transactions contained within it.
             * @param identifier optional block identifier (by block number or hash). To query the latest block, remove the identifier.
             * @returns a block object
             */
            getBlock: (identifier?: BlockIdentifier) => Promise<Block>;
        };
    }

    type StarknetContract = StarknetContractType;
    type StarknetContractFactory = StarknetContractFactoryType;
    type StringMap = StringMapType;
    type Wallet = WalletConfig;
    type Account = AccountType;
    type OpenZeppelinAccount = OpenZeppelinAccountType;
    type ArgentAccount = ArgentAccountType;
    type Transaction = TransactionType;
    type TransactionReceipt = TransactionReceiptType;
    type Block = BlockType;
}
