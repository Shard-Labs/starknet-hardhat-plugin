import { HardhatDocker, Image } from "@nomiclabs/hardhat-docker";
import { ChildProcess, spawn, spawnSync } from "child_process";

import { IntegratedDevnet } from "./integrated-devnet";

const CONTAINER_NAME = "integrated-devnet";
const DEVNET_DOCKER_INTERNAL_PORT = 5050;

export class DockerDevnet extends IntegratedDevnet {
    private docker: HardhatDocker;
    private args?: string[];

    constructor(private image: Image, host: string, port: string, args?: string[], stdout?: string, stderr?: string) {
        super(host, port, stdout, stderr);
        this.args = args;
    }

    private async pullImage() {
        if (!this.docker) {
            this.docker = await HardhatDocker.create();
        }

        if (!(await this.docker.hasPulledImage(this.image))) {
            console.log(`Pulling image ${HardhatDocker.imageToRepoTag(this.image)}`);
            await this.docker.pullImage(this.image);
        }
    }

    protected async spawnChildProcess(): Promise<ChildProcess> {
        await this.pullImage();

        const formattedImage = `${this.image.repository}:${this.image.tag}`;
        console.log(`Starting the "${CONTAINER_NAME}" Docker container (${formattedImage})`);
        const args = [
            "run",
            "--rm",
            "--name",
            CONTAINER_NAME,
            "-p",
            `${this.host}:${this.port}:${DEVNET_DOCKER_INTERNAL_PORT}`,
            formattedImage
        ].concat(this.args || []);
        return spawn("docker", args);
    }

    protected cleanup(): void {
        console.log(`Killing ${CONTAINER_NAME} Docker container`);
        spawnSync("docker", ["kill", CONTAINER_NAME]);
        this.childProcess?.kill();
    }
}
