import * as fs from "fs";
import * as starknet from "./starknet-types";
import { HardhatPluginError } from "hardhat/plugins";
import {
    PLUGIN_NAME,
    CHECK_STATUS_TIMEOUT,
    CHECK_STATUS_RECOVER_TIMEOUT
} from "./constants";
import { adaptLog, copyWithBigint } from "./utils";
import { adaptInputUtil, adaptOutputUtil } from "./adapt";
import { StarknetWrapper } from "./starknet-wrappers";
import { Wallet } from "hardhat/types";

/**
 * According to: https://starknet.io/docs/hello_starknet/intro.html#interact-with-the-contract
 * Not using an enum to avoid code duplication and reverse mapping.
 */
export type TxStatus =
    /** The transaction passed the validation and entered the pending block. */
    | "PENDING"

    /** The transaction has not been received yet (i.e., not written to storage). */
    | "NOT_RECEIVED"

    /** The transaction was received by the operator. */
    | "RECEIVED"

    /** The transaction failed validation and thus was skipped. */
    | "REJECTED"

    /** The transaction passed the validation and entered an actual created block. */
    | "ACCEPTED_ON_L2"

    /** The transaction was accepted on-chain. */
    | "ACCEPTED_ON_L1";

// Types of account implementations
export type AccountImplementationType = "OpenZeppelin" | "Argent";

export type InvokeResponse = string;

export type StarknetContractFactoryConfig = StarknetContractConfig & {
    metadataPath: string;
};

export type TxFailureReason = {
    code: string;
    error_message: string;
    tx_id: string;
};

export type FeeEstimation = {
    amount: bigint;
    unit: string;
};

export interface StarknetContractConfig {
    starknetWrapper: StarknetWrapper;
    abiPath: string;
    networkID: string;
    chainID: string;
    gatewayUrl: string;
    feederGatewayUrl: string;
}

export type Numeric = number | bigint;

export interface Uint256 {
    low: Numeric;
    high: Numeric;
}

/**
 * Object whose keys are strings (names) and values are any object.
 */
export interface StringMap {
    [key: string]: any;
}

const TRANSACTION_VERSION = 0;
const QUERY_VERSION = BigInt(2) ** BigInt(128);

/**
 * Enumerates the ways of interacting with a contract.
 */
export class InteractChoice {
    static readonly INVOKE = new InteractChoice("invoke", "invoke", true, TRANSACTION_VERSION);

    static readonly CALL = new InteractChoice("call", "call", true, QUERY_VERSION);

    static readonly ESTIMATE_FEE = new InteractChoice(
        "estimate_fee",
        "estimateFee",
        false,
        QUERY_VERSION
    );

    private constructor(
        /**
         * The way it's supposed to be used passed to CLI commands.
         */
        public readonly cliCommand: string,
        /**
         * The way it's supposed to be used internally in code.
         */
        public readonly internalCommand: keyof StarknetContract,

        /**
         * Indicates whether the belonging CLI option allows specifying max_fee.
         */
        public readonly allowsMaxFee: boolean,

        /**
         * The version of the transaction.
         */
        public transactionVersion: Numeric
    ) {}
}

export function extractTxHash(response: string) {
    return extractFromResponse(response, /^Transaction hash: (.*)$/m);
}

function extractAddress(response: string) {
    return extractFromResponse(response, /^Contract address: (.*)$/m);
}

function extractFromResponse(response: string, regex: RegExp) {
    const matched = response.match(regex);
    if (!matched || !matched[1]) {
        throw new HardhatPluginError(
            PLUGIN_NAME,
            "Could not parse response. Check that you're using the correct network."
        );
    }
    return matched[1];
}

/**
 * The object returned by starknet tx_status.
 */
type StatusObject = {
    block_hash: string;
    tx_status: TxStatus;
    tx_failure_reason?: TxFailureReason;
};

async function checkStatus(
    hash: string,
    starknetWrapper: StarknetWrapper,
    gatewayUrl: string,
    feederGatewayUrl: string
): Promise<StatusObject> {
    const executed = await starknetWrapper.getTxStatus({
        hash,
        gatewayUrl,
        feederGatewayUrl
    });
    if (executed.statusCode) {
        throw new HardhatPluginError(PLUGIN_NAME, executed.stderr.toString());
    }

    const response = executed.stdout.toString();
    try {
        const responseParsed = JSON.parse(response);
        return responseParsed;
    } catch (err) {
        throw new HardhatPluginError(PLUGIN_NAME, `Cannot interpret the following: ${response}`);
    }
}

const ACCEPTABLE_STATUSES: TxStatus[] = ["PENDING", "ACCEPTED_ON_L2", "ACCEPTED_ON_L1"];
export function isTxAccepted(statusObject: StatusObject): boolean {
    return ACCEPTABLE_STATUSES.includes(statusObject.tx_status);
}

const UNACCEPTABLE_STATUSES: TxStatus[] = ["REJECTED"];
function isTxRejected(statusObject: StatusObject): boolean {
    return UNACCEPTABLE_STATUSES.includes(statusObject.tx_status);
}

export async function iterativelyCheckStatus(
    txHash: string,
    starknetWrapper: StarknetWrapper,
    gatewayUrl: string,
    feederGatewayUrl: string,
    resolve: (status: string) => void,
    reject: (reason?: any) => void
) {
    const statusObject = await checkStatus(
        txHash,
        starknetWrapper,
        gatewayUrl,
        feederGatewayUrl
    ).catch((reason) => {
        console.warn(reason);
        return undefined;
    });

    if (!statusObject) {
        console.warn("Retrying transaction status check...");
        // eslint-disable-next-line prefer-rest-params
        setTimeout(iterativelyCheckStatus, CHECK_STATUS_RECOVER_TIMEOUT, ...arguments);
    } else if (isTxAccepted(statusObject)) {
        resolve(statusObject.tx_status);
    } else if (isTxRejected(statusObject)) {
        reject(
            new Error(
                "Transaction rejected. Error message:\n\n" +
                    statusObject.tx_failure_reason.error_message
            )
        );
    } else {
        // Make a recursive call, but with a delay.
        // Local var `arguments` holds what was passed in the current call

        // eslint-disable-next-line prefer-rest-params
        setTimeout(iterativelyCheckStatus, CHECK_STATUS_TIMEOUT, ...arguments);
    }
}

/**
 * Reads ABI from `abiPath` and converts it to an object for lookup by name.
 * @param abiPath the path where ABI is stored on disk
 * @returns an object mapping ABI entry names with their values
 */
function readAbi(abiPath: string): starknet.Abi {
    const abiRaw = fs.readFileSync(abiPath).toString();
    const abiArray = JSON.parse(abiRaw);
    const abi: starknet.Abi = {};
    for (const abiEntry of abiArray) {
        if (!abiEntry.name) {
            const msg = `Abi entry has no name: ${abiEntry}`;
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }
        abi[abiEntry.name] = abiEntry;
    }
    return abi;
}

/**
 * Add `signature` elements to to `starknetArgs`, if there are any.
 * @param signature array of transaction signature elements
 */
function handleSignature(signature: Array<Numeric>): string[] {
    if (signature) {
        return signature.map((s) => s.toString());
    }
    return [];
}

export function parseFeeEstimation(raw: string): FeeEstimation {
    const matched = raw.match(/^The estimated fee is: (?<amount>.*) WEI \(.* ETH\)\./);
    if (matched) {
        return {
            amount: BigInt(matched.groups.amount),
            unit: "wei"
        };
    }
    throw new HardhatPluginError(PLUGIN_NAME, "Cannot parse fee estimation response.");
}

/**
 * Returns a modified copy of the provided object with its blockNumber set to pending.
 * @param options the options object with a blockNumber key
 */
function defaultToPendingBlock<T extends { blockNumber?: BlockNumber }>(options: T): T {
    const adaptedOptions = copyWithBigint<T>(options);
    if (adaptedOptions.blockNumber === undefined) {
        // using || operator would not handle the zero case correctly
        adaptedOptions.blockNumber = "pending";
    }
    return adaptedOptions;
}

export interface DeployOptions {
    salt?: string;
    token?: string;
}

export interface DeployAccountOptions extends DeployOptions {
    /** Optional hex string. If not provided, a random value is generated. */
    privateKey?: string;
}

export interface InvokeOptions {
    signature?: Array<Numeric>;
    wallet?: Wallet;
    nonce?: Numeric;
    maxFee?: Numeric;
}

export interface CallOptions {
    signature?: Array<Numeric>;
    wallet?: Wallet;
    blockNumber?: BlockNumber;
    nonce?: Numeric;
    maxFee?: Numeric;
    rawOutput?: boolean;
}

export type EstimateFeeOptions = CallOptions;

export type InteractOptions = InvokeOptions | CallOptions | EstimateFeeOptions;

export type ContractInteractionFunction = (
    functionName: string,
    args?: StringMap,
    options?: InteractOptions
) => Promise<any>;

export type BlockNumber = number | "pending" | "latest";

export interface BlockIdentifier {
    blockNumber?: BlockNumber;
    blockHash?: string;
}

export class StarknetContractFactory {
    private starknetWrapper: StarknetWrapper;
    private abi: starknet.Abi;
    private abiPath: string;
    private constructorAbi: starknet.CairoFunction;
    private metadataPath: string;
    private networkID: string;
    private chainID: string;
    private gatewayUrl: string;
    private feederGatewayUrl: string;

    constructor(config: StarknetContractFactoryConfig) {
        this.starknetWrapper = config.starknetWrapper;
        this.abiPath = config.abiPath;
        this.abi = readAbi(this.abiPath);
        this.networkID = config.networkID;
        this.chainID = config.chainID;
        this.gatewayUrl = config.gatewayUrl;
        this.feederGatewayUrl = config.feederGatewayUrl;
        this.metadataPath = config.metadataPath;

        // find constructor
        for (const abiEntryName in this.abi) {
            const abiEntry = this.abi[abiEntryName];
            if (abiEntry.type === "constructor") {
                this.constructorAbi = <starknet.CairoFunction>abiEntry;
            }
        }
    }

    /**
     * Deploy a contract instance to a new address.
     * Optionally pass constructor arguments.
     *
     * E.g. if there is a function
     * ```text
     * @constructor
     * func constructor{
     *     syscall_ptr : felt*,
     *     pedersen_ptr : HashBuiltin*,
     *     range_check_ptr
     * } (initial_balance : felt):
     *     balance.write(initial_balance)
     *     return ()
     * end
     * ```
     * this plugin allows you to call it like:
     * ```
     * const contractFactory = ...;
     * const instance = await contractFactory.deploy({ initial_balance: 100 });
     * ```
     * @param constructorArguments constructor arguments of Starknet contract
     * @param options optional additions to deploying
     * @returns the newly created instance
     */
    async deploy(
        constructorArguments?: StringMap,
        options: DeployOptions = {}
    ): Promise<StarknetContract> {
        const executed = await this.starknetWrapper.deploy({
            contract: this.metadataPath,
            inputs: this.handleConstructorArguments(constructorArguments),
            gatewayUrl: this.gatewayUrl,
            salt: options.salt,
            token: options.token
        });
        if (executed.statusCode) {
            const msg = `Could not deploy contract: ${executed.stderr.toString()}`;
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }

        const executedOutput = executed.stdout.toString();
        const address = extractAddress(executedOutput);
        const txHash = extractTxHash(executedOutput);
        const contract = new StarknetContract({
            abiPath: this.abiPath,
            starknetWrapper: this.starknetWrapper,
            networkID: this.networkID,
            chainID: this.chainID,
            feederGatewayUrl: this.feederGatewayUrl,
            gatewayUrl: this.gatewayUrl
        });
        contract.address = address;
        contract.deployTxHash = txHash;

        return new Promise<StarknetContract>((resolve, reject) => {
            iterativelyCheckStatus(
                txHash,
                this.starknetWrapper,
                this.gatewayUrl,
                this.feederGatewayUrl,
                () => resolve(contract),
                reject
            );
        });
    }

    private handleConstructorArguments(constructorArguments: StringMap): string[] {
        if (!this.constructorAbi) {
            const argsProvided = Object.keys(constructorArguments || {}).length;
            if (argsProvided) {
                const msg = `No constructor arguments required but ${argsProvided} provided`;
                throw new HardhatPluginError(PLUGIN_NAME, msg);
            }
            return [];
        }
        return adaptInputUtil(
            this.constructorAbi.name,
            constructorArguments,
            this.constructorAbi.inputs,
            this.abi
        );
    }

    /**
     * Returns a contract instance with set address.
     * No address validity checks are performed.
     * @param address the address of a previously deployed contract
     * @returns the contract instance at the provided address
     */
    getContractAt(address: string) {
        if (!address) {
            throw new HardhatPluginError(PLUGIN_NAME, "No address provided");
        }
        const contract = new StarknetContract({
            abiPath: this.abiPath,
            starknetWrapper: this.starknetWrapper,
            networkID: this.networkID,
            chainID: this.chainID,
            feederGatewayUrl: this.feederGatewayUrl,
            gatewayUrl: this.gatewayUrl
        });
        contract.address = address;
        return contract;
    }

    getAbiPath() {
        return this.abiPath;
    }
}

export class StarknetContract {
    private starknetWrapper: StarknetWrapper;
    private abi: starknet.Abi;
    private abiPath: string;
    private networkID: string;
    private chainID: string;
    private gatewayUrl: string;
    private feederGatewayUrl: string;
    private _address: string;
    public deployTxHash: string;

    constructor(config: StarknetContractConfig) {
        this.starknetWrapper = config.starknetWrapper;
        this.abiPath = config.abiPath;
        this.abi = readAbi(this.abiPath);
        this.networkID = config.networkID;
        this.chainID = config.chainID;
        this.gatewayUrl = config.gatewayUrl;
        this.feederGatewayUrl = config.feederGatewayUrl;
    }

    get address(): string {
        return this._address;
    }

    set address(address: string) {
        this._address = address;
        return;
    }

    private async interact(
        choice: InteractChoice,
        functionName: string,
        args?: StringMap,
        options: InteractOptions = {}
    ) {
        if (!this.address) {
            throw new HardhatPluginError(PLUGIN_NAME, "Contract not deployed");
        }

        const adaptedInput = this.adaptInput(functionName, args);
        const executed = await this.starknetWrapper.interact({
            choice,
            address: this.address,
            abi: this.abiPath,
            functionName: functionName,
            inputs: adaptedInput,
            signature: handleSignature(options.signature),
            wallet: options.wallet?.modulePath,
            account: options.wallet?.accountName,
            accountDir: options.wallet?.accountPath,
            networkID: this.networkID,
            chainID: this.chainID,
            gatewayUrl: this.gatewayUrl,
            feederGatewayUrl: this.feederGatewayUrl,
            blockNumber: "blockNumber" in options ? options.blockNumber : undefined,
            maxFee: options.maxFee?.toString() || "0",
            nonce: options.nonce?.toString()
        });

        if (executed.statusCode) {
            const msg =
                `Could not perform ${choice.cliCommand} on ${functionName}:\n` +
                executed.stderr.toString();
            const replacedMsg = adaptLog(msg);
            throw new HardhatPluginError(PLUGIN_NAME, replacedMsg);
        }

        return executed;
    }

    /**
     * Invoke the function by name and optionally provide arguments in an array.
     * For a usage example @see {@link call}
     * @param functionName
     * @param args arguments to Starknet contract function
     * @options optional additions to invoking
     * @returns a Promise that resolves when the status of the transaction is at least `PENDING`
     */
    async invoke(
        functionName: string,
        args?: StringMap,
        options: InvokeOptions = {}
    ): Promise<InvokeResponse> {
        const executed = await this.interact(InteractChoice.INVOKE, functionName, args, options);
        const txHash = extractTxHash(executed.stdout.toString());

        return new Promise<string>((resolve, reject) => {
            iterativelyCheckStatus(
                txHash,
                this.starknetWrapper,
                this.gatewayUrl,
                this.feederGatewayUrl,
                () => resolve(txHash),
                (error) => {
                    console.error(`Invoke transaction ${txHash} is REJECTED.\n` + error.message);
                    reject(error);
                }
            );
        });
    }

    /**
     * Call the function by name and optionally provide arguments in an array.
     *
     * E.g. If your contract has a function
     * ```text
     * func double_sum(x: felt, y: felt) -> (res: felt):
     *     return (res=(x + y) * 2)
     * end
     * ```
     * then you would call it like:
     * ```typescript
     * const contract = ...;
     * const { res: sum } = await contract.call("double_sum", { x: 2, y: 3 });
     * console.log(sum);
     * ```
     * which would result in:
     * ```text
     * > 10n
     * ```
     *
     * If options.rawOutput, the Promised object holds a property `response` with an array of strings.
     *
     * @param functionName
     * @param args arguments to Starknet contract function
     * @param options optional additions to calling
     * @returns a Promise that resolves when the status of the transaction is at least `PENDING`
     */
    async call(
        functionName: string,
        args?: StringMap,
        options: CallOptions = {}
    ): Promise<StringMap> {
        const adaptedOptions = defaultToPendingBlock(options);
        const executed = await this.interact(InteractChoice.CALL, functionName, args, adaptedOptions);
        if (options.rawOutput) {
            return { response: executed.stdout.toString().split(" ") };
        }
        return this.adaptOutput(functionName, executed.stdout.toString());
    }

    /**
     * Estimate the gas fee of executing `functionName` with `args`.
     * @param functionName
     * @param args arguments to Starknet contract function
     * @param options optional execution specifications
     * @returns an object containing the amount and the unit of the estimation
     */
    async estimateFee(
        functionName: string,
        args?: StringMap,
        options: EstimateFeeOptions = {}
    ): Promise<FeeEstimation> {
        const adaptedOptions = defaultToPendingBlock(options);
        const executed = await this.interact(
            InteractChoice.ESTIMATE_FEE,
            functionName,
            args,
            adaptedOptions
        );
        return parseFeeEstimation(executed.stdout.toString());
    }

    /**
     * Returns the ABI of the whole contract.
     * @returns contract ABI
     */
    getAbi(): starknet.Abi {
        return this.abi;
    }

    /**
     * Adapt structured `args` to unstructured array expected by e.g. Starknet CLI.
     * @param functionName the name of the function to adapt
     * @param args structured args
     * @returns unstructured args
     */
    adaptInput(functionName: string, args?: StringMap): string[] {
        const func = <starknet.CairoFunction>this.abi[functionName];
        if (!func) {
            const msg = `Function '${functionName}' doesn't exist on ${this.abiPath}.`;
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }

        if (Array.isArray(args)) {
            throw new HardhatPluginError(
                PLUGIN_NAME,
                "Arguments should be passed in the form of an object."
            );
        }

        return adaptInputUtil(functionName, args, func.inputs, this.abi);
    }

    /**
     * Adapt unstructured `rawResult` to a structured object.
     * @param functionName the name of the function that produced the output
     * @param rawResult the function output as as unparsed space separated string
     * @returns structured output
     */
    adaptOutput(functionName: string, rawResult: string) {
        const func = <starknet.CairoFunction>this.abi[functionName];
        return adaptOutputUtil(rawResult, func.outputs, this.abi);
    }
}
