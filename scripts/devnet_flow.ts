import * as anchor from "@coral-xyz/anchor";
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
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

function lyktaCmd(sig: string, command: "inspect" | "diff" | "error" = "inspect") {
    return `lykta ${command} ${sig} --cluster devnet`;
}

async function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log("\n=== Lykta Demo: escrow_vault devnet flow ===\n");

    const walletPath = path.join(homedir(), ".config", "solana", "id.json");
    const walletKeypair = Keypair.fromSecretKey(
        Buffer.from(JSON.parse(readFileSync(walletPath, "utf-8")))
    );
    console.log("Wallet:", walletKeypair.publicKey.toBase58());

    const wallet = new anchor.Wallet(walletKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const idl = JSON.parse(
        readFileSync(path.join(__dirname, "../target/idl/escrow_vault.json"), "utf-8")
    );
    const programId = new PublicKey(idl.address);
    const program = new anchor.Program(idl, provider);

    const payer     = walletKeypair;
    const recipient = Keypair.generate();
    const arbiter   = Keypair.generate();

    const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: recipient.publicKey,
            lamports: 0.1 * LAMPORTS_PER_SOL,
        }),
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: arbiter.publicKey,
            lamports: 0.1 * LAMPORTS_PER_SOL,
        })
    );
    await provider.sendAndConfirm(fundTx, [payer]);
    console.log("Funded recipient and arbiter");

    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    console.log("Mint:", mint.toBase58());

    const payerAta     = await createAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    const recipientAta = await createAssociatedTokenAccount(connection, payer, mint, recipient.publicKey);
    await mintTo(connection, payer, mint, payerAta, payer, 1_000_000_000_000);
    console.log("Minted tokens to payer ATA:", payerAta.toBase58());

    const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), payer.publicKey.toBuffer(), mint.toBuffer()],
        programId
    );
    const vaultAta = await getAssociatedTokenAddress(mint, escrowPda, true);
    console.log("Escrow PDA:", escrowPda.toBase58());
    console.log("Vault ATA: ", vaultAta.toBase58());

    // ── 1. initialize_escrow ──────────────────────────────────────────────────────
    console.log("\nSending initialize_escrow...");
    const unlockAt = Math.floor(Date.now() / 1000) + 10;

    const initSig = await program.methods
        .initializeEscrow(new anchor.BN(500_000_000_000), 2, new anchor.BN(unlockAt))
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
    console.log("\n✓ initialize_escrow succeeded");
    console.log("Signature:", initSig);
    console.log(`\n→ ${lyktaCmd(initSig, "inspect")}`);
    console.log(`→ ${lyktaCmd(initSig, "diff")}`);

    // ── 2. complete_milestone 1 ───────────────────────────────────────────────────
    console.log("\nSending complete_milestone (1/2)...");
    const m1Sig = await program.methods
        .completeMilestone()
        .accounts({ recipient: recipient.publicKey, escrowState: escrowPda })
        .signers([recipient])
        .rpc();
    console.log("✓ complete_milestone 1 succeeded");
    console.log("Signature:", m1Sig);
    console.log(`\n→ ${lyktaCmd(m1Sig, "diff")}`);

    // ── 3. complete_milestone 2 ───────────────────────────────────────────────────
    console.log("\nSending complete_milestone (2/2)...");
    const m2Sig = await program.methods
        .completeMilestone()
        .accounts({ recipient: recipient.publicKey, escrowState: escrowPda })
        .signers([recipient])
        .rpc();
    console.log("✓ complete_milestone 2 succeeded");
    console.log("Signature:", m2Sig);
    console.log(`\n→ ${lyktaCmd(m2Sig, "diff")}`);

    // ── 4. Wait for time-lock ─────────────────────────────────────────────────────
    console.log("\nWaiting 12 seconds for time-lock to expire...");
    await sleep(12_000);

    // ── 5. claim ─────────────────────────────────────────────────────────────────
    console.log("\nSending claim...");
    const claimSig = await program.methods
        .claim()
        .accounts({
            authority:             recipient.publicKey,
            payer:                 payer.publicKey,
            escrowState:           escrowPda,
            vault:                 vaultAta,
            recipientTokenAccount: recipientAta,
            tokenProgram:          TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
    console.log("✓ claim succeeded");
    console.log("Signature:", claimSig);
    console.log(`\n→ ${lyktaCmd(claimSig, "inspect")}`);
    console.log(`→ ${lyktaCmd(claimSig, "diff")}`);

    console.log("\n=== Happy path complete ===\n");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
