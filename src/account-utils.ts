import { Numeric } from "./types";
import { hash } from "starknet";
import { BigNumberish, toBN } from "starknet/utils/number";
import * as ellipticCurve from "starknet/utils/ellipticCurve";
import { ec } from "elliptic";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import path from "path";
import {
    ABI_SUFFIX,
    ACCOUNT_ARTIFACTS_VERSION,
    ACCOUNT_CONTRACT_ARTIFACTS_ROOT_PATH,
    GITHUB_ACCOUNT_ARTIFACTS_URL
} from "./constants";
import axios from "axios";

/*
 * Helper cryptography functions for Key generation and message signing
 */

export function generateRandomStarkPrivateKey(length = 63) {
    const characters = "0123456789ABCDEF";
    let result = "";
    for (let i = 0; i < length; ++i) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return toBN(result, "hex");
}

/**
 * Returns a signature which is the result of signing a message
 *
 * @param keyPair
 * @param accountAddress
 * @param nonce
 * @param functionSelector
 * @param toAddress
 * @param calldata
 * @returns the signature
 */
export function sign(
    keyPair: ec.KeyPair,
    accountAddress: string,
    nonce: BigNumberish,
    functionSelector: string,
    toAddress: string,
    calldata: BigNumberish[]
): Numeric[] {
    const msgHash = hash.computeHashOnElements([
        toBN(accountAddress.substring(2), "hex"),
        toBN(toAddress.substring(2), "hex"),
        functionSelector,
        toBN(hash.computeHashOnElements(calldata).substring(2), "hex"),
        nonce
    ]);

    const signedMessage = ellipticCurve.sign(keyPair, BigInt(msgHash).toString(16));
    const signature = [
        BigInt("0x" + signedMessage[0].toString(16)),
        BigInt("0x" + signedMessage[1].toString(16))
    ];
    return signature;
}

export async function handleAccountContractArtifacts(
    accountType: string,
    artifactsName: string,
    hre: HardhatRuntimeEnvironment
): Promise<string> {
    // Name of the artifacts' parent folder
    const artifactsBase = artifactsName + ".cairo";

    const baseArtifactsPath = path.join(
        hre.config.paths.starknetArtifacts,
        ACCOUNT_CONTRACT_ARTIFACTS_ROOT_PATH
    );

    // Remove old versions from the path
    if (fs.existsSync(baseArtifactsPath)) {
        const contents = fs.readdirSync(baseArtifactsPath);
        contents
            .filter((content) => content !== ACCOUNT_ARTIFACTS_VERSION)
            .forEach((content) => {
                fs.rmSync(path.join(baseArtifactsPath, content), {
                    recursive: true,
                    force: true
                });
            });
    }

    // Full path to where the artifacts will be saved
    const artifactsTargetPath = path.join(
        baseArtifactsPath,
        ACCOUNT_ARTIFACTS_VERSION,
        artifactsBase
    );

    const jsonArtifact = artifactsName + ".json";
    const abiArtifact = artifactsName + ABI_SUFFIX;

    const fileLocationUrl = GITHUB_ACCOUNT_ARTIFACTS_URL.concat(
        accountType,
        "/",
        artifactsBase,
        "/"
    );

    await assertArtifact(jsonArtifact, artifactsTargetPath, fileLocationUrl);
    await assertArtifact(abiArtifact, artifactsTargetPath, fileLocationUrl);

    return artifactsTargetPath;
}

async function assertArtifact(
    artifact: string,
    artifactsTargetPath: string,
    fileLocationUrl: string
) {
    if (!fs.existsSync(path.join(artifactsTargetPath, artifact))) {
        // Check if an old version of the artifacts still exists in the path, if so delete it
        fs.mkdirSync(artifactsTargetPath, { recursive: true });

        const rawFileURL = fileLocationUrl.concat(artifact);

        const response = await axios.get(rawFileURL, {
            transformResponse: (res) => {
                return res;
            },
            responseType: "json"
        });

        fs.writeFileSync(path.join(artifactsTargetPath, artifact), response.data);
    }
}
