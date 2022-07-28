import axios from "axios";
import net from "net";
import { ChildProcess } from "child_process";
import { HardhatPluginError } from "hardhat/plugins";
import { PLUGIN_NAME } from "../constants";

function sleep(amountMillis: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, amountMillis);
    });
}

export function isFreePort(port: number): Promise<boolean> {
    return new Promise((accept, reject) => {
        const sock = net.createConnection(port);
        sock.once("connect", () => {
            sock.end();
            accept(false);
        });
        sock.once("error", (e: NodeJS.ErrnoException) => {
            sock.destroy();
            if (e.code === "ECONNREFUSED") {
                accept(true);
            } else {
                reject(e);
            }
        });
    });
}

export async function getFreePort(): Promise<string> {
    const defaultDevnetPort = 5050; // starting here to avoid conflicts
    const step = 1000;
    const maxPort = 65535;
    for (let port = defaultDevnetPort + step; port <= maxPort; port += step) {
        if (await isFreePort(port)) {
            return port.toString();
        }
    }

    throw new HardhatPluginError(
        PLUGIN_NAME,
        "Could not find a free port, try rerunning your command!"
    );
}

export abstract class ExternalServer {
    protected childProcess: ChildProcess;
    private lastError: string = null;
    private connected = false;

    constructor(
        protected host: string,
        protected port: string | null,
        private isAliveURL: string,
        private processName: string
    ) {
        ExternalServer.cleanupFns.push(this.cleanup.bind(this));
    }

    public get url() {
        return `http://${this.host}:${this.port}`;
    }

    protected static cleanupFns: Array<() => void> = [];

    public static cleanAll(): void {
        this.cleanupFns.forEach((fn) => fn());
    }

    protected abstract spawnChildProcess(): Promise<ChildProcess>;

    protected abstract cleanup(): void;

    public async start(): Promise<void> {
        if (await this.isServerAlive()) {
            const msg = `Cannot spawn ${this.processName}: ${this.host}:${this.port} already occupied.`;
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
                        const msg = `${this.processName} connection timed out!`;
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
                        const msg = `${this.processName} spawned and connected successfully, but later exited with code=${code}`;
                        throw new HardhatPluginError(PLUGIN_NAME, msg);
                    } else {
                        const msg = `${this.processName} connect exited with code=${code}:\n${this.lastError}`;
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
            await axios.get(`${this.url}/${this.isAliveURL}`);
            return true;
        } catch (err: unknown) {
            // cannot connect, so address is not occupied
            return false;
        }
    }
}
