import * as path from "path";
import * as fs from "fs";

export abstract class IntegratedDevnetLogger {

    // Promisify fs
    private fsPromises = fs.promises;

    constructor(protected stdout?: string, protected stderr?: string) { }

    protected async logStdout(message: string): Promise<void> {
        // STDOUT
        if (this.stdout && this.stdout === "STDOUT") {
            console.log(message);
        }

        // Check if stdout is a path to a file and is basename is not empty
        if (this.stdout && path.basename(this.stdout) !== "") {
            // Create the file if it doesn't exist
            const file = path.resolve(this.stdout);
            this.appendLogToFile(file, message);
        }
    }

    protected async logStderr(message: string): Promise<void> {
        // STDERR
        if (this.stderr && this.stderr === "STDERR") {
            console.error(message);
        }

        // Check if stderr is a path to a file and basename is not empty
        if (this.stderr && path.basename(this.stderr) !== "") {
            // Create the file if it doesn't exist
            const file = path.resolve(this.stderr);
            await this.appendLogToFile(file, message);
        }
    }

    // Appends the message to the file
    private async appendLogToFile(file: string, message: string): Promise<void> {
        // Create the file if it doesn't exist
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) {
            await this.fsPromises.mkdir(dir, { recursive: true });
        }

        if (!fs.existsSync(file)) {
            await this.fsPromises.writeFile(file, "");
        }

        // Append the message to the file
        await this.fsPromises.appendFile(file, message);
    }
}
