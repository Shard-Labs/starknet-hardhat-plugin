## Set up development environment

### Clone the repository

```
git clone git@github.com:Shard-Labs/starknet-hardhat-plugin.git
cd starknet-hardhat-plugin
```

### Install dependencies

```
npm ci
```

### Compile

```
npm run build
```

### Set up the example repository

The `starknet-hardhat-example` repository to showcase and test this plugin's functionality.
Set it up following [its readme](https://github.com/Shard-Labs/starknet-hardhat-example#get-started), but after installing it, make it use your local plugin repository:

```
cd <YOUR_PLUGIN_REPO_PATH>
npm link

cd <YOUR_EXAMPLE_REPO_PATH>
npm link @shardlabs/starknet-hardhat-plugin
```

If your IDE is reporting Typescript issues after compiling the plugin, you may want to restart the Typescript language server (e.g. in VS Code on Linux: Ctrl+Shift+P)

## Testing

A test case is added by adding a directory in a subdirectory of a test group in the `test` directory. E.g. `declare-test` is a test case in the `general-tests` test group. The test case should contain:

-   a `check.sh` script which does the testing logic
-   a `network.json` file which specifies on which networks should the test case be run
-   a `hardhat.config.ts` file will be used

The main testing script is `scripts/test.sh`. It iterates over the test cases the test group specified by the `TEST_SUBDIR` environment variable.

### Executing tests locally

When running tests locally, you probably don't want to run the whole `test.sh` script as it may alter your development environment. However, you can run individual tests by:

-   positioning yourself in your example repository
-   configuring the `hardhat.config.ts`
-   executing the `check.sh` script (potentially modifying it to address path differences)

To run all tests, you can use the `test-` scripts defined in `package.json`. For the tests to work, you may need to set the values from `config.json` as environment variables. You should also have the [`jq` CLI tool](https://stedolan.github.io/jq/) installed.

### Executing tests on CircleCI

If you're a member of the organization and you do a push to origin, you trigger CI/CD workflow on CircleCI. Track the progress on [the dashboard](https://circleci.com/gh/Shard-Labs/workflows/starknet-hardhat-plugin).

Sometimes the tests fail because of internal CircleCI or Starknet issues; in that case, you can try restarting the workflow.

Bear in mind that each workflow consumes credits. Track the spending [here](https://app.circleci.com/settings/plan/github/Shard-Labs/overview).

The whole workflow is defined in `.circleci/config.yml` - you may find it somewhat chaotic as it uses dependency caching (we kind of sacrificed config clarity for performance).

### Creating a PR

When adding new functionality to the plugin, you will probably also have to create a PR to the `plugin` branch of `starknet-hardhat-example`. You can then modify the `test.sh` script to use your branch instead of the `plugin` branch.

If your reviewer makes an observation that requires a fix, after you push the commit with the fix, find the commit link on the PR conversation page, and reply to the reviewer by providing that link. In [this example](https://github.com/Shard-Labs/starknet-hardhat-plugin/pull/130#discussion_r913581807) the contributor even linked to the specific change of the commit - you don't have to do that if you made multiple smaller commits.

When the PR is ready to be merged, do `Squash and merge` and delete the branch.

## Adapting to a new Starknet / cairo-lang version

When a new Starknet / cairo-lang version is released, a new `cairo-cli` Docker image can be released (probably without any adaptation):
- This is done through the CI/CD pipeline of [the cairo-cli-docker repository](https://github.com/Shard-Labs/cairo-cli-docker).
- A commit updating the README.md of the repository should be sufficient.
- See older commits for reference.

Since the plugin relies on [Devnet](https://github.com/Shard-Labs/starknet-devnet) in its tests, first an adapted version of Devnet needs to be released. Current versions of Devnet and cairo-lang used in tests are specified in `config.json`.

Likely places where the old version has to be replaced with the new version are `README.md` and `constants.ts`.

## Architecture

### Wrapper

This plugin is a wrapper around Starknet CLI (tool installed with cairo-lang). E.g. when you do `hardhat starknet-deploy` in a shell or `contractFactory.deploy()` in a Hardhat JS/TS script, you are making a subprocess that executes Starknet CLI's `starknet deploy`.

There are two wrappers around Starknet CLI. They are defined in [starknet-wrapper.ts](/src/starknet-wrappers.ts):

-   Docker wrapper:
    -   runs Starknet CLI in a Docker container
    -   the default option
-   Venv wrapper:
    -   for users that already have `cairo-lang` installed
    -   faster than Docker wrapper
    -   sends Starknet CLI commands to a [proxy server](/src/starknet_cli_wrapper.py) which has the `main` method of Starknet CLI imported.

## Version management

When a push is done to the `master` branch and the version in `package.json` differs from the one published on `npm`, the release process is triggered. Releases are also tracked on [GitHub](https://github.com/Shard-Labs/starknet-hardhat-plugin/releases) with [git tags](https://github.com/Shard-Labs/starknet-hardhat-plugin/tags).

After releasing a new plugin version, the `plugin` branch of the example repo should be updated:
- `package.json` should be updated by running `npm install --save-exact @shardlabs/starknet-hardhat-plugin@<NEW_VERSION>`
- The `master` branch, which serves as reference to the users, should be synchronized with the `plugin` branch. This can probably be done by doing `git reset plugin` while on `master`.
- Since you did `npm install`, you may need to link again, as described [initially](#set-up-the-example-repository).
