import "../dist/src/index.js";

module.exports = {
    solidity: "0.6.12",
    starknet: {
        network: process.env.NETWORK,
        recompile: true
    },
    networks: {
        devnet: {
            url: "http://127.0.0.1:5050"
        }
    }
};
