import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EscrowVault } from "../target/types/escrow_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("escrow_vault — happy path", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.EscrowVault as Program<EscrowVault>;

  const payer     = Keypair.generate();
  const recipient = Keypair.generate();
  const arbiter   = Keypair.generate();

  let mint: PublicKey;
  let payerAta: PublicKey;
  let escrowPda: PublicKey;
  let vaultAta: PublicKey;

  const AMOUNT    = 500_000;
  const MILESTONES = 2;
  let unlockAt: number;

  before(async () => {
    // Fund all actors
    for (const kp of [payer, recipient, arbiter]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create a test mint
    mint = await createMint(provider.connection, payer, payer.publicKey, null, 0);

    // Create ATAs
    payerAta = await createAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
    await createAssociatedTokenAccount(provider.connection, payer, mint, recipient.publicKey);

    // Mint tokens to payer
    await mintTo(provider.connection, payer, mint, payerAta, payer, 1_000_000);

    // Derive escrow PDA and vault ATA
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), mint.toBuffer()],
      program.programId
    );
    vaultAta = await getAssociatedTokenAddress(mint, escrowPda, true);

    unlockAt = Math.floor(Date.now() / 1000) + 5;
  });

  it("initializes escrow and funds vault", async () => {
    await program.methods
      .initializeEscrow(new anchor.BN(AMOUNT), MILESTONES, new anchor.BN(unlockAt))
      .accounts({
        payer:             payer.publicKey,
        recipient:         recipient.publicKey,
        arbiter:           arbiter.publicKey,
        mint,
        escrowState:       escrowPda,
        vault:             vaultAta,
        payerTokenAccount: payerAta,
        tokenProgram:      TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:     SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultAta);
    assert.equal(vaultAccount.amount, BigInt(AMOUNT), "vault should hold deposited amount");

    const state = await program.account.escrowState.fetch(escrowPda);
    assert.equal(state.amount.toNumber(), AMOUNT);
    assert.equal(state.milestonesRequired, MILESTONES);
    assert.equal(state.milestonesCompleted, 0);
    assert.isFalse(state.cancelled);
    assert.isFalse(state.arbiterApproved);
  });

  it("completes first milestone", async () => {
    await program.methods
      .completeMilestone()
      .accounts({
        recipient:   recipient.publicKey,
        escrowState: escrowPda,
      })
      .signers([recipient])
      .rpc();

    const state = await program.account.escrowState.fetch(escrowPda);
    assert.equal(state.milestonesCompleted, 1);
  });

  it("completes second milestone", async () => {
    await program.methods
      .completeMilestone()
      .accounts({
        recipient:   recipient.publicKey,
        escrowState: escrowPda,
      })
      .signers([recipient])
      .rpc();

    const state = await program.account.escrowState.fetch(escrowPda);
    assert.equal(state.milestonesCompleted, 2);
  });

  it("arbiter approves early release", async () => {
    await program.methods
      .arbiterApprove()
      .accounts({
        arbiter:     arbiter.publicKey,
        escrowState: escrowPda,
      })
      .signers([arbiter])
      .rpc();

    const state = await program.account.escrowState.fetch(escrowPda);
    assert.isTrue(state.arbiterApproved);
  });

  it.skip("claims tokens after time-lock — claim instruction not yet active");

  it.skip("cancel refunds payer on fresh escrow — cancel instruction not yet active");
});
