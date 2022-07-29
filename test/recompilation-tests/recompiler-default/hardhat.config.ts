import "../dist/src/index.js";

module.exports = {
    starknet: {
        network: process.env.NETWORK
    },
    networks: {
        devnet: {
            url: "http://127.0.0.1:5050"
        }
    }
};
