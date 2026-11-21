import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadArtifact(contractName) {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

async function main() {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const fi = await provider.getSigner(0);
  const supplier = await provider.getSigner(1);
  const buyer = await provider.getSigner(2);

  console.log("Deploying contracts with FI / Sequencer:", await fi.getAddress());
  console.log("Supplier (Account #1):", await supplier.getAddress());
  console.log("Buyer    (Account #2):", await buyer.getAddress());

  const tokenArtifact = loadArtifact("Token");
  const portalArtifact = loadArtifact("TokenPortal");
  const rollupArtifact = loadArtifact("Rollup");

  // 1. Deploy Token
  const TokenFactory = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, fi);
  const token = await TokenFactory.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  // 2. Deploy TokenPortal
  const PortalFactory = new ethers.ContractFactory(portalArtifact.abi, portalArtifact.bytecode, fi);
  const portal = await PortalFactory.deploy(tokenAddress);
  await portal.waitForDeployment();
  const portalAddress = await portal.getAddress();

  // 3. Deploy Rollup
  const RollupFactory = new ethers.ContractFactory(rollupArtifact.abi, rollupArtifact.bytecode, fi);
  const rollup = await RollupFactory.deploy();
  await rollup.waitForDeployment();
  const rollupAddress = await rollup.getAddress();

  // Whitelist TokenPortal astfel incat sa poata primi si bloca tokeni EURS
  const tx = await token.setWhitelist(portalAddress, true);
  await tx.wait();

  console.log("\n--- Deployed Addresses ---");
  console.log("Token:      ", tokenAddress);
  console.log("TokenPortal:", portalAddress);
  console.log("Rollup:     ", rollupAddress);

  // Exporta adresele si ABI-urile intr-un singur JSON
  const deploymentData = {
    network: "localhost",
    chainId: 31337,
    roles: {
      fi: await fi.getAddress(),
      supplier: await supplier.getAddress(),
      buyer: await buyer.getAddress()
    },
    contracts: {
      Token: {
        address: tokenAddress,
        abi: tokenArtifact.abi
      },
      TokenPortal: {
        address: portalAddress,
        abi: portalArtifact.abi
      },
      Rollup: {
        address: rollupAddress,
        abi: rollupArtifact.abi
      }
    }
  };

  const outPath = path.join(__dirname, "..", "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(deploymentData, null, 2));
  console.log("\nSaved deployment info to:", outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});