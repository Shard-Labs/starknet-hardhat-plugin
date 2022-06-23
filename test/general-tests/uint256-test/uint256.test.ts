import { expect } from "chai";
import { starknet } from "hardhat";

describe("Starknet", function () {
    this.timeout(300_000);

    it("should convert small bigint to uint256", function() {
        const uint256 = starknet.bigIntToUint256(BigInt(1));
        expect(uint256).to.deep.equal({
            low: BigInt(1),
            high: BigInt(0)
        });
    });

    it("should convert big bigint to uint256", function() {
        const uint256 = starknet.bigIntToUint256(BigInt("340282366920938463463374607431768211457"));
        expect(uint256).to.deep.equal({
            low: BigInt(1),
            high: BigInt(1)
        });
    });

    it("should convert small uint256 to bigint", function() {
        const bigInt = starknet.uint256toBigInt({
            low: BigInt(1),
            high: BigInt(0)
        });
        expect(bigInt).to.deep.equal(BigInt(1));
    });

    it("should convert big uint256 to bigint", function() {
        const bigInt = starknet.uint256toBigInt({
            low: BigInt(1),
            high: BigInt(1)
        });
        expect(bigInt).to.deep.equal(BigInt("340282366920938463463374607431768211457"));
    });
});
