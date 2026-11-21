const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

const escrowBalances = {}; // negotiationId -> { amount, buyer, supplier }
const submittedBatches = []; // { batchId, merkleRoot, leaves: [txHash, ...] }

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
let nextProductId = 1;
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

function hashPair(a, b) {
  const [first, second] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [first, second]);
}

function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, layers: [] };
  let layer = [...leaves];
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : left;
      next.push(hashPair(left, right));
    }
    layer = next;
    layers.push(layer);
  }
  return { root: layer[0], layers };
}

function getMerkleProof(leaves, targetHash) {
  const { layers } = buildMerkleTree(leaves);
  let idx = leaves.indexOf(targetHash);
  if (idx === -1) return null;
  const proof = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    proof.push(siblingIdx < layer.length ? layer[siblingIdx] : layer[idx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
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
  const {name, description, supplierAddress } = req.body;
  const generatedId = `PROD-${String(nextProductId++).padStart(3, "0")}`;
  const item = {
    id: products.length + 1,
    productId: generatedId,
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

    const product = products.find((p) => p.productId === productId);
    const productName = product ? product.name : "Unknown Product";

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
  const neg = negotiations.find((n) => n.id === Number(req.params.id));
  if (!neg) return res.status(404).json({ error: "Negotiation not found" });

  const terms = decryptFor(neg.buyerAddress, neg.encryptedForBuyer);
  const buyerBal = l2Balances[neg.buyerAddress] || 0;
  if (buyerBal < terms.totalPrice) {
    return res.status(400).json({ error: `Buyer needs ${terms.totalPrice} EURS on L2 to lock Escrow.` });
  }

  l2Balances[neg.buyerAddress] -= terms.totalPrice;
  escrowBalances[neg.id] = {
    amount: terms.totalPrice,
    buyer: neg.buyerAddress,
    supplier: neg.supplierAddress
  };

  neg.status = "ESCROW_LOCKED";
  const l2TxHash = recordPrivateTx("ESCROW_LOCK", { negotiationId: neg.id, amount: terms.totalPrice });
  neg.escrowTxHash = l2TxHash;

  res.json({ negotiation: neg, l2TxHash });
});

app.post("/api/negotiations/:id/pay", (req, res) => {
  const neg = negotiations.find((n) => n.id === Number(req.params.id));
  if (!neg || neg.status !== "ESCROW_LOCKED") {
    return res.status(400).json({ error: "Negotiation is not in ESCROW_LOCKED state" });
  }

  const escrow = escrowBalances[neg.id];
  l2Balances[escrow.supplier] = (l2Balances[escrow.supplier] || 0) + escrow.amount;
  delete escrowBalances[neg.id];

  neg.status = "PAID";
  const invoiceId = `INV-2026-000${neg.id}`;
  const l2TxHash = recordPrivateTx("PRIVATE_PAYMENT", { negotiationId: neg.id, invoiceId });
  neg.paymentTxHash = l2TxHash;

  // Nota AML/CFT pentru FI
  const auditPayload = {
    invoiceId,
    negotiationId: neg.id,
    from: escrow.buyer,
    to: escrow.supplier,
    amount: escrow.amount,
    timestamp: new Date().toISOString()
  };
  auditNotes.push({
    id: auditNotes.length + 1,
    negotiationId: neg.id,
    encryptedForFI: encryptFor(deployment.roles.fi, auditPayload)
  });

  res.json({ negotiation: neg, invoiceId, l2TxHash });
});

app.post("/api/negotiations/:id/dispute", (req, res) => {
  const neg = negotiations.find((n) => n.id === Number(req.params.id));
  if (!neg || neg.status !== "ESCROW_LOCKED") {
    return res.status(400).json({ error: "Can only dispute an ESCROW_LOCKED order" });
  }
  neg.status = "DISPUTED";
  neg.disputeReason = req.body.reason || "Delivery issue";
  const l2TxHash = recordPrivateTx("DISPUTE_OPENED", { negotiationId: neg.id });
  res.json({ negotiation: neg, l2TxHash });
});

app.post("/api/negotiations/:id/resolve-dispute", (req, res) => {
  const { decision } = req.body; // 'REFUND_BUYER' | 'RELEASE_SUPPLIER'
  const neg = negotiations.find((n) => n.id === Number(req.params.id));
  if (!neg || neg.status !== "DISPUTED") {
    return res.status(400).json({ error: "Negotiation is not disputed" });
  }

  const escrow = escrowBalances[neg.id];
  if (decision === "REFUND_BUYER") {
    l2Balances[escrow.buyer] = (l2Balances[escrow.buyer] || 0) + escrow.amount;
    neg.status = "REFUNDED";
  } else {
    l2Balances[escrow.supplier] = (l2Balances[escrow.supplier] || 0) + escrow.amount;
    neg.status = "PAID";
  }
  delete escrowBalances[neg.id];

  const l2TxHash = recordPrivateTx("DISPUTE_RESOLVED", { negotiationId: neg.id, decision });
  neg.paymentTxHash = l2TxHash;
  res.json({ negotiation: neg, l2TxHash });
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const { address, amount } = req.body;
    const addr = address.toLowerCase();
    const numAmount = Number(amount);

    if ((l2Balances[addr] || 0) < numAmount) {
      return res.status(400).json({ error: "Insufficient L2 private balance" });
    }

    l2Balances[addr] -= numAmount;
    const l2TxHash = recordPrivateTx("PRIVATE_WITHDRAW", { amount: numAmount });

    const tx = await portalContract.withdrawToL1(
      address,
      ethers.parseUnits(numAmount.toString(), 18),
      l2TxHash
    );
    await tx.wait();

    res.json({ l1TxHash: tx.hash, l2TxHash, newL2Balance: l2Balances[addr] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/proof/:txHash", async (req, res) => {
  try {
    const { txHash } = req.params;
    const batch = submittedBatches.find((b) => b.leaves.includes(txHash));
    if (!batch) {
      return res.status(404).json({ error: "Tx not yet anchored in an L1 Rollup Batch. Submit Rollup Batch from FI first." });
    }

    const proof = getMerkleProof(batch.leaves, txHash);
    const onChainBatch = await rollupContract.batches(batch.batchId);
    const l1MerkleRoot = onChainBatch.merkleRoot;

    // Reconstruct root from txHash + proof
    let computed = txHash;
    for (const sibling of proof) {
      computed = hashPair(computed, sibling);
    }

    res.json({
      txHash,
      batchId: batch.batchId,
      proof,
      computedRoot: computed,
      l1MerkleRoot,
      verified: computed.toLowerCase() === l1MerkleRoot.toLowerCase()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const leaves = pendingL2Hashes.map((t) => t.txHash);
    const { root: merkleRoot } = buildMerkleTree(leaves);
    const txCount = leaves.length;

    const tx = await rollupContract.submitBatch(merkleRoot, txCount);
    const receipt = await tx.wait();

    const batchCount = await rollupContract.getBatchCount();
    const batchId = Number(batchCount) - 1;
    const gasUsed = Number(receipt.gasUsed);
    submittedBatches.push({ batchId, merkleRoot, leaves, gasUsed });

    pendingL2Hashes = [];

    res.json({
      success: true,
      batchId,
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

    const AVG_L1_TX_GAS = 65000; // Cost mediu standard pe Ethereum L1 (transfer ERC-20 / update stare)

    let totalL2Txs = 0;
    let totalRollupGas = 0;

    const enrichedBatches = batches.map((b) => {
      const localBatch = submittedBatches.find((sb) => sb.batchId === b.batchId);
      const gasUsed = localBatch ? localBatch.gasUsed : 95000;
      totalL2Txs += b.txCount;
      totalRollupGas += gasUsed;
      return {
        ...b,
        gasUsed,
        gasPerTx: b.txCount > 0 ? Math.round(gasUsed / b.txCount) : gasUsed
      };
    });

    const estimatedPureL1Gas = totalL2Txs * AVG_L1_TX_GAS;
    const gasSaved = Math.max(0, estimatedPureL1Gas - totalRollupGas);
    const savingsPercent =
      estimatedPureL1Gas > 0
        ? (((estimatedPureL1Gas - totalRollupGas) / estimatedPureL1Gas) * 100).toFixed(1)
        : "0.0";

    const benchmark = {
      totalL2Txs,
      totalBatches: enrichedBatches.length,
      totalRollupGas,
      estimatedPureL1Gas,
      gasSaved,
      savingsPercent: Number(savingsPercent),
      avgGasPerL2Tx: totalL2Txs > 0 ? Math.round(totalRollupGas / totalL2Txs) : 0,
      baselineL1GasPerTx: AVG_L1_TX_GAS
    };

    res.json({ batches: enrichedBatches, deposits, benchmark });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
initBlockchain().then(() => {
  app.listen(PORT, () => console.log(`L2 Backend & Sequencer running on http://localhost:${PORT}`));
});