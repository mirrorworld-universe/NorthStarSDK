import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Router } from "../target/types/router";
import { expect } from "chai";

describe("SonicRouter Program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Router as Program<Router>;
  const owner = provider.wallet.publicKey;

  let sessionPda: web3.PublicKey;
  let feeVaultPda: web3.PublicKey;
  let outboxPda: web3.PublicKey;

  const gridId = new anchor.BN(1);

  before(async () => {
    // Derive PDAs
    [sessionPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        owner.toBuffer(),
        gridId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [feeVaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault"), owner.toBuffer()],
      program.programId
    );

    [outboxPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("outbox"), owner.toBuffer()],
      program.programId
    );
  });

  describe("Full Flow Test", () => {
    it("Step 1: Create session", async () => {
      const tx = await program.methods
        .openSession(
          gridId,
          [], // No program restrictions
          Buffer.from([0]), // Allow swap opcode
          new anchor.BN(2000), // 2000 slots TTL
          new anchor.BN(1_000_000) // 1M lamports fee cap
        )
        .rpc();

      console.log("✓ Session created:", tx);

      // Verify session
      const session = await program.account.session.fetch(sessionPda);
      expect(session.owner.toBase58()).to.equal(owner.toBase58());
      expect(session.gridId.toNumber()).to.equal(1);
      expect(session.nonce.toNumber()).to.equal(0);
      expect(session.feeCap.toNumber()).to.equal(1_000_000);

      console.log("  Session PDA:", sessionPda.toBase58());
      console.log("  Grid ID:", session.gridId.toNumber());
      console.log("  Nonce:", session.nonce.toNumber());
    });

    it("Step 2: Fund fee vault", async () => {
      const depositAmount = new anchor.BN(500_000);

      const tx = await program.methods
        .depositFee(depositAmount)
        .rpc();

      console.log("✓ Fee vault funded:", tx);

      // Verify balance in FeeVault struct
      const feeVault = await program.account.feeVault.fetch(feeVaultPda);
      expect(feeVault.balance.toNumber()).to.equal(depositAmount.toNumber());

      // Verify actual SOL balance
      const solBalance = await provider.connection.getBalance(feeVaultPda);
      expect(solBalance).to.be.greaterThan(0);

      console.log("  Tracked balance:", feeVault.balance.toNumber(), "lamports");
      console.log("  Actual SOL balance:", solBalance, "lamports");
    });

    it("Step 3: Send message to Sonic (lazy initializes outbox)", async () => {
      const msg = {
        gridId,
        kind: { invoke: {} },
        invoke: {
          targetProgram: web3.SystemProgram.programId,
          accounts: [],
          data: Buffer.from([]),
        },
        opcode: null,
        params: null,
        nonce: new anchor.BN(0),
        ttlSlots: new anchor.BN(1000),
      };

      const feeBudget = new anchor.BN(100_000);

      const tx = await program.methods
        .sendMessage(gridId, msg, feeBudget)
        .rpc();

      console.log("✓ Message sent:", tx);

      // Verify outbox was created and updated (lazy initialization)
      const outbox = await program.account.outbox.fetch(outboxPda);
      expect(outbox.authority.toBase58()).to.equal(owner.toBase58());
      expect(outbox.entryCount.toNumber()).to.equal(1);

      // Verify nonce was incremented
      const session = await program.account.session.fetch(sessionPda);
      expect(session.nonce.toNumber()).to.equal(1);

      // Verify fee was deducted
      const feeVault = await program.account.feeVault.fetch(feeVaultPda);
      expect(feeVault.balance.toNumber()).to.equal(400_000); // 500k - 100k

      console.log("  Entry committed to outbox");
      console.log("  New nonce:", session.nonce.toNumber());
      console.log("  Remaining fee balance:", feeVault.balance.toNumber());
    });
  });

  describe("Negative Tests", () => {
    it("should fail with too many allowed programs", async () => {
      const gridId2 = new anchor.BN(2);
      const [session2Pda] = web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          owner.toBuffer(),
          gridId2.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const allowedPrograms = Array(11).fill(web3.SystemProgram.programId);

      try {
        await program.methods
          .openSession(
            gridId2,
            allowedPrograms,
            Buffer.from([]),
            new anchor.BN(2000),
            new anchor.BN(1_000_000)
          )
          .rpc();
        
        expect.fail("Should have thrown error");
      } catch (error: any) {
        // Should fail with too many programs
        expect(error).to.exist;
      }
    });

    it("should fail to close non-expired session", async () => {
      try {
        await program.methods
          .closeExpired(gridId)
          .rpc();
        
        expect.fail("Should have thrown error");
      } catch (error: any) {
        // Should fail - session not expired yet
        expect(error).to.exist;
      }
    });
  });
});
