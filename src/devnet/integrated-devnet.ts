import axios from "axios";
import { ChildProcess } from "child_process";
import { HardhatPluginError } from "hardhat/plugins";
import { PLUGIN_NAME } from "../constants";

export function sleep(amountMillis: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, amountMillis);
    });
}

export abstract class IntegratedDevnet {
    protected childProcess: ChildProcess;
    private lastError: string = null;
    private connected = false;

    constructor(protected host: string, protected port: string) {
        IntegratedDevnet.cleanupFns.push(this.cleanup.bind(this));
    }

    protected static cleanupFns: Array<() => void> = [];

    public static cleanAll(): void {
        this.cleanupFns.forEach((fn) => fn());
    }

    protected abstract spawnChildProcess(): Promise<ChildProcess>;

    protected abstract cleanup(): void;

    public async start(): Promise<void> {
        if (await this.isServerAlive()) {
            const msg = `Cannot spawn integrated-devnet: ${this.host}:${this.port} already occupied.`;
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }

        this.childProcess = await this.spawnChildProcess();

        // capture the most recent message from stderr
        this.childProcess.stderr.on("data", (chunk) => {
            this.lastError = chunk.toString();
        });

        return new Promise((resolve, reject) => {
            // called on successful start of the child process
            this.childProcess.on("spawn", async () => {
                const startTime = new Date().getTime();
                const maxWaitMillis = 60_000;
                const oneSleepMillis = 500;

                // keep checking until process has failed/exited
                while (this.childProcess) {
                    const elapsedMillis = new Date().getTime() - startTime;
                    if (elapsedMillis >= maxWaitMillis) {
                        const msg = "integrated-devnet connection timed out!";
                        reject(new HardhatPluginError(PLUGIN_NAME, msg));
                        break;
                    } else if (await this.isServerAlive()) {
                        this.connected = true;
                        resolve();
                        break;
                    } else {
                        await sleep(oneSleepMillis);
                    }
                }
            });

            // this only happens if childProcess completely fails to start
            this.childProcess.on("error", (error) => {
                this.childProcess = null;
                reject(error);
            });

            // handle unexpected close of process
            this.childProcess.on("close", (code) => {
                const isAbnormalExit = this.childProcess != null;
                this.childProcess = null;
                if (code !== 0 && isAbnormalExit) {
                    if (this.connected) {
                        const msg = `integrated-devnet exited with code=${code} while processing transactions`;
                        throw new HardhatPluginError(PLUGIN_NAME, msg);
                    } else {
                        const msg = `integrated-devnet connect exited with code=${code}:\n${this.lastError}`;
                        reject(new HardhatPluginError(PLUGIN_NAME, msg));
                    }
                }
            });
        });
    }

    public stop() {
        if (!this.childProcess) {
            return;
        }

        this.cleanup();
        this.childProcess = null;
    }

    private async isServerAlive() {
        try {
            await axios.get(`http://${this.host}:${this.port}/is_alive`);
            return true;
        } catch (err: unknown) {
            // cannot connect, so address is not occupied
            return false;
        }
    }
}
