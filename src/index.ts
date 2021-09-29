import * as path from "path";
import * as fs from "fs";
import { task, extendEnvironment, extendConfig } from "hardhat/config";
import { HardhatPluginError } from "hardhat/plugins";
import { ProcessResult } from "@nomiclabs/hardhat-docker";
import "./type-extensions";
import { DockerWrapper, StarknetContract } from "./types";
import { PLUGIN_NAME, ABI_SUFFIX, DEFAULT_STARKNET_SOURCES_PATH, DEFAULT_STARKNET_ARTIFACTS_PATH, DEFAULT_DOCKER_IMAGE_TAG, DOCKER_REPOSITORY,  } from "./constants";
import { HardhatConfig, HardhatUserConfig } from "hardhat/types";

async function traverseFiles(
    traversable: string,
    predicate: (path: string) => boolean,
    action: (path: string) => Promise<number>
): Promise<number> {
    let statusCode = 0;

    const stats = fs.lstatSync(traversable);
    if (stats.isDirectory()) {
        for (const childName of fs.readdirSync(traversable)) {
            const childPath = path.join(traversable, childName);
            statusCode += await traverseFiles(childPath, predicate, action);
        }
    } else if (stats.isFile()) {
        if (predicate(traversable)) {
            statusCode += await action(traversable);
        }
    } else {
        const msg = `Can only interpret files and directories. ${traversable} is neither.`;
        console.warn(msg);
    }

    return statusCode;
}

/**
 * Transfers logs and generates a return status code.
 * 
 * @param executed The process result of running the container
 * @returns 0 if succeeded, 1 otherwise
 */
function processExecuted(executed: ProcessResult): number {
    if (executed.stdout.length) {
        console.log(executed.stdout.toString());
    }

    if (executed.stderr.length) {
        // synchronize param names reported by actual CLI with param names used by this plugin
        const err = executed.stderr.toString()
            .replace("--network", "--starknet-network")
            .replace("--gateway_url", "--gateway-url")
        console.error(err);
    }

    const finalMsg = executed.statusCode ? "Failed" : "Succeeded";
    console.log(`\t${finalMsg}\n`);
    return executed.statusCode ? 1 : 0;
}

function hasCairoExtension(filePath: string) {
    return path.extname(filePath) === ".cairo";
}

function isStarknetContract(filePath: string) {
    return hasCairoExtension(filePath);
}

function isStarknetCompilationArtifact(filePath: string) {
    const content = fs.readFileSync(filePath).toString();
    let parsed = null;
    try {
        parsed = JSON.parse(content);
    } catch(err) {
        return false;
    }

    return !!parsed.entry_points_by_type;
}

function getFileName(filePath: string) {
    return path.basename(filePath, path.extname(filePath));
}

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

// add image version
extendConfig((config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    config.cairo = userConfig.cairo;
    if (!config.cairo) {
        config.cairo = {
            version: DEFAULT_DOCKER_IMAGE_TAG
        };
    }

    if (!config.cairo.version) {
        config.cairo.version = DEFAULT_DOCKER_IMAGE_TAG;
    }
});

extendEnvironment(hre => {
    const repository = DOCKER_REPOSITORY;
    const tag = hre.config.cairo.version;
    hre.dockerWrapper = new DockerWrapper({ repository, tag });
});

task("starknet-compile", "Compiles StarkNet contracts")
    .setAction(async (_args, hre) => {
        const sourcesPath = hre.config.paths.starknetSources;
        const artifactsPath = hre.config.paths.starknetArtifacts;
        const docker = await hre.dockerWrapper.getDocker();

        const root = hre.config.paths.root;
        const rootRegex = new RegExp("^" + root);

        const statusCode = await traverseFiles(sourcesPath, isStarknetContract, async (file: string): Promise<number> => {
            console.log("Compiling", file);
            const suffix = file.replace(rootRegex, "");
            const fileName = getFileName(suffix);
            const dirPath = path.join(artifactsPath, suffix);

            const outputPath = path.join(dirPath, `${fileName}.json`);
            const abiPath = path.join(dirPath, `${fileName}${ABI_SUFFIX}`)
            const compileArgs = [file, "--output", outputPath, "--abi", abiPath];

            fs.mkdirSync(dirPath, { recursive: true });
            const executed = await docker.runContainer(
                hre.dockerWrapper.image,
                ["starknet-compile"].concat(compileArgs),
                {
                    binds: {
                        [sourcesPath]: sourcesPath,
                        [artifactsPath]: artifactsPath
                    }
                }
            );

            return processExecuted(executed);
        });

        if (statusCode) {
            const msg = `Failed compilation of ${statusCode} contract${statusCode === 1 ? "" : "s"}.`;
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }
    });

task("starknet-deploy", "Deploys Starknet contracts")
    .addOptionalParam("starknetNetwork", "The network version to be used (e.g. alpha)")
    .addOptionalParam("gatewayUrl", "The URL of the gateway to be used (e.g. https://alpha2.starknet.io:443)")
    .setAction(async (args, hre) => {
        const artifactsPath = hre.config.paths.starknetArtifacts;
        const docker = await hre.dockerWrapper.getDocker();

        const providedStarknetNetwork = args.starknetNetwork || process.env.STARKNET_NETWORK;
        const optionalStarknetArgs: string[] = [];

        if (providedStarknetNetwork) {
            optionalStarknetArgs.push(`--network=${providedStarknetNetwork}`);
        }

        if (args.gatewayUrl) {
            optionalStarknetArgs.push(`--gateway_url=${args.gatewayUrl}`);
        }

        const statusCode = await traverseFiles(artifactsPath, isStarknetCompilationArtifact, async file => {
            console.log("Deploying", file);
            const starknetArgs = ["deploy", "--contract", file].concat(optionalStarknetArgs);

            const executed = await docker.runContainer(
                hre.dockerWrapper.image,
                ["starknet"].concat(starknetArgs),
                {
                    binds: {
                        [artifactsPath]: artifactsPath
                    }
                }
            );

            return processExecuted(executed);
        });

        if (statusCode) {
            throw new HardhatPluginError(PLUGIN_NAME, `Failed deployment of ${statusCode} contracts`);
        }
    });

extendEnvironment(hre => {
    hre.getStarknetContract = async contractName => {
        let metadataPath: string;
        await traverseFiles(
            hre.config.paths.starknetArtifacts,
            file => path.basename(file) === `${contractName}.json`,
            async file => {
                metadataPath = file;
                return 0;
            }
        );
        if (!metadataPath) {
            throw new HardhatPluginError(PLUGIN_NAME, `Could not find metadata for ${contractName}`);
        }

        let abiPath: string;
        await traverseFiles(
            hre.config.paths.starknetArtifacts,
            file => path.basename(file) === `${contractName}${ABI_SUFFIX}`,
            async file => {
                abiPath = file;
                return 0;
            }
        )
        if (!abiPath) {
            throw new HardhatPluginError(PLUGIN_NAME, `Could not find ABI for ${contractName}`);
        }

        return new StarknetContract(hre.dockerWrapper, metadataPath, abiPath);
    }
});
