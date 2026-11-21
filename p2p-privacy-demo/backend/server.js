const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// 1. Incarca deployment.json generat la Pasul 1
const deploymentPath = path.join(__dirname, "..", "blockchain", "deployment.json");
if (!fs.existsSync(deploymentPath)) {
  console.error("Nu am gasit blockchain/deployment.json! Ruleaza deploy.js mai intai.");
  process.exit(1);
}
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

// 2. Conexiune la L1 (Hardhat node local)
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
let sequencerSigner, tokenContract, portalContract, rollupContract;

async function initBlockchain() {
  sequencerSigner = await provider.getSigner(0); // Account #0 = FI & Sequencer
  tokenContract = new ethers.Contract(
    deployment.contracts.Token.address,
    deployment.contracts.Token.abi,
    sequencerSigner
  );
  portalContract = new ethers.Contract(
    deployment.contracts.TokenPortal.address,
    deployment.contracts.TokenPortal.abi,
    sequencerSigner
  );
  rollupContract = new ethers.Contract(
    deployment.contracts.Rollup.address,
    deployment.contracts.Rollup.abi,
    sequencerSigner
  );
  console.log("Connected to L1 Hardhat node. Sequencer:", await sequencerSigner.getAddress());
}

// 3. Generare chei asimetrice RSA pentru mediul privat L2 (PXE)
function generateKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

const l2Keys = {
  [deployment.roles.fi.toLowerCase()]: generateKeyPair(),
  [deployment.roles.supplier.toLowerCase()]: generateKeyPair(),
  [deployment.roles.buyer.toLowerCase()]: generateKeyPair()
};

function encryptFor(address, dataObj) {
  const keys = l2Keys[address.toLowerCase()];
  if (!keys) throw new Error("Unknown L2 address");

  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);

  const encryptedData = Buffer.concat([
    cipher.update(JSON.stringify(dataObj), "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const encryptedKey = crypto.publicEncrypt(keys.publicKey, aesKey);

  return Buffer.from(
    JSON.stringify({
      key: encryptedKey.toString("base64"),
      iv: iv.toString("base64"),
      tag: authTag.toString("base64"),
      data: encryptedData.toString("base64")
    })
  ).toString("base64");
}

function decryptFor(address, cipherBase64) {
  const keys = l2Keys[address.toLowerCase()];
  if (!keys) throw new Error("Unknown L2 address");

  const payload = JSON.parse(Buffer.from(cipherBase64, "base64").toString("utf8"));
  const aesKey = crypto.privateDecrypt(keys.privateKey, Buffer.from(payload.key, "base64"));

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

// Helper: construire Merkle Root din lista de hash-uri
function computeMerkleRoot(hashes) {
  if (hashes.length === 0) return ethers.ZeroHash;
  let level = [...hashes];
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const combined = ethers.keccak256(ethers.concat([left, right]));
      nextLevel.push(combined);
    }
    level = nextLevel;
  }
  return level[0];
}

// 4. Stare in-memory pentru L2
const l2Balances = {
  [deployment.roles.fi.toLowerCase()]: 0,
  [deployment.roles.supplier.toLowerCase()]: 0,
  [deployment.roles.buyer.toLowerCase()]: 0
};

const products = [];
const negotiations = [];
const auditNotes = [];
let pendingL2Hashes = []; // Tranzactii private ce asteapta sa fie impachetate in Rollup

function recordPrivateTx(type, payload) {
  const txHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({ type, payload, nonce: Date.now(), rand: Math.random() }))
  );
  pendingL2Hashes.push({
    txHash,
    type,
    timestamp: new Date().toISOString()
  });
  return txHash;
}

// ================= ENDPOINTS =================

// Configuratie pentru Frontend (adrese contracte, ABI, roluri, chei publice L2)
app.get("/api/config", (req, res) => {
  res.json({
    ...deployment,
    l2PublicKeys: {
      fi: l2Keys[deployment.roles.fi.toLowerCase()].publicKey,
      supplier: l2Keys[deployment.roles.supplier.toLowerCase()].publicKey,
      buyer: l2Keys[deployment.roles.buyer.toLowerCase()].publicKey
    }
  });
});

// Sold privat L2
app.get("/api/l2/balance/:address", (req, res) => {
  const addr = req.params.address.toLowerCase();
  res.json({ address: addr, balance: l2Balances[addr] || 0 });
});

// Bridge L1 -> L2: revendicare tokeni privati cu secretul necriptat
app.post("/api/l2/claim", async (req, res) => {
  try {
    const { depositId, secret, claimantAddress } = req.body;
    const deposits = await portalContract.getAllDeposits();
    const dep = deposits[depositId];

    if (!dep) return res.status(404).json({ error: "Deposit not found on L1" });
    if (dep.claimed) return res.status(400).json({ error: "Deposit already claimed" });

    const computedHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
    if (computedHash !== dep.secretHash) {
      return res.status(403).json({ error: "Invalid secret! Hash mismatch." });
    }

    // Marcheaza ca revendicat pe L1 (nullifier)
    const tx = await portalContract.markClaimed(depositId);
    await tx.wait();

    const amountTokens = Number(ethers.formatUnits(dep.amount, 18));
    const addr = claimantAddress.toLowerCase();
    l2Balances[addr] = (l2Balances[addr] || 0) + amountTokens;

    const l2TxHash = recordPrivateTx("L2_MINT_BRIDGE", { depositId, amountTokens });

    res.json({
      success: true,
      amountClaimed: amountTokens,
      newL2Balance: l2Balances[addr],
      l2TxHash
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Produse (lista publica de catalog)
app.get("/api/products", (req, res) => {
  res.json(products);
});

app.post("/api/products", (req, res) => {
  const { productId, name, description, supplierAddress } = req.body;
  const item = {
    id: products.length + 1,
    productId,
    name,
    description,
    supplierAddress: supplierAddress.toLowerCase(),
    supplierPublicKeySnippet: l2Keys[supplierAddress.toLowerCase()]?.publicKey.slice(27, 75) + "..."
  };
  products.push(item);
  res.json(item);
});

// Negocieri private (criptate asimetric)
app.get("/api/negotiations", (req, res) => {
  res.json(negotiations);
});

app.post("/api/negotiations", (req, res) => {
  try {
    const { productId, buyerAddress, supplierAddress, quantity, unitPrice, deliveryDate } = req.body;
    const totalPrice = Number(quantity) * Number(unitPrice);
    const terms = {
      productId,
      productName,
      quantity: Number(quantity),
      unitPrice: Number(unitPrice),
      totalPrice,
      deliveryDate,
      buyerAddress: buyerAddress.toLowerCase(),
      supplierAddress: supplierAddress.toLowerCase()
    };

    const commitmentHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(terms)));
    const encryptedForSupplier = encryptFor(supplierAddress, terms);
    const encryptedForBuyer = encryptFor(buyerAddress, terms);

    const neg = {
      id: negotiations.length + 1,
      productId,
      productName,
      buyerAddress: buyerAddress.toLowerCase(),
      supplierAddress: supplierAddress.toLowerCase(),
      status: "PROPOSED", // PROPOSED -> ACCEPTED -> PAID
      commitmentHash,
      encryptedForSupplier,
      encryptedForBuyer,
      createdAt: new Date().toISOString()
    };

    negotiations.push(neg);
    const l2TxHash = recordPrivateTx("PRIVATE_DEMAND", { commitmentHash });

    res.json({ negotiation: neg, l2TxHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decriptare negociere (doar Buyer sau Supplier)
app.post("/api/negotiations/:id/decrypt", (req, res) => {
  try {
    const { callerAddress } = req.body;
    const neg = negotiations.find((n) => n.id === Number(req.params.id));
    if (!neg) return res.status(404).json({ error: "Negotiation not found" });

    const caller = callerAddress.toLowerCase();
    if (caller === neg.supplierAddress) {
      return res.json({ decrypted: decryptFor(caller, neg.encryptedForSupplier) });
    }
    if (caller === neg.buyerAddress) {
      return res.json({ decrypted: decryptFor(caller, neg.encryptedForBuyer) });
    }
    return res.status(403).json({ error: "Access denied: you do not hold the private key for this note." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Acceptare oferta de catre Supplier
app.post("/api/negotiations/:id/accept", (req, res) => {
  const { callerAddress } = req.body;
  const neg = negotiations.find((n) => n.id === Number(req.params.id));
  if (!neg) return res.status(404).json({ error: "Negotiation not found" });
  if (neg.supplierAddress !== callerAddress.toLowerCase()) {
    return res.status(403).json({ error: "Only the supplier can accept" });
  }

  neg.status = "ACCEPTED";
  const l2TxHash = recordPrivateTx("PRIVATE_ACCEPT", { negotiationId: neg.id, accept: true });
  res.json({ negotiation: neg, l2TxHash });
});

// Plata privata L2 + Generare nota de audit AML/CFT pentru FI
app.post("/api/payments", (req, res) => {
  try {
    const { negotiationId, buyerAddress } = req.body;
    const neg = negotiations.find((n) => n.id === Number(negotiationId));
    if (!neg) return res.status(404).json({ error: "Negotiation not found" });
    if (neg.status !== "ACCEPTED") return res.status(400).json({ error: "Contract not accepted yet" });

    const buyer = buyerAddress.toLowerCase();
    if (neg.buyerAddress !== buyer) return res.status(403).json({ error: "Only buyer can pay" });

    // Decriptam intern termenii agreati pentru executia privata L2
    const terms = decryptFor(buyer, neg.encryptedForBuyer);
    const amount = terms.totalPrice;

    if ((l2Balances[buyer] || 0) < amount) {
      return res.status(400).json({ error: `Insufficient private L2 balance. Need ${amount} EURS.` });
    }

    // Transfer privat L2
    l2Balances[buyer] -= amount;
    l2Balances[neg.supplierAddress] = (l2Balances[neg.supplierAddress] || 0) + amount;
    neg.status = "PAID";

    // Generare nota de audit criptata cu cheia publica a FI (AML/CFT)
    const invoiceNumber = `INV-2026-${String(neg.id).padStart(4, "0")}`;
    const auditPayload = {
      invoiceNumber,
      amount,
      from: buyer,
      to: neg.supplierAddress,
      productId: neg.productId,
      settledAt: new Date().toISOString()
    };

    const encryptedForFI = encryptFor(deployment.roles.fi, auditPayload);
    const auditNote = {
      id: auditNotes.length + 1,
      negotiationId: neg.id,
      encryptedForFI,
      txCommitment: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(auditPayload))),
      createdAt: new Date().toISOString()
    };
    auditNotes.push(auditNote);

    const l2TxHash = recordPrivateTx("PRIVATE_SETTLEMENT", { txCommitment: auditNote.txCommitment });

    res.json({
      success: true,
      newBuyerL2Balance: l2Balances[buyer],
      invoiceNumber,
      l2TxHash
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Note de audit (FI)
app.get("/api/audit-notes", (req, res) => {
  res.json(auditNotes);
});

app.post("/api/audit-notes/:id/decrypt", (req, res) => {
  try {
    const { callerAddress } = req.body;
    if (callerAddress.toLowerCase() !== deployment.roles.fi.toLowerCase()) {
      return res.status(403).json({ error: "Only Financial Institution can decrypt AML/CFT audit notes." });
    }
    const note = auditNotes.find((n) => n.id === Number(req.params.id));
    if (!note) return res.status(404).json({ error: "Audit note not found" });

    res.json({ decrypted: decryptFor(callerAddress, note.encryptedForFI) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sequencer: status + trimitere Rollup Batch pe L1
app.get("/api/sequencer/status", (req, res) => {
  res.json({
    pendingCount: pendingL2Hashes.length,
    pendingTxs: pendingL2Hashes
  });
});

app.post("/api/sequencer/submit-batch", async (req, res) => {
  try {
    if (pendingL2Hashes.length === 0) {
      return res.status(400).json({ error: "No pending L2 transactions to roll up." });
    }

    const hashes = pendingL2Hashes.map((t) => t.txHash);
    const merkleRoot = computeMerkleRoot(hashes);
    const txCount = hashes.length;

    const tx = await rollupContract.submitBatch(merkleRoot, txCount);
    const receipt = await tx.wait();

    pendingL2Hashes = [];

    res.json({
      success: true,
      merkleRoot,
      txCount,
      l1TxHash: receipt.hash
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public Explorer (ce vede un competitor direct pe L1)
app.get("/api/explorer", async (req, res) => {
  try {
    const rawBatches = await rollupContract.getAllBatches();
    const rawDeposits = await portalContract.getAllDeposits();

    const batches = rawBatches.map((b) => ({
      batchId: Number(b.batchId),
      merkleRoot: b.merkleRoot,
      txCount: Number(b.txCount),
      timestamp: new Date(Number(b.timestamp) * 1000).toISOString(),
      submittedBy: b.submittedBy
    }));

    const deposits = rawDeposits.map((d) => ({
      id: Number(d.id),
      secretHash: d.secretHash,
      amount: ethers.formatUnits(d.amount, 18),
      claimed: d.claimed,
      timestamp: new Date(Number(d.timestamp) * 1000).toISOString()
    }));

    res.json({ batches, deposits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
initBlockchain().then(() => {
  app.listen(PORT, () => console.log(`L2 Backend & Sequencer running on http://localhost:${PORT}`));
});