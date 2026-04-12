import * as anchor from "@coral-xyz/anchor";
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    clusterApiUrl,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    createMint,
    createAssociatedTokenAccount,
    mintTo,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

function section(label: string, description: string) {
    console.log("\n" + "=".repeat(60));
    console.log(`  ${label}`);
    console.log("=".repeat(60));
    console.log(`  ${description}`);
}

// Sends a transaction with skipPreflight so it lands on-chain even if it
// will fail, giving us a real signature to inspect in the logs.
async function sendExpectingFailure(
    tx: Transaction,
    feePayer: Keypair,
    extraSigners: Keypair[] = []
): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer.publicKey;

    const signers = [feePayer, ...extraSigners.filter(
        s => s.publicKey.toBase58() !== feePayer.publicKey.toBase58()
    )];
    tx.sign(...signers);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    return sig;
}

async function main() {
    // ── Shared setup ──────────────────────────────────────────────────────────────

    const walletPath = path.join(homedir(), ".config", "solana", "id.json");
    const walletKeypair = Keypair.fromSecretKey(
        Buffer.from(JSON.parse(readFileSync(walletPath, "utf-8")))
    );

    const wallet = new anchor.Wallet(walletKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const idl = JSON.parse(
        readFileSync(path.join(__dirname, "../target/idl/escrow_vault.json"), "utf-8")
    );
    const programId = new PublicKey(idl.address);
    const program = new anchor.Program(idl, provider);
    const payer = walletKeypair;

    console.log("\n=== escrow_vault — failure modes ===\n");
    console.log(`Wallet: ${payer.publicKey.toBase58()}`);

    async function fund(to: PublicKey, lamports = Math.round(0.1 * LAMPORTS_PER_SOL)) {
        const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })
        );
        await provider.sendAndConfirm(tx, [payer]);
    }

    // Creates a fresh isolated escrow for each scenario.
    // A new mint per scenario means a unique PDA even with the same payer wallet.
    async function setupEscrow(opts: {
        milestones: number;
        unlockOffset: number;
        completeMilestones?: number;
        fundArbiter?: boolean;
    }) {
        const recipient = Keypair.generate();
        const arbiter   = Keypair.generate();
        await fund(recipient.publicKey);
        if (opts.fundArbiter) await fund(arbiter.publicKey);

        const mint = await createMint(connection, payer, payer.publicKey, null, 6);
        const payerAta     = await createAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
        const recipientAta = await createAssociatedTokenAccount(connection, payer, mint, recipient.publicKey);
        await mintTo(connection, payer, mint, payerAta, payer, 1_000_000_000_000);

        const [escrowPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("escrow"), payer.publicKey.toBuffer(), mint.toBuffer()],
            programId
        );
        const vaultAta = await getAssociatedTokenAddress(mint, escrowPda, true);
        const unlockAt = Math.floor(Date.now() / 1000) + opts.unlockOffset;

        await program.methods
            .initializeEscrow(new anchor.BN(500_000_000_000), opts.milestones, new anchor.BN(unlockAt))
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
            .rpc();

        for (let i = 0; i < (opts.completeMilestones ?? 0); i++) {
            await program.methods
                .completeMilestone()
                .accounts({ recipient: recipient.publicKey, escrowState: escrowPda })
                .signers([recipient])
                .rpc();
        }

        return { recipient, arbiter, mint, payerAta, recipientAta, escrowPda, vaultAta };
    }

    // ── A: Wrong signer on claim ──────────────────────────────────────────────────

    section(
        "A — Wrong signer on claim",
        "Sending claim with payer as authority instead of the designated recipient."
    );
    {
        console.log("  Setting up escrow...");
        const { payerAta, escrowPda, vaultAta } = await setupEscrow({
            milestones: 2,
            unlockOffset: 3600,
        });

        const ix = await program.methods
            .claim()
            .accounts({
                authority:             payer.publicKey,   // wrong — should be recipient
                payer:                 payer.publicKey,
                escrowState:           escrowPda,
                vault:                 vaultAta,
                recipientTokenAccount: payerAta,
                tokenProgram:          TOKEN_PROGRAM_ID,
            })
            .instruction();

        const sig = await sendExpectingFailure(new Transaction().add(ix), payer);
        console.log(`  Signature: ${sig}`);
        console.log(`  Debug:     solana confirm -v ${sig} --url devnet`);
    }

    // ── B: Claim before unlock time ───────────────────────────────────────────────

    section(
        "B — Claim before unlock time",
        "All milestones complete, but the time-lock is 1 hour in the future."
    );
    {
        console.log("  Setting up escrow and completing all milestones...");
        const { recipient, recipientAta, escrowPda, vaultAta } = await setupEscrow({
            milestones: 1,
            unlockOffset: 3600,
            completeMilestones: 1,
        });

        const ix = await program.methods
            .claim()
            .accounts({
                authority:             recipient.publicKey,
                payer:                 payer.publicKey,
                escrowState:           escrowPda,
                vault:                 vaultAta,
                recipientTokenAccount: recipientAta,
                tokenProgram:          TOKEN_PROGRAM_ID,
            })
            .instruction();

        const sig = await sendExpectingFailure(new Transaction().add(ix), payer, [recipient]);
        console.log(`  Signature: ${sig}`);
        console.log(`  Debug:     solana confirm -v ${sig} --url devnet`);
    }

    // ── D: Arbiter approves but time-lock still blocks ────────────────────────────

    section(
        "D — Arbiter approved but time-lock still active",
        "Arbiter sets arbiter_approved=true, but the time-lock is still 1 hour away."
    );
    {
        console.log("  Setting up escrow and completing all milestones...");
        const { recipient, arbiter, recipientAta, escrowPda, vaultAta } = await setupEscrow({
            milestones: 1,
            unlockOffset: 3600,
            completeMilestones: 1,
            fundArbiter: true,
        });

        const approveSig = await program.methods
            .arbiterApprove()
            .accounts({ arbiter: arbiter.publicKey, escrowState: escrowPda })
            .signers([arbiter])
            .rpc();
        console.log(`  ✓ arbiter_approve succeeded — Signature: ${approveSig}`);
        console.log(`    (arbiter_approved is now true, unlock_timestamp is unchanged)`);

        const ix = await program.methods
            .claim()
            .accounts({
                authority:             recipient.publicKey,
                payer:                 payer.publicKey,
                escrowState:           escrowPda,
                vault:                 vaultAta,
                recipientTokenAccount: recipientAta,
                tokenProgram:          TOKEN_PROGRAM_ID,
            })
            .instruction();

        const claimSig = await sendExpectingFailure(new Transaction().add(ix), payer, [recipient]);
        console.log(`  Signature: ${claimSig}`);
        console.log(`  Debug:     solana confirm -v ${claimSig} --url devnet`);
    }

    // ── E: Double cancel ──────────────────────────────────────────────────────────

    section(
        "E — Double cancel",
        "Cancel succeeds the first time. The second cancel should hit AlreadyCancelled."
    );
    {
        console.log("  Setting up escrow...");
        const { payerAta, escrowPda, vaultAta } = await setupEscrow({
            milestones: 2,
            unlockOffset: 3600,
        });

        const cancel1Sig = await program.methods
            .cancel()
            .accounts({
                authority:         payer.publicKey,
                payer:             payer.publicKey,
                escrowState:       escrowPda,
                vault:             vaultAta,
                payerTokenAccount: payerAta,
                tokenProgram:      TOKEN_PROGRAM_ID,
            })
            .rpc();
        console.log(`  ✓ First cancel succeeded — Signature: ${cancel1Sig}`);
        console.log(`    (cancelled=true, vault drained)`);

        const ix = await program.methods
            .cancel()
            .accounts({
                authority:         payer.publicKey,
                payer:             payer.publicKey,
                escrowState:       escrowPda,
                vault:             vaultAta,
                payerTokenAccount: payerAta,
                tokenProgram:      TOKEN_PROGRAM_ID,
            })
            .instruction();

        const cancel2Sig = await sendExpectingFailure(new Transaction().add(ix), payer);
        console.log(`  Signature: ${cancel2Sig}`);
        console.log(`  Debug:     solana confirm -v ${cancel2Sig} --url devnet`);
    }

    // ── F: Incomplete milestones ──────────────────────────────────────────────────

    section(
        "F — Claim with milestones not yet complete",
        "Time-lock has passed, but only 1 of 2 milestones was completed."
    );
    {
        console.log("  Setting up escrow (milestones_required=2, completing only 1)...");
        const { recipient, recipientAta, escrowPda, vaultAta } = await setupEscrow({
            milestones: 2,
            unlockOffset: -10,     // already in the past
            completeMilestones: 1,
        });

        // Small delay to ensure the unlock timestamp is definitely in the past
        await new Promise<void>(r => setTimeout(r, 2_000));

        const ix = await program.methods
            .claim()
            .accounts({
                authority:             recipient.publicKey,
                payer:                 payer.publicKey,
                escrowState:           escrowPda,
                vault:                 vaultAta,
                recipientTokenAccount: recipientAta,
                tokenProgram:          TOKEN_PROGRAM_ID,
            })
            .instruction();

        const sig = await sendExpectingFailure(new Transaction().add(ix), payer, [recipient]);
        console.log(`  Signature: ${sig}`);
        console.log(`  Debug:     solana confirm -v ${sig} --url devnet`);
    }

    console.log("\n=== All failure modes triggered ===\n");
    console.log("For each signature above, run:");
    console.log("  solana confirm -v <signature> --url devnet");
    console.log("  solana logs --filter <program-id>");
    console.log("");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
