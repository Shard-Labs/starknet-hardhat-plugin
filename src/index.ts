import * as path from "path";
import { task, extendEnvironment, extendConfig } from "hardhat/config";
import { HardhatPluginError, lazyObject } from "hardhat/plugins";
import { HardhatConfig, HardhatUserConfig } from "hardhat/types";
import exitHook from "exit-hook";

import "./type-extensions";
import {
    PLUGIN_NAME,
    DEFAULT_STARKNET_SOURCES_PATH,
    DEFAULT_STARKNET_ARTIFACTS_PATH,
    CAIRO_CLI_DEFAULT_DOCKER_IMAGE_TAG,
    CAIRO_CLI_DOCKER_REPOSITORY,
    ALPHA_URL,
    ALPHA_MAINNET_URL,
    VOYAGER_GOERLI_CONTRACT_API_URL,
    VOYAGER_MAINNET_CONTRACT_API_URL,
    DEFAULT_STARKNET_NETWORK,
    INTEGRATED_DEVNET_URL,
    ChainID,
    VOYAGER_GOERLI_VERIFIED_URL,
    VOYAGER_MAINNET_VERIFIED_URL
} from "./constants";
import { getDefaultHardhatNetworkConfig, getDefaultHttpNetworkConfig, getImageTagByArch, getNetwork } from "./utils";
import { DockerWrapper, VenvWrapper } from "./starknet-wrappers";
import {
    starknetCompileAction,
    starknetDeployAction,
    starknetVoyagerAction,
    starknetInvokeAction,
    starknetCallAction,
    starknetDeployAccountAction,
    starknetTestAction,
    starknetRunAction,
    starknetEstimateFeeAction
} from "./task-actions";
import {
    bigIntToShortStringUtil,
    deployAccountUtil,
    getAccountFromAddressUtil,
    getContractFactoryUtil,
    getTransactionUtil,
    getTransactionReceiptUtil,
    getWalletUtil,
    shortStringToBigIntUtil,
    getBlockUtil,
    uint256ToBigIntUtil,
    bigIntToUint256Util
} from "./extend-utils";
import { DevnetUtils } from "./devnet-utils";
import { IntegratedDevnet } from "./devnet";
import { Uint256 } from "./types";

exitHook(() => {
    IntegratedDevnet.cleanAll();
});

// copy all user-defined cairo settings; other extendConfig calls will overwrite if needed
extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    if (userConfig.starknet) {
        config.starknet = JSON.parse(JSON.stringify(userConfig.starknet));
    }
    if (!config.starknet) {
        config.starknet = {};
    }
});

// add sources path
extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    let newPath: string;
    if (userConfig.paths && userConfig.paths.starknetSources) {
        const userPath = userConfig.paths.starknetSources;
        if (path.isAbsolute(userPath)) {
            newPath = userPath;
        } else {
            newPath = path.normalize(path.join(config.paths.root, userPath));
        }
        config.paths.starknetSources = userConfig.paths.starknetSources;
    } else {
        const defaultPath = path.join(config.paths.root, DEFAULT_STARKNET_SOURCES_PATH);
        newPath = defaultPath;
    }

    config.paths.starknetSources = newPath;
});

// add artifacts path
extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    let newPath: string;
    if (userConfig.paths && userConfig.paths.starknetArtifacts) {
        const userPath = userConfig.paths.starknetArtifacts;
        if (path.isAbsolute(userPath)) {
            newPath = userPath;
        } else {
            newPath = path.normalize(path.join(config.paths.root, userPath));
        }
        config.paths.starknetArtifacts = userConfig.paths.starknetArtifacts;
    } else {
        const defaultPath = path.join(config.paths.root, DEFAULT_STARKNET_ARTIFACTS_PATH);
        newPath = defaultPath;
    }

    config.paths.starknetArtifacts = newPath;
});

// add url to alpha network
extendConfig((config: HardhatConfig) => {
    if (!config.networks.alpha) {
        config.networks.alpha = getDefaultHttpNetworkConfig(
            ALPHA_URL,
            VOYAGER_GOERLI_CONTRACT_API_URL,
            VOYAGER_GOERLI_VERIFIED_URL,
            ChainID.TESTNET
        );
    }

    if (!config.networks.alphaMainnet) {
        config.networks.alphaMainnet = getDefaultHttpNetworkConfig(
            ALPHA_MAINNET_URL,
            VOYAGER_MAINNET_CONTRACT_API_URL,
            VOYAGER_MAINNET_VERIFIED_URL,
            ChainID.MAINNET
        );
    }

    if (!config.networks.integratedDevnet) {
        config.networks.integratedDevnet = getDefaultHardhatNetworkConfig(INTEGRATED_DEVNET_URL);
    }
});

// set network as specified in userConfig
extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    if (userConfig.starknet && userConfig.starknet.network) {
        config.starknet.network = userConfig.starknet.network;
    } else {
        config.starknet.network = DEFAULT_STARKNET_NETWORK;
    }
    const networkConfig = getNetwork(
        config.starknet.network,
        config.networks,
        "starknet.network in hardhat.config"
    );
    config.starknet.networkUrl = networkConfig.url;
    config.starknet.networkConfig = networkConfig;
});

// add venv wrapper or docker wrapper of starknet
extendEnvironment((hre) => {
    const venvPath = hre.config.starknet.venv;
    if (venvPath) {
        if (hre.config.starknet.dockerizedVersion) {
            const msg =
                "Error in config file. Only one of (starknet.dockerizedVersion, starknet.venv) can be specified.";
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }
        hre.starknetWrapper = new VenvWrapper(venvPath);
    } else {
        const repository = CAIRO_CLI_DOCKER_REPOSITORY;
        const tag = getImageTagByArch(hre.config.starknet.dockerizedVersion || CAIRO_CLI_DEFAULT_DOCKER_IMAGE_TAG);

        hre.starknetWrapper = new DockerWrapper({ repository, tag });
    }
});

task("starknet-compile", "Compiles Starknet contracts")
    .addOptionalVariadicPositionalParam(
        "paths",
        "The paths to be used for deployment.\n" +
            "Each of the provided paths is recursively looked into while searching for compilation artifacts.\n" +
            "If no paths are provided, the default contracts directory is traversed."
    )
    .addOptionalParam(
        "cairoPath",
        "Allows specifying the locations of imported files, if necessary.\n" +
            "Separate them with a colon (:), e.g. --cairo-path='path/to/lib1:path/to/lib2'"
    )
    .addFlag("accountContract", "Allows compiling an account contract.")
    .addFlag("disableHintValidation", "Allows compiling a contract with any python code in hints.")
    .setAction(starknetCompileAction);

task("starknet-deploy", "Deploys Starknet contracts which have been compiled.")
    .addFlag("wait", "Wait for deployment transaction to be at least ACCEPTED_ON_L2")
    .addOptionalParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .addOptionalParam("gatewayUrl", `The URL of the gateway to be used (e.g. ${ALPHA_URL})`)
    .addOptionalParam(
        "inputs",
        "Space separated values forming constructor input.\n" +
            "Pass them as a single string; e.g. --inputs '1 2 3'\n" +
            "You would typically use this feature when deploying a single contract.\n" +
            "If you're deploying multiple contracts, they'll all use the same input."
    )
    .addOptionalParam(
        "salt",
        "An optional salt controlling where the contract will be deployed.\n" +
            "The contract deployment address is determined by the hash of contract, salt and caller.\n" +
            "If the salt is not supplied, the contract will be deployed with a random salt."
    )
    .addOptionalParam(
        "token",
        "An optional token indicating that your deployment is whitelisted on mainnet"
    )
    .addOptionalVariadicPositionalParam(
        "paths",
        "The paths to be used for deployment.\n" +
            "Each of the provided paths is recursively looked into while searching for compilation artifacts.\n" +
            "If no paths are provided, the default artifacts directory is traversed."
    )
    .setAction(starknetDeployAction);

extendEnvironment((hre) => {
    hre.starknet = {
        getContractFactory: async (contractPath) => {
            const contractFactory = await getContractFactoryUtil(hre, contractPath);
            return contractFactory;
        },

        shortStringToBigInt: (convertableString) => {
            const convertedString = shortStringToBigIntUtil(convertableString);
            return convertedString;
        },

        bigIntToShortString: (convertableBigInt) => {
            const convertedBigInt = bigIntToShortStringUtil(convertableBigInt);
            return convertedBigInt;
        },

        uint256toBigInt: (uint256: Uint256) => {
            return uint256ToBigIntUtil(uint256);
        },

        bigIntToUint256: (bigInt: BigInt) => {
            return bigIntToUint256Util(bigInt);
        },

        getWallet: (name) => {
            const wallet = getWalletUtil(name, hre);
            return wallet;
        },

        devnet: lazyObject(() => new DevnetUtils(hre)),

        deployAccount: async (accountType, options) => {
            const account = await deployAccountUtil(accountType, hre, options);
            return account;
        },

        getAccountFromAddress: async (address, privateKey, accountType) => {
            const account = await getAccountFromAddressUtil(address, privateKey, accountType, hre);
            return account;
        },

        getTransaction: async (txHash) => {
            const transaction = await getTransactionUtil(txHash, hre);
            return transaction;
        },

        getTransactionReceipt: async (txHash) => {
            const txReceipt = await getTransactionReceiptUtil(txHash, hre);
            return txReceipt;
        },

        getBlock: async (identifier) => {
            const block = await getBlockUtil(hre, identifier);
            return block;
        }
    };
});

task("starknet-verify", "Verifies a contract on a Starknet network.")
    .addOptionalParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .addParam("path", "The path of the main cairo contract (e.g. contracts/contract.cairo)")
    .addParam("address", "The address where the contract is deployed")
    .addParam("compilerVersion", "The compiler version used to compile the cairo contract")
    .addOptionalParam("license", "The licence of the contract (e.g No License (None))")
    .addOptionalVariadicPositionalParam(
        "paths",
        "The paths of the dependencies of the contract specified in --path" +
            "All dependencies should be in the same folder as the contract." +
            "e.g. path/to/dependency1 path/to/dependency2"
    )
    .setAction(starknetVoyagerAction);

task("starknet-invoke", "Invokes a function on a contract in the provided address.")
    .addFlag("wait", "Wait for invoke transaction to be at least ACCEPTED_ON_L2")
    .addOptionalParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .addOptionalParam("gatewayUrl", `The URL of the gateway to be used (e.g. ${ALPHA_URL})`)
    .addParam("contract", "The name of the contract to invoke from")
    .addParam("function", "The name of the function to invoke")
    .addParam("address", "The address where the contract is deployed")
    .addOptionalParam(
        "inputs",
        "Space separated values forming function input.\n" +
            "Pass them as a single string; e.g. --inputs '1 2 3'"
    )
    .addOptionalParam("signature", "The call signature")
    .addOptionalParam(
        "wallet",
        "The wallet to use, defined in the 'hardhat.config' file. If omitted, the '--no_wallet' flag will be passed when invoking."
    )
    .addOptionalParam("maxFee", "Maximum gas fee which you will tolerate.")
    .setAction(starknetInvokeAction);

task("starknet-call", "Invokes a function on a contract in the provided address.")
    .addOptionalParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .addOptionalParam("gatewayUrl", `The URL of the gateway to be used (e.g. ${ALPHA_URL})`)
    .addParam("contract", "The name of the contract to invoke from")
    .addParam("function", "The name of the function to invoke")
    .addParam("address", "The address where the contract is deployed")
    .addOptionalParam(
        "inputs",
        "Space separated values forming function input.\n" +
            "Pass them as a single string; e.g. --inputs '1 2 3'"
    )
    .addOptionalParam("signature", "The call signature")
    .addOptionalParam(
        "wallet",
        "The wallet to use, defined in the 'hardhat.config' file. If omitted, the '--no_wallet' flag will be passed when calling."
    )
    .addOptionalParam(
        "blockNumber",
        "The number of the block to call. If omitted, the pending block will be queried."
    )
    .addOptionalParam("nonce", "The nonce to provide to your account")
    .addOptionalParam("maxFee", "Maximum gas fee which you will tolerate.")
    .setAction(starknetCallAction);

task("starknet-estimate-fee", "Estimates the gas fee of a function execution.")
    .addOptionalParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .addOptionalParam("gatewayUrl", `The URL of the gateway to be used (e.g. ${ALPHA_URL})`)
    .addParam("contract", "The name of the contract to invoke from")
    .addParam("function", "The name of the function to invoke")
    .addParam("address", "The address where the contract is deployed")
    .addOptionalParam(
        "inputs",
        "Space separated values forming function input.\n" +
            "Pass them as a single string; e.g. --inputs '1 2 3'"
    )
    .addOptionalParam("signature", "The call signature")
    .addOptionalParam(
        "wallet",
        "The wallet to use, defined in the 'hardhat.config' file. If omitted, the '--no_wallet' flag will be passed when calling."
    )
    .addOptionalParam(
        "blockNumber",
        "The number of the block to call. If omitted, the pending block will be queried."
    )
    .addOptionalParam("nonce", "The nonce to provide to your account")
    .setAction(starknetEstimateFeeAction);

task("starknet-deploy-account", "Deploys a new account according to the parameters.")
    .addParam("wallet", "The wallet object to use, defined in the 'hardhat.config' file")
    .addParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .setAction(starknetDeployAccountAction);

const STARKNET_NETWORK_DESCRIPTION =
    "Specify the starknet-network to be used; overrides the value from hardhat.config";

task("test")
    .addOptionalParam("starknetNetwork", STARKNET_NETWORK_DESCRIPTION)
    .setAction(starknetTestAction);

task("run").setAction(starknetRunAction);
