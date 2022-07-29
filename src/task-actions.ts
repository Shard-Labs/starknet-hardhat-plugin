import * as path from "path";
import * as fs from "fs";
import axios from "axios";
import FormData = require("form-data");
import { HardhatPluginError } from "hardhat/plugins";
import { PLUGIN_NAME, ABI_SUFFIX, ALPHA_TESTNET, DEFAULT_STARKNET_NETWORK } from "./constants";
import { iterativelyCheckStatus, extractTxHash, InteractChoice } from "./types";
import { ProcessResult } from "@nomiclabs/hardhat-docker";
import {
    adaptLog,
    traverseFiles,
    checkArtifactExists,
    getNetwork,
    findPath,
    getAccountPath,
    isStarknetDevnet
} from "./utils";
import {
    HardhatNetworkConfig,
    HardhatRuntimeEnvironment,
    HttpNetworkConfig,
    RunSuperFunction,
    TaskArguments
} from "hardhat/types";
import { getWalletUtil } from "./extend-utils";
import { createIntegratedDevnet } from "./devnet";
import { Recompiler } from "./recompiler";


function checkSourceExists(sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) {
        const msg = `Source expected to be at ${sourcePath}, but not found.`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }
}

/**
 * Transfers logs and generates a return status code.
 *
 * @param executed The process result of running the container
 * @returns 0 if succeeded, 1 otherwise
 */
function processExecuted(executed: ProcessResult, logStatus: boolean): number {
    if (executed.stdout.length) {
        console.log(adaptLog(executed.stdout.toString()));
    }

    if (executed.stderr.length) {
        // synchronize param names reported by actual CLI with param names used by this plugin
        const err = executed.stderr.toString();
        const replacedErr = adaptLog(err);
        console.error(replacedErr);
    }

    if (logStatus) {
        const finalMsg = executed.statusCode ? "Failed" : "Succeeded";
        console.log(`\t${finalMsg}\n`);
    }
    return executed.statusCode ? 1 : 0;
}

function isStarknetCompilationArtifact(filePath: string) {
    const content = fs.readFileSync(filePath).toString();
    let parsed = null;
    try {
        parsed = JSON.parse(content);
    } catch (err) {
        return false;
    }

    return !!parsed.entry_points_by_type;
}

/**
 * First deletes the file if it already exists. Then creates an empty file at the provided path.
 * Unlinking/deleting is necessary if user switched from docker to venv.
 * @param filePath the file to be recreated
 */
function initializeFile(filePath: string) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    fs.closeSync(fs.openSync(filePath, "w"));
}

function getFileName(filePath: string) {
    return path.basename(filePath, path.extname(filePath));
}

/**
 * Extracts gatewayUrl from args or process.env.STARKNET_NETWORK.
 *
 * @param args the object containing CLI args
 * @param hre environment whose networks and starknet.network are accessed
 * @returns the URL of the gateway to be used; can return `undefined` if `required` set to `false`
 */
function getGatewayUrl(args: TaskArguments, hre: HardhatRuntimeEnvironment): string {
    const gatewayUrl: string = args.gatewayUrl;
    const networkName: string = args.starknetNetwork || process.env.STARKNET_NETWORK;

    if (gatewayUrl && !networkName) {
        return gatewayUrl;
    }

    if (gatewayUrl && networkName) {
        const msg = "Only one of starknet-network and gateway-url should be provided.";
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }

    if (!networkName) {
        // we already know no gatewayUrl is provided
        const msg = "No starknet-network or gateway-url provided.";
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }

    const network = getNetwork(networkName, hre.config.networks, "starknet-network");
    return network.url;
}

export async function starknetCompileAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    const root = hre.config.paths.root;
    const rootRegex = new RegExp("^" + root);

    const defaultSourcesPath = hre.config.paths.starknetSources;
    const sourcesPaths: string[] = args.paths || [defaultSourcesPath];
    const artifactsPath = hre.config.paths.starknetArtifacts;

    const cairoPaths = [defaultSourcesPath, root];
    if (args.cairoPath) {
        args.cairoPath.split(":").forEach((path: string) => {
            cairoPaths.push(path);
        });
    }
    if (hre.config.paths.cairoPaths) {
        hre.config.paths.cairoPaths.forEach((path: string) => {
            cairoPaths.push(path);
        });
    }
    for (let i = 0; i < cairoPaths.length; i++) {
        if (!path.isAbsolute(cairoPaths[i])) {
            cairoPaths[i] = path.normalize(path.join(root, cairoPaths[i]));
        }
    }

    const cairoPath = cairoPaths.join(":");
    let statusCode = 0;
    for (let sourcesPath of sourcesPaths) {
        if (!path.isAbsolute(sourcesPath)) {
            sourcesPath = path.normalize(path.join(root, sourcesPath));
        }
        checkSourceExists(sourcesPath);
        const files = await traverseFiles(sourcesPath, "*.cairo");
        const recompiler = new Recompiler(hre);
        for (const file of files) {
            console.log("Compiling", file);
            const suffix = file.replace(rootRegex, "");
            const fileName = getFileName(suffix);
            const dirPath = path.join(artifactsPath, suffix);
            const outputPath = path.join(dirPath, `${fileName}.json`);
            const abiPath = path.join(dirPath, `${fileName}${ABI_SUFFIX}`);

            fs.mkdirSync(dirPath, { recursive: true });
            initializeFile(outputPath);
            initializeFile(abiPath);

            const executed = await hre.starknetWrapper.compile({
                file,
                output: outputPath,
                abi: abiPath,
                cairoPath,
                accountContract: args.accountContract,
                disableHintValidation: args.disableHintValidation
            });

            // Update cache after compilation
            await recompiler.updateCache(args, file, outputPath, abiPath, cairoPath);
            statusCode += processExecuted(executed, true);
        }
        await recompiler.saveCache();
    }

    if (statusCode) {
        const msg = `Failed compilation of ${statusCode} contract${statusCode === 1 ? "" : "s"}.`;
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }
}

export async function starknetDeployAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    await new Recompiler(hre).handleCache();
    const gatewayUrl = getGatewayUrl(args, hre);
    const defaultArtifactsPath = hre.config.paths.starknetArtifacts;
    const artifactsPaths: string[] = args.paths || [defaultArtifactsPath];
    const intRegex = new RegExp(/^-?\d+$/);

    let statusCode = 0;
    const txHashes: string[] = [];
    for (let artifactsPath of artifactsPaths) {
        if (intRegex.test(artifactsPath)) {
            console.warn(
                "\x1b[33m%s\x1b[0m",
                `Warning! Found an integer "${artifactsPath}" as an artifact path.\n` +
                    "Make sure that all inputs are passed within a single string (e.g --inputs '10 20 30')"
            );
        }

        // Check if input is the name of the contract and not a path
        if (artifactsPath === path.basename(artifactsPath)) {
            const metadataSearchTarget = path.join(
                `${artifactsPath}.cairo`,
                `${path.basename(artifactsPath)}.json`
            );
            const foundPath = await findPath(defaultArtifactsPath, metadataSearchTarget);
            artifactsPath = foundPath || metadataSearchTarget;
        } else if (!path.isAbsolute(artifactsPath)) {
            artifactsPath = path.normalize(path.join(hre.config.paths.root, artifactsPath));
        }
        checkArtifactExists(artifactsPath);

        const paths = await traverseFiles(artifactsPath, "*.json");
        const files = paths.filter(isStarknetCompilationArtifact);
        for (const file of files) {
            console.log("Deploying", file);
            const executed = await hre.starknetWrapper.deploy({
                contract: file,
                gatewayUrl,
                inputs: args.inputs?.split(/\s+/),
                salt: args.salt,
                token: args.token
            });
            if (args.wait) {
                const execResult = processExecuted(executed, false);
                if (execResult == 0) {
                    txHashes.push(extractTxHash(executed.stdout.toString()));
                }
                statusCode += execResult;
            } else {
                statusCode += processExecuted(executed, true);
            }
        }
    }

    if (args.wait) {
        // If the "wait" flag was passed as an argument, check the previously stored transaction hashes for their statuses
        console.log(`Checking deployment transaction${txHashes.length === 1 ? "" : "s"}...`);
        const promises = txHashes.map(
            (hash) =>
                new Promise<void>((resolve, reject) =>
                    iterativelyCheckStatus(
                        hash,
                        hre.starknetWrapper,
                        gatewayUrl,
                        gatewayUrl,
                        (status) => {
                            console.log(`Deployment transaction ${hash} is now ${status}`);
                            resolve();
                        },
                        (error) => {
                            console.log(`Deployment transaction ${hash} is REJECTED`);
                            reject(error);
                        }
                    )
                )
        );
        await Promise.allSettled(promises);
    }

    if (statusCode) {
        throw new HardhatPluginError(PLUGIN_NAME, `Failed deployment of ${statusCode} contracts`);
    }
}

/**
 * Extracts the verification URL assigned to the network provided.
 * If no `networkName` is provided, defaults to Alpha testnet.
 * If `networkName` is provided, but not supported for verification, an error is thrown.
 * @param networkName the name of the network
 * @param hre the runtime environment from which network data is extracted
 * @param origin short string describing where/how `networkName` was specified
 */
function getVerificationNetwork(
    networkName: string,
    hre: HardhatRuntimeEnvironment,
    origin: string
) {
    networkName ||= ALPHA_TESTNET;
    const network = getNetwork<HttpNetworkConfig>(networkName, hre.config.networks, origin);
    if (!network.verificationUrl) {
        throw new HardhatPluginError(
            PLUGIN_NAME,
            `Network ${networkName} does not support Voyager verification.`
        );
    }
    return network;
}

export async function starknetVoyagerAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    const network = getVerificationNetwork(args.starknetNetwork, hre, "--starknet-network");
    const voyagerUrl = `${network.verificationUrl}${args.address}/code`;
    const verifiedUrl = `${network.verifiedUrl}${args.address}#code`;

    let isVerified = false;
    try {
        const resp = await axios.get(voyagerUrl);
        const data = resp.data;

        if (data.contract) {
            if (data.contract.length > 0 || Object.keys(data.contract).length > 0) {
                isVerified = true;
            }
        }
    } catch (error) {
        const msg =
            "Something went wrong while checking if the contract has already been verified.";
        throw new HardhatPluginError(PLUGIN_NAME, msg);
    }

    if (isVerified) {
        console.log(`Contract at address ${args.address} has already been verified`);
        console.log(`Check it out on Voyager: ${verifiedUrl}`);
    } else {
        await handleContractVerification(args, voyagerUrl, verifiedUrl, hre);
    }
}

function getMainVerificationPath(contractPath: string, root: string) {
    if (!path.isAbsolute(contractPath)) {
        contractPath = path.normalize(path.join(root, contractPath));
        if (!fs.existsSync(contractPath)) {
            throw new HardhatPluginError(PLUGIN_NAME, `File ${contractPath} does not exist`);
        }
    }
    return contractPath;
}

async function handleContractVerification(
    args: TaskArguments,
    voyagerUrl: string,
    verifiedUrl: string,
    hre: HardhatRuntimeEnvironment
) {
    // Set main contract path
    const mainPath = getMainVerificationPath(args.path, hre.config.paths.root);
    const paths = [mainPath];

    const bodyFormData = new FormData();
    bodyFormData.append("compiler-version", args.compilerVersion);
    let accountContract;
    if (args.accountContract === "true") {
        accountContract = "true";
    } else if (!args.accountContract || args.accountContract === "false") {
        accountContract = "false";
    } else {
        throw new HardhatPluginError(PLUGIN_NAME, "--account-contract must be true or false");
    }
    bodyFormData.append("account-contract", accountContract);
    bodyFormData.append("license", args.license || "No License (None)");

    // Dependencies (non-main contracts) are in args.paths
    if (args.paths) {
        paths.push(...args.paths);
    }

    const sourceRegex = new RegExp("^" + hre.config.paths.starknetSources + "/");
    const contractNameDefault = mainPath.replace(sourceRegex, "");
    // If contract name is not provided, use the default
    bodyFormData.append("contract-name", contractNameDefault);
    // Appends all contracts to the form data with the name "file" + index
    handleMultiPartContractVerification(bodyFormData, paths, hre.config.paths.root, sourceRegex);

    await axios
        .post(voyagerUrl, bodyFormData.getBuffer(), {
            headers: bodyFormData.getHeaders()
        })
        .catch((err) => {
            throw new HardhatPluginError(
                PLUGIN_NAME,
                `\
Could not verify the contract at address ${args.address}.
${
    err.response.data.message ||
    `It is hard to tell exactly what happened, but possible reasons include:
- Deployment transaction hasn't been accepted or indexed yet (check its tx_status or try in a minute)
- Wrong contract address
- Wrong files provided
- Wrong main contract chosen (first after --path)
- Voyager is down`
}
            `
            );
        });

    console.log(`Contract has been successfuly verified at address ${args.address}`);
    console.log(`Check it out on Voyager: ${verifiedUrl}`);
}

function handleMultiPartContractVerification(
    bodyFormData: FormData,
    paths: string[],
    root: string,
    sourceRegex: RegExp
) {
    paths.forEach(function (item: string, index: number) {
        if (!path.isAbsolute(item)) {
            paths[index] = path.normalize(path.join(root, item));
            if (!fs.existsSync(paths[index])) {
                throw new HardhatPluginError(PLUGIN_NAME, `File ${paths[index]} does not exist`);
            }
        }
        bodyFormData.append("file" + index, fs.readFileSync(paths[index]), {
            filepath: paths[index].replace(sourceRegex, ""),
            contentType: "application/octet-stream"
        });
    });
}

export async function starknetInvokeAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    await new Recompiler(hre).handleCache();
    await starknetInteractAction(InteractChoice.INVOKE, args, hre);
}

export async function starknetCallAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    await new Recompiler(hre).handleCache();
    await starknetInteractAction(InteractChoice.CALL, args, hre);
}

export async function starknetEstimateFeeAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment
) {
    await starknetInteractAction(InteractChoice.ESTIMATE_FEE, args, hre);
}

async function starknetInteractAction(
    choice: InteractChoice,
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment
) {
    const gatewayUrl = getGatewayUrl(args, hre);
    const contractFactory = await hre.starknet.getContractFactory(args.contract);
    const abiPath = contractFactory.getAbiPath();

    let wallet, accountDir;
    if (args.wallet) {
        wallet = getWalletUtil(args.wallet, hre);
        accountDir = getAccountPath(wallet.accountPath, hre);
    }

    const executed = await hre.starknetWrapper.interact({
        choice: choice,
        address: args.address,
        abi: abiPath,
        functionName: args.function,
        inputs: args.inputs ? args.inputs.split(/\s+/) : undefined,
        signature: args.signature?.split(/\s+/),
        wallet: wallet ? wallet.modulePath : undefined,
        chainID: hre.config.starknet.networkConfig.starknetChainId,
        account: wallet ? wallet.accountName : undefined,
        accountDir: wallet ? accountDir : undefined,
        gatewayUrl: gatewayUrl,
        feederGatewayUrl: gatewayUrl,
        blockNumber: args.blockNumber ? args.blockNumber : undefined,
        networkID: wallet ? args.starknetNetwork : undefined,
        maxFee: args.maxFee ? args.maxFee : undefined,
        nonce: args.nonce ? args.nonce : undefined
    });

    const statusCode = processExecuted(executed, true);

    if (statusCode) {
        const msg =
            `Could not perform ${choice.cliCommand} of ${args.function}:\n` +
            executed.stderr.toString();
        const replacedMsg = adaptLog(msg);
        throw new HardhatPluginError(PLUGIN_NAME, replacedMsg);
    }

    if (choice === InteractChoice.INVOKE && args.wait) {
        // If the "wait" flag was passed as an argument, check the transaction hash for its status
        console.log("Checking transaction...");
        const executedOutput = executed.stdout.toString();
        const txHash = extractTxHash(executedOutput);
        await new Promise<void>((resolve, reject) =>
            iterativelyCheckStatus(
                txHash,
                hre.starknetWrapper,
                gatewayUrl,
                gatewayUrl,
                (status) => {
                    console.log(`Invoke transaction ${txHash} is now ${status}`);
                    resolve();
                },
                (error) => {
                    console.error(`Invoke transaction ${txHash} is REJECTED`);
                    reject(error);
                }
            )
        );
    }
}

export async function starknetDeployAccountAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment
) {
    const gatewayUrl = getGatewayUrl(args, hre);
    const wallet = getWalletUtil(args.wallet, hre);
    const accountDir = getAccountPath(wallet.accountPath, hre);

    fs.mkdirSync(accountDir, { recursive: true });

    const executed = await hre.starknetWrapper.deployAccount({
        accountDir: accountDir,
        accountName: wallet.accountName,
        feederGatewayUrl: gatewayUrl,
        gatewayUrl: gatewayUrl,
        network: args.starknetNetwork,
        wallet: wallet.modulePath
    });

    const statusCode = processExecuted(executed, true);

    if (statusCode) {
        const msg = "Could not deploy account contract:\n" + executed.stderr.toString();
        const replacedMsg = adaptLog(msg);
        throw new HardhatPluginError(PLUGIN_NAME, replacedMsg);
    }
}

/**
 * Used later on for network interaction.
 * @param args Hardhat CLI args
 * @param hre HardhatRuntimeEnvironment
 */
function setRuntimeNetwork(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    let networkName;
    let networkConfig: HardhatNetworkConfig;
    if (args.starknetNetwork) {
        networkName = args.starknetNetwork;
        networkConfig = getNetwork(networkName, hre.config.networks, "--starknet-network");
    } else if (hre.config.starknet.network) {
        networkName = hre.config.starknet.network;
        networkConfig = getNetwork(
            networkName,
            hre.config.networks,
            "starknet.network in hardhat.config"
        );
    } else {
        networkName = DEFAULT_STARKNET_NETWORK;
        networkConfig = getNetwork(networkName, hre.config.networks, "default settings");
    }

    // The hre.starknet.PROPERTY (in the second column) is to allow users access starknet runtime properties
    hre.config.starknet.network = hre.starknet.network = networkName;
    hre.config.starknet.networkUrl = hre.starknet.networkUrl = networkConfig.url;
    hre.config.starknet.networkConfig = hre.starknet.networkConfig = networkConfig;
    console.log(`Using network ${hre.starknet.network} at ${hre.starknet.networkUrl}`);
}

async function runWithDevnet(hre: HardhatRuntimeEnvironment, fn: () => Promise<unknown>) {
    if (!isStarknetDevnet(hre.starknet.network)) {
        await fn();
        return;
    }

    const devnet = createIntegratedDevnet(hre);

    await devnet.start();
    await fn();
    devnet.stop();
}

export async function starknetTestAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
) {
    await new Recompiler(hre).handleCache();
    setRuntimeNetwork(args, hre);

    await runWithDevnet(hre, async () => {
        await runSuper(args);
    });
}

export async function starknetRunAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
) {
    await new Recompiler(hre).handleCache();
    setRuntimeNetwork(args, hre);

    await runWithDevnet(hre, async () => {
        await runSuper(args);
    });
}
