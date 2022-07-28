import { ChildProcess, spawn } from "child_process";

import { getPrefixedCommand, normalizeVenvPath } from "../utils/venv";
import { IntegratedDevnet } from "./integrated-devnet";

export class VenvDevnet extends IntegratedDevnet {
    private command: string;
    private args?: string[];

    constructor(venvPath: string, host: string, port: string, args?: string[], stdout?: string, stderr?: string) {
        super(host, port, stdout, stderr);

        this.command = "starknet-devnet";
        this.args = args;

        if (venvPath !== "active") {
            this.command = getPrefixedCommand(normalizeVenvPath(venvPath), this.command);
        }
    }

    protected async spawnChildProcess(): Promise<ChildProcess> {
        const args = ["--host", this.host, "--port", this.port].concat(this.args || []);
        return spawn(this.command, args);
    }

    protected cleanup(): void {
        this.childProcess?.kill();
    }
}
