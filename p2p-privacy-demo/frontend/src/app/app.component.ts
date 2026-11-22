import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ethers } from 'ethers';
import { waitForAsync } from '@angular/core/testing';
import { delay } from 'rxjs/internal/operators/delay';

declare global {
  interface Window {
    ethereum?: any;
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  API = 'http://localhost:3000/api';

  config: any = null;
  account: string = '';
  role: 'FI' | 'SUPPLIER' | 'BUYER' | 'GUEST' = 'GUEST';
  activeTab: 'FI' | 'SUPPLIER' | 'BUYER' | 'EXPLORER' = 'EXPLORER';

  l1Balance: string = '0';
  l2Balance: number = 0;
  statusMsg: string = '';
  errorMsg: string = '';

  // Formulare FI
  mintAmount: number = 10000;

  // Formulare Buyer (Bridge)
  bridgeAmount: number = 5000;
  bridgeSecret: string = 'secret-demo-123';
  claimDepositId: number = 0;

  // Formulare Supplier (Produs)
  newProduct = { name: '', description:'' };

  // Formulare Buyer (Negociere)
  newDemand = { productId: '', supplierAddress: '', quantity: 0, unitPrice: 0, deliveryDate: 'yyyy-MM-dd' };

  // Date din backend & L1
  products: any[] = [];
  negotiations: any[] = [];
  decryptedNotes: { [id: number]: any } = {};
  auditNotes: any[] = [];
  decryptedAudits: { [id: number]: any } = {};
  sequencerStatus: any = { pendingCount: 0, pendingTxs: [] };
  explorerData: any = { batches: [], deposits: [] };

  async ngOnInit() {
    await this.loadConfig();
    await this.refreshAll();

    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts: string[]) => {
        if (accounts.length > 0) {
          this.setAccount(accounts[0]);
        } else {
          this.account = '';
          this.role = 'GUEST';
          this.activeTab = 'EXPLORER';
        }
      });
    }
  }

  async loadConfig() {
    const res = await fetch(`${this.API}/config`);
    this.config = await res.json();
    this.newDemand.supplierAddress = this.config.roles.supplier;
  }

  async connectMetaMask() {
    this.clearMessages();
    if (!window.ethereum) {
      this.errorMsg = 'MetaMask is not installed!';
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      await this.setAccount(accounts[0]);
    } catch (err: any) {
      this.errorMsg = err.message;
    }
  }

  async setAccount(addr: string) {
    this.decryptedNotes = {};
    this.account = addr.toLowerCase();
    if (this.account === this.config.roles.fi.toLowerCase()) {
      this.role = 'FI';
      this.activeTab = 'FI';
    } else if (this.account === this.config.roles.supplier.toLowerCase()) {
      this.role = 'SUPPLIER';
      this.activeTab = 'SUPPLIER';
    } else if (this.account === this.config.roles.buyer.toLowerCase()) {
      this.role = 'BUYER';
      this.activeTab = 'BUYER';
    } else {
      this.role = 'GUEST';
      this.activeTab = 'EXPLORER';
    }
    await this.refreshAll();
  }

  async getSigner() {
    const provider = new ethers.BrowserProvider(window.ethereum);
    return await provider.getSigner();
  }

  async refreshAll() {
    if (!this.config) return;
    try {
      const [prodRes, negRes, auditRes, seqRes, expRes] = await Promise.all([
        fetch(`${this.API}/products`),
        fetch(`${this.API}/negotiations`),
        fetch(`${this.API}/audit-notes`),
        fetch(`${this.API}/sequencer/status`),
        fetch(`${this.API}/explorer`)
      ]);

      this.products = await prodRes.json();
      this.negotiations = await negRes.json();
      this.auditNotes = await auditRes.json();
      this.sequencerStatus = await seqRes.json();
      this.explorerData = await expRes.json();

      if (this.account) {
        const balRes = await fetch(`${this.API}/l2/balance/${this.account}`);
        const balData = await balRes.json();
        this.l2Balance = balData.balance;

        if (window.ethereum) {
          const provider = new ethers.BrowserProvider(window.ethereum);
          const token = new ethers.Contract(this.config.contracts.Token.address, this.config.contracts.Token.abi, provider);
          const rawBal = await token['balanceOf'](this.account);
          this.l1Balance = ethers.formatUnits(rawBal, 18);
        }
      }
    } catch (err: any) {
      console.error(err);
    }
  }

  // FI
  async whitelistAndMint(targetAddress: string) {
    this.clearMessages();
    try {
      const signer = await this.getSigner();
      const token = new ethers.Contract(this.config.contracts.Token.address, this.config.contracts.Token.abi, signer);

     this.showStatus('1/2 Adding address to KYC Whitelist on L1...');
      const tx1 = await token['setWhitelist'](targetAddress, true);
      await tx1.wait();

      this.showStatus(`2/2 Emitting ${this.mintAmount} EURS on L1...`);
      const tx2 = await token['mint'](targetAddress, ethers.parseUnits(this.mintAmount.toString(), 18));
      await tx2.wait();

      this.showStatus(`Success! Address ${targetAddress.slice(0, 8)}... has been whitelisted and received ${this.mintAmount} EURS.`);
      await this.refreshAll();
    } catch (err: any) {
      this.errorMsg = err.reason || err.message;
    }
  }

  withdrawAmount = 500;
  proofResult: any = null;

  async withdrawToL1() {
    this.clearMessages();
    try {
      const res = await fetch(`${this.API}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: this.account,
          amount: this.withdrawAmount
        })
      });
      const data = await res.json();
      if (res.ok) {
        this.showStatus(`Withdrawn ${this.withdrawAmount} EURS to L1 (MetaMask)! L1 Tx: ${data.l1TxHash.slice(0, 14)}...`);
        await this.refreshAll();
      } else {
        this.errorMsg = data.error;
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    }
  }

  async openDispute(id: number) {
    this.clearMessages();
    try {
      const res = await fetch(`${this.API}/negotiations/${id}/dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Goods damaged or not delivered as agreed' })
      });
      const data = await res.json();
      if (res.ok) {
        this.showStatus(`Dispute opened for Negotiation #${id}. Funds remain frozen in L2 Escrow until FI resolves.`);
        await this.refreshAll();
      } else {
        this.errorMsg = data.error;
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    }
  }

  async resolveDispute(id: number, decision: 'REFUND_BUYER' | 'RELEASE_SUPPLIER') {
    this.clearMessages();
    try {
      const res = await fetch(`${this.API}/negotiations/${id}/resolve-dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      const data = await res.json();
      if (res.ok) {
        this.showStatus(`Dispute #${id} resolved: ${decision}.`);
        await this.refreshAll();
      } else {
        this.errorMsg = data.error;
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    }
  }

  async verifyMerkleProof(txHash: string) {
    this.clearMessages();
    try {
      const res = await fetch(`${this.API}/proof/${txHash}`);
      const data = await res.json();
      if (res.ok) {
        this.proofResult = data;
        this.showStatus(data.verified
          ? `Merkle Inclusion Proof VERIFIED against L1 Rollup Batch #${data.batchId}!`
          : 'Proof verification failed!');
      } else {
        this.errorMsg = data.error;
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    }
  }

  async decryptAudit(noteId: number) {
    this.clearMessages();
    const res = await fetch(`${this.API}/audit-notes/${noteId}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerAddress: this.account })
    });
    const data = await res.json();
    if (res.ok) {
      this.decryptedAudits[noteId] = data.decrypted;
    } else {
      this.errorMsg = data.error;
    }
  }

  async submitRollupBatch() {
    this.clearMessages();
    const res = await fetch(`${this.API}/sequencer/submit-batch`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      this.showStatus(`Rollup Batch trimis pe L1! Merkle Root: ${data.merkleRoot.slice(0, 18)}... (${data.txCount} tx agregate)`);
      await this.refreshAll();
    } else {
      this.errorMsg = data.error;
    }
  }

  // By
  async lockTokensToL2() {
    this.clearMessages();
    try {
      const signer = await this.getSigner();
      const amountWei = ethers.parseUnits(this.bridgeAmount.toString(), 18);
      const secretHash = ethers.keccak256(ethers.toUtf8Bytes(this.bridgeSecret));

      const token = new ethers.Contract(this.config.contracts.Token.address, this.config.contracts.Token.abi, signer);
      const portal = new ethers.Contract(this.config.contracts.TokenPortal.address, this.config.contracts.TokenPortal.abi, signer);

      this.showStatus('1/2 Approving TokenPortal on L1...');
      const tx1 = await token['approve'](this.config.contracts.TokenPortal.address, amountWei);
      await tx1.wait();

      this.showStatus('2/2 Locking funds in TokenPortal.sol with secretHash...');
      const tx2 = await portal['depositToL2'](amountWei, secretHash);
      await tx2.wait();

      this.showStatus(`Funds locked on L1! SecretHash: ${secretHash.slice(0, 18)}... Now claim them on L2.`);
      await this.refreshAll();
    } catch (err: any) {
      this.errorMsg = err.reason || err.message;
    }
  }

  async claimOnL2() {
    this.clearMessages();
    const res = await fetch(`${this.API}/l2/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        depositId: Number(this.claimDepositId),
        secret: this.bridgeSecret,
        claimantAddress: this.account
      })
    });
    const data = await res.json();
    if (res.ok) {
      this.showStatus(`Claimed successfully on L2! New private balance: ${data.newL2Balance} EURS.`);
      await this.refreshAll();
    } else {
      this.errorMsg = data.error;
    }
  }

  async sendPrivateDemand() {
    this.clearMessages();
    const res = await fetch(`${this.API}/negotiations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.newDemand, buyerAddress: this.account })
    });
    const data = await res.json();
    if (res.ok) {
      this.showStatus(`Private demand encrypted and sent! Commitment Hash: ${data.negotiation.commitmentHash.slice(0, 18)}...`);
      await this.refreshAll();
    } else {
      this.errorMsg = data.error;
    }
  }

  async payPrivately(negotiationId: number) {
    this.clearMessages();
    const res = await fetch(`${this.API}/negotiations/${negotiationId}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyerAddress: this.account })
    });
    const data = await res.json();
    if (res.ok) {
      this.showStatus(`Private Escrow released (${data.invoiceId})! Encrypted AML note generated for FI.`);
      await this.refreshAll();
    } else {
      this.errorMsg = data.error;
    }
  }


private msgTimer: any;

  showStatus(msg: string) {
    this.statusMsg = msg;
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => {
      this.statusMsg = '';
    }, 3000);
  }

  // Sup
  async publishProduct() {
    this.clearMessages();
    const res = await fetch(`${this.API}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.newProduct, supplierAddress: this.account })
    });
    if (res.ok) {
      this.showStatus(`Product ${this.newProduct.name} has been published!`);
      this.newProduct = { name: '', description: '' };
      await this.refreshAll();

      setTimeout(() => {
        this.statusMsg = '';
      }, 3000);
    }
  }

  async decryptNegotiation(negId: number) {
    this.clearMessages();
    const res = await fetch(`${this.API}/negotiations/${negId}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerAddress: this.account })
    });
    const data = await res.json();
    if (res.ok) {
      this.decryptedNotes[negId] = data.decrypted;
    } else {
      this.errorMsg = data.error;
    }
  }

  async acceptNegotiation(negId: number) {
    this.clearMessages();
    const res = await fetch(`${this.API}/negotiations/${negId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerAddress: this.account })
    });
    const data = await res.json();
    if (res.ok) {
      this.showStatus(`Offer #${negId} accepted! Buyer funds locked in Private L2 Escrow.`);
      await this.refreshAll();
    } else {
      this.errorMsg = data.error;
    }
  }

  clearMessages() {
    this.statusMsg = '';
    this.errorMsg = '';
  }

  showCounterForm: { [id: number]: boolean } = {};
  counterPrice: { [id: number]: number } = {};
  counterDate: { [id: number]: string } = {};

  async sendCounterOffer(negId: number) {
    this.clearMessages();
    try {
      const res = await fetch(`${this.API}/negotiations/${negId}/counter-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newUnitPrice: this.counterPrice[negId],
          newDeliveryDate: this.counterDate[negId]
        })
      });
      const data = await res.json();
      if (res.ok) {
        this.showCounterForm[negId] = false;
        delete this.decryptedNotes[negId];
        this.showStatus(`Encrypted Counter-Offer sent for Negotiation #${negId}! Waiting for Buyer approval.`);
        await this.refreshAll();
      } else {
        this.errorMsg = data.error;
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    }
  }

  async simulateTamper(txHash: string) {
    this.clearMessages();
    try {
      const res = await fetch(`${this.API}/proof/${txHash}?tamper=true`);
      const data = await res.json();
      if (res.ok) {
        this.proofResult = data;
        this.errorMsg = 'TAMPERING DETECTED! 1-byte modification produced a different Merkle Root — Proof INVALID.';
      } else {
        this.errorMsg = data.error;
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    }
  }

}

function wait(arg0: number) {
  throw new Error('Function not implemented.');
}
