import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { HardhatRuntimeEnvironment, ProjectPathsConfig, TaskArguments } from "hardhat/types";
import { starknetCompileAction } from "./task-actions";
import { getArtifactPath, traverseFiles } from "./utils";
import { ABI_SUFFIX } from "./constants";

interface ContractData {
    contentHash: string;
    outputPath: string;
    abiPath: string;
    cairoPath?: string;
    accountContract?: boolean;
    disableHintValidation?: boolean;
}

// Cache file name
const CACHE_FILE_NAME = "cairo-files-cache.json";

export class Cache {
    protected cache: Record<string, ContractData> = {};
    public fsPromises = fs.promises;

    constructor(protected hre: HardhatRuntimeEnvironment) { }

    // Returns the contract data from the cache
    public async getCache(): Promise<Record<string, ContractData>> {
        await this.loadCache();
        return this.cache;
    }

    // Sets the cache
    public setCache(cacheData: Record<string, ContractData>): void {
        this.cache = cacheData;
    }

    // Returns the cache file path
    private getCacheFilePath(): string {
        return path.join(this.hre.config.paths.cache, CACHE_FILE_NAME);
    }

    // Returns the cache directory path
    private getCacheDirPath(): string {
        return path.join(this.hre.config.paths.cache);
    }

    // Loads the cache from the file
    public async loadCache(): Promise<void> {
        const cacheDirpath = this.getCacheDirPath();
        // Creates cache directory if it doesn't exist
        if (!fs.existsSync(cacheDirpath)) {
            fs.mkdirSync(cacheDirpath, { recursive: true });
        }

        const cacheFilePath = this.getCacheFilePath();
        if (fs.existsSync(cacheFilePath)) {
            const cacheBuffer = await this.fsPromises.readFile(cacheFilePath);
            this.setCache(JSON.parse(cacheBuffer.toString() || "{}"));
        } else {
            await fs.promises.writeFile(cacheFilePath, JSON.stringify({}) + "\n");
            this.setCache({});
        }
    }

    // Saves the cache to the file
    public async saveCache(): Promise<void> {
        const cacheFilePath = this.getCacheFilePath();
        await this.fsPromises.writeFile(cacheFilePath, JSON.stringify(this.cache, null, " ") + "\n");
    }
}

export class Recompiler {
    private cache: Cache;
    private hre: HardhatRuntimeEnvironment;

    constructor(hre: HardhatRuntimeEnvironment) {
        this.cache = new Cache(hre);
        this.hre = hre;
    }

    // Gets hash of each .cairo file inside source
    private async getContractHash(paths: ProjectPathsConfig): Promise<Record<string, ContractData>> {
        const { starknetSources: defaultSourcesPath } = paths;

        const sourceRegex = new RegExp("^" + defaultSourcesPath + "/");
        const artifactsDir = getArtifactPath(defaultSourcesPath, paths);

        const newCacheEntry: Record<string, ContractData> = {};
        // Get soucrces from source path. Check only cairo file extensions
        const filesList = await traverseFiles(defaultSourcesPath, "*.cairo");
        // Select file name
        for (const cairoContract of filesList) {
            const data = await this.cache.fsPromises.readFile(cairoContract);
            const hash = createHash("sha256");
            hash.update(data);
            const suffix = cairoContract.replace(sourceRegex, "");

            const fileName = path.basename(suffix, ".cairo");
            const abiPath = path.join(artifactsDir, suffix, `${fileName}${ABI_SUFFIX}`);
            const outputPath = path.join(artifactsDir, suffix, `${fileName}.json`);

            newCacheEntry[cairoContract] = {
                contentHash: hash.digest("hex").toString(),
                outputPath,
                abiPath
            };
        }

        return newCacheEntry;
    }

    // Gets cache entry of a given cairo file plus artifacts
    private async getCacheEntry(
        file: string,
        output: string,
        abi: string,
        cairoPath?: string,
        args?: TaskArguments
    ): Promise<Record<string, ContractData>> {
        const data = await this.cache.fsPromises.readFile(file);
        const hash = createHash("sha256");
        hash.update(data);

        const newCacheEntry: Record<string, ContractData> = {};
        newCacheEntry[file] = {
            contentHash: hash.digest("hex").toString(),
            outputPath: output,
            abiPath: abi
        };

        if (args?.disableHintValidation) {
            newCacheEntry[file].disableHintValidation = true;
        }

        if (args?.accountContract) {
            newCacheEntry[file].accountContract = true;
        }

        if (cairoPath) {
            newCacheEntry[file].cairoPath = args.cairoPath;
        }

        return newCacheEntry;
    }

    // Updates cache entry with new contracts
    private getUpdatedCache(
        oldCache: Record<string, ContractData>,
        newCacheEntry: Record<string, ContractData>
    ): Record<string, ContractData> {
        const updatedCacheEntry: Record<string, ContractData> = oldCache;
        for (const contractName in newCacheEntry) {
            if (oldCache[contractName]?.contentHash !== newCacheEntry[contractName].contentHash) {
                updatedCacheEntry[contractName] = newCacheEntry[contractName];
            }
        }

        return updatedCacheEntry;
    }

    // Checks artifacts availability
    private async checkArtifacts(
        paths: ProjectPathsConfig,
        newCacheEntry: Record<string, ContractData>
    ): Promise<Set<string>> {
        // Set to save contracts with changed content & unavailable artifacts
        const changed: Set<string> = new Set();
        const { starknetSources: defaultSourcesPath } = paths;
        const artifactsDir = getArtifactPath(defaultSourcesPath, paths);
        // Traverse on artifacts directory
        // Create if it doesn't exist
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        const artifactsList = await traverseFiles(artifactsDir, "*.json");
        for (const name in newCacheEntry) {
            const outputPath = newCacheEntry[name].outputPath;
            const abiPath = newCacheEntry[name].abiPath;
            if (!artifactsList.includes(outputPath) || !artifactsList.includes(abiPath)) {
                changed.add(name);
            }
        }

        return changed;
    }

    // Compile changed contracts
    private async compileChangedContracts(
        newCacheEntry: Record<string, ContractData>,
        changed: Set<string>
    ): Promise<void> {
        for (const changedContract of changed) {
            const entry = newCacheEntry[changedContract];
            const compileArguments: TaskArguments = {
                paths: [changedContract],
                disableHintValidation: entry?.disableHintValidation,
                accountContract: entry?.accountContract,
                carioPath: entry?.cairoPath
            };

            await starknetCompileAction(compileArguments, this.hre);
        }
    }

    // Updated set with changed and new contracts
    private async updateSet(
        cache: Record<string, ContractData>,
        newCacheEntry: Record<string, ContractData>,
        changed: Set<string>
    ): Promise<Set<string>> {
        for (const contractName in newCacheEntry) {
            // Add new contracts that are not in cache before
            if (!cache[contractName]) {
                changed.add(contractName);
                continue;
            }

            // Add contracts that contiain a change in content
            if (newCacheEntry[contractName].contentHash !== cache[contractName].contentHash) {
                changed.add(contractName);
            }
        }

        // Remove deleted sources from old cache by overwriting it
        this.cache.setCache(newCacheEntry);
        await this.cache.saveCache();

        return changed;
    }

    // Handles cache on Starknet cli calls
    public async handleCache(): Promise<void> {
        // If recompile is not enabled, do nothing
        if (!this.hre.userConfig?.starknet?.recompile) return;

        const paths = this.hre.config.paths;
        try {
            const oldCache = await this.cache.getCache();
            const newCacheEntry = await this.getContractHash(paths);
            const changedContracts = await this.checkArtifacts(paths, newCacheEntry);
            const updatedSet = await this.updateSet(oldCache, newCacheEntry, changedContracts);
            await this.compileChangedContracts(newCacheEntry, updatedSet);
        } catch (error) {
            // If there is an error, do not recompile
            console.error(error);
            process.exit(1);
        }
    }

    // Updates cache with new contract and artifacts
    public async updateCache(
        args: TaskArguments,
        file: string,
        output: string,
        abi: string,
        cairoPath?: string
    ): Promise<void> {
        const oldCache = await this.cache.getCache();
        const newCacheEntry = await this.getCacheEntry(file, output, abi, cairoPath, args);
        const updatedCache = this.getUpdatedCache(oldCache, newCacheEntry);
        this.cache.setCache(updatedCache);
    }

    // Calls save cache after compilation
    public async saveCache(): Promise<void> {
        await this.cache.saveCache();
    }
}
