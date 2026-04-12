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

function section(label: string) {
    console.log("\n" + "=".repeat(60));
    console.log(`  FAILURE MODE: ${label}`);
    console.log("=".repeat(60));
}

function lyktaCmd(sig: string) {
    return `  lykta error ${sig} --cluster devnet\n  lykta inspect ${sig} --cluster devnet`;
}

// Sends a transaction with skipPreflight so it lands on-chain even when it
// fails, giving us a real signature that Lykta can inspect.
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

    console.log("\n=== Lykta Demo: escrow_vault failure modes ===\n");
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

    section("A — Wrong signer on claim");
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
        console.log(`  Expected: NotRecipient (6000)`);
        console.log(`  Signature: ${sig}`);
        console.log(lyktaCmd(sig));
    }

    // ── B: Claim before unlock time ───────────────────────────────────────────────

    section("B — Claim before unlock time");
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
        console.log(`  Expected: UnlockTimeNotReached (6005)`);
        console.log(`  Signature: ${sig}`);
        console.log(lyktaCmd(sig));
    }

    // ── C: Bad PDA bump (depth-2 CPI failure) ────────────────────────────────────

    section("C — Bad PDA bump (depth-2 CPI failure)");
    console.log("  [Not executable from the TS client against the current program]");
    console.log("");
    console.log("  Why: the program reads bump from escrow_state.bump at runtime and always");
    console.log("  uses that value in invoke_signed. There is no client-provided bump");
    console.log("  parameter to corrupt. Triggering this requires temporarily patching");
    console.log("  claim.rs to use a hardcoded wrong bump (e.g. 255), rebuilding, and");
    console.log("  redeploying. When triggered, Lykta shows a depth-2 CPI tree where the");
    console.log("  SPL Token node is red with PrivilegeEscalation — the computed PDA from");
    console.log("  the wrong seeds doesn't match the vault's stored authority.");

    // ── D: Arbiter approves but time-lock still blocks ────────────────────────────

    section("D — Arbiter approved but time-lock still active");
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
        console.log(`  ✓ arbiter_approve succeeded`);
        console.log(`  Signature: ${approveSig}`);
        console.log(`    lykta diff ${approveSig} --cluster devnet`);
        console.log(`    (shows: arbiter_approved false → true, unlock_timestamp unchanged)`);

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
        console.log(`\n  Expected: UnlockTimeNotReached (6005)`);
        console.log(`  Signature: ${claimSig}`);
        console.log(`  Lykta: compare approve diff (flag set) vs claim error (time not cleared)`);
        console.log(lyktaCmd(claimSig));
    }

    // ── E: Double cancel ──────────────────────────────────────────────────────────

    section("E — Double cancel");
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
        console.log(`  ✓ First cancel succeeded`);
        console.log(`  Signature: ${cancel1Sig}`);
        console.log(`    lykta diff ${cancel1Sig} --cluster devnet`);
        console.log(`    (shows: vault → 0, cancelled: false → true)`);

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
        console.log(`\n  Expected: AlreadyCancelled (6007)`);
        console.log(`  Signature: ${cancel2Sig}`);
        console.log(`  Lykta: no account diffs on 2nd call — state already cancelled, nothing changed`);
        console.log(lyktaCmd(cancel2Sig));
    }

    // ── F: Incomplete milestones ──────────────────────────────────────────────────

    section("F — Claim with milestones not yet complete");
    {
        console.log("  Setting up escrow (milestones_required=2, completing only 1)...");
        const { recipient, recipientAta, escrowPda, vaultAta } = await setupEscrow({
            milestones: 2,
            unlockOffset: -10,
            completeMilestones: 1,
        });

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
        console.log(`  Expected: MilestonesNotComplete (6004)`);
        console.log(`  Signature: ${sig}`);
        console.log(`  Lykta: account diff shows milestones_completed=1, milestones_required=2`);
        console.log(lyktaCmd(sig));
    }

    console.log("\n=== All failure modes triggered ===\n");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
