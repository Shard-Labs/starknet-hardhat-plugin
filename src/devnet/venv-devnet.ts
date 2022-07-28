import { ChildProcess, spawn } from "child_process";

import { getPrefixedCommand, normalizeVenvPath } from "../utils/venv";
import { ExternalServer } from "./external-server";

export class VenvDevnet extends ExternalServer {
    private command: string;
    private args?: string[];

    constructor(venvPath: string, host: string, port: string, args?: string[]) {
        super(host, port, "is_alive", "integrated-devnet");

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
