import axios from "axios";
import { HardhatPluginError } from "hardhat/plugins";
import { Devnet, HardhatRuntimeEnvironment } from "hardhat/types";

import { PLUGIN_NAME } from "./constants";
import { L2ToL1Message } from "./starknet-types";
import { sleep } from "./devnet/integrated-devnet";
import fs from "fs";
import fspath from 'path';

interface L1ToL2Message {
    address: string;
    args: {
        from_address: string;
        nonce: number;
        payload: Array<number>;
        selector: string;
        to_address: string;
    };
    block_hash: string;
    block_number: number;
    event: string;
    log_index: number;
    transaction_hash: string;
    transaction_index: number;
}

export interface FlushResponse {
    l1_provider: string;
    consumed_messages: {
        from_l1: Array<L1ToL2Message>;
        from_l2: Array<L2ToL1Message>;
    };
}

export interface LoadL1MessagingContractResponse {
    address: string;
    l1_provider: string;
}

export interface SetTimeResponse {
    next_block_timestamp: number;
}

export interface IncreaseTimeResponse {
    timestamp_increased_by: number;
}

export interface PredeployedAccount {
    initial_balance: number;
    private_key: string;
    public_key: string;
    address: string;
}

export class DevnetUtils implements Devnet {
    constructor(private hre: HardhatRuntimeEnvironment) {}

    private get endpoint() {
        return `${this.hre.config.starknet.networkUrl}`;
    }

    private async withErrorHandler<T>(asyncFn: () => Promise<T>, errorMessage: string) {
        try {
            return await asyncFn();
        } catch (error) {
            const parent = error instanceof Error && error;

            throw new HardhatPluginError(PLUGIN_NAME, errorMessage, parent);
        }
    }

    public async restart() {
        return this.withErrorHandler<void>(async () => {
            await axios.post(`${this.endpoint}/restart`);
        }, "Failed to restart the devnet!");
    }

    public async flush() {
        return this.withErrorHandler<FlushResponse>(async () => {
            const response = await axios.post<FlushResponse>(`${this.endpoint}/postman/flush`);
            return response.data;
        }, "Request failed. Make sure your network has the /postman endpoint");
    }

    public async loadL1MessagingContract(networkUrl: string, address?: string, networkId?: string) {
        return this.withErrorHandler<LoadL1MessagingContractResponse>(async () => {
            const response = await axios.post<LoadL1MessagingContractResponse>(
                `${this.endpoint}/postman/load_l1_messaging_contract`,
                {
                    networkId,
                    address,
                    networkUrl
                }
            );

            return response.data;
        }, "Request failed. Make sure your network has the /postman endpoint");
    }

    public async increaseTime(seconds: number) {
        return this.withErrorHandler<IncreaseTimeResponse>(async () => {
            const response = await axios.post<IncreaseTimeResponse>(
                `${this.endpoint}/increase_time`,
                {
                    time: seconds
                }
            );
            return response.data;
        }, "Request failed. Make sure your network has the /increase_time endpoint");
    }

    public async setTime(seconds: number) {
        return this.withErrorHandler<SetTimeResponse>(async () => {
            const response = await axios.post<SetTimeResponse>(`${this.endpoint}/set_time`, {
                time: seconds
            });
            return response.data;
        }, "Request failed. Make sure your network has the /set_time endpoint");
    }

    public async getPredeployedAccounts() {
        return this.withErrorHandler<PredeployedAccount[]>(async () => {
            const response = await axios.get<PredeployedAccount[]>(
                `${this.endpoint}/predeployed_accounts`
            );
            return response.data;
        }, "Request failed. Make sure your network has the /predeployed_accounts endpoint");
    }

    public async dump(path: string) {
        return this.withErrorHandler<void>(async () => {
            // make sure the destination directory exists
            fs.mkdirSync(fspath.dirname(path), { recursive: true });

            // make sure the destination file is always deleted
            if (fs.existsSync(path)) {
                fs.unlinkSync(path);
            }

            // the server will reply immediately and dumping is done in a background thread
            await axios.post(`${this.endpoint}/dump`,
                { path },
                { timeout: 20000 } // timeout is required because the server can die
            );
            await this.waitUntilSaveFinished(path);
        }, "Request failed. Make sure your network has the /dump endpoint");
    }

    async waitUntilSaveFinished(path:string): Promise<void> {
        const maxWaitMillis = 20_000;
        const startTime = new Date().getTime();

        async function waitWithTimeout(waitMillis:number): Promise<void> {
            if ((new Date().getTime() - startTime) > maxWaitMillis) {
                throw new HardhatPluginError(PLUGIN_NAME, "devnet.dump() timed out");
            }
            await sleep(waitMillis);
        }

        // wait until file actually exists
        while (!fs.existsSync(path) || fs.statSync(path).size === 0) {
            await waitWithTimeout(50);
        }

        // and wait until file size finishes changing
        let size = 0, lastSize = 0;
        while ((size = fs.statSync(path).size) !== lastSize) {
            lastSize = size;
            await waitWithTimeout(50);
        }
    }

    /**
     * Loads devnet state from disk
     */
    public async load(path: string) {
        return this.withErrorHandler<void>(async () => {
            if (!fs.existsSync(path)) {
                throw new HardhatPluginError(PLUGIN_NAME, `load path does not exist: ${path}`);
            }
            // the load request will respond with success when state has finished loading
            // so this request can take 1-5 seconds variably
            await axios.post(`${this.endpoint}/load`,
                { path },
                { timeout: 20000 } // timeout is required because the server can die
            );
        }, "Request failed. Make sure your network has the /load endpoint");
    }
}
