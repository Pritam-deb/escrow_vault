import * as anchor from "@coral-xyz/anchor";
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    clusterApiUrl,
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

async function main() {
    // Connect to localnet
    const connection = new Connection("http://localhost:8899", "confirmed");

    // Load your local wallet (the funded one from `solana airdrop`)
    const walletPath = path.join(homedir(), ".config", "solana", "id.json");
    const walletKeypair = Keypair.fromSecretKey(
        Buffer.from(JSON.parse(readFileSync(walletPath, "utf-8")))
    );
    console.log("Wallet:", walletKeypair.publicKey.toBase58());

    // Load the IDL from your build output
    const idl = JSON.parse(
        readFileSync(
            path.join(__dirname, "../target/idl/escrow_vault.json"),
            "utf-8"
        )
    );

    // Your deployed program ID (paste the one from anchor deploy)
    const programId = new PublicKey("9gsQ8cjSoVpK1mi8Shq8wDBTDSJB1rbofCch2pMeRdMv");

    // Set up Anchor provider
    const wallet = new anchor.Wallet(walletKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const program = new anchor.Program(idl, provider);

    // ─── Create actors ───────────────────────────────────────────────────────────

    const payer = walletKeypair; // reuse your funded wallet as payer
    const recipient = Keypair.generate();
    const arbiter = Keypair.generate();

    // Fund recipient and arbiter with a little SOL for rent
    const fundTx = new anchor.web3.Transaction();
    fundTx.add(
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: recipient.publicKey,
            lamports: 100_000_000, // 0.1 SOL
        }),
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: arbiter.publicKey,
            lamports: 100_000_000,
        })
    );
    await provider.sendAndConfirm(fundTx, [payer]);
    console.log("Funded recipient and arbiter");

    // ─── Create SPL mint ─────────────────────────────────────────────────────────

    const mint = await createMint(
        connection,
        payer,           // fee payer
        payer.publicKey, // mint authority
        null,            // freeze authority
        6                // decimals
    );
    console.log("Mint:", mint.toBase58());

    // ─── Create token accounts ───────────────────────────────────────────────────

    const payerAta = await createAssociatedTokenAccount(
        connection,
        payer,
        mint,
        payer.publicKey
    );

    const recipientAta = await createAssociatedTokenAccount(
        connection,
        payer,
        mint,
        recipient.publicKey
    );

    // Mint 1,000,000 tokens to payer
    await mintTo(connection, payer, mint, payerAta, payer, 1_000_000_000_000);
    console.log("Minted tokens to payer ATA:", payerAta.toBase58());

    // ─── Derive escrow PDA ───────────────────────────────────────────────────────

    const [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("escrow"),
            payer.publicKey.toBuffer(),
            mint.toBuffer(),
        ],
        programId
    );
    console.log("Escrow PDA:", escrowPda.toBase58());

    // The vault is an ATA owned by the escrow PDA
    const vaultAta = await getAssociatedTokenAddress(
        mint,
        escrowPda,
        true // allowOwnerOffCurve = true because escrowPda is a PDA
    );
    console.log("Vault ATA:", vaultAta.toBase58());

    // ─── Call initialize_escrow ──────────────────────────────────────────────────

    const unlockTimestamp = Math.floor(Date.now() / 1000) + 10; // 10 seconds from now
    const amount = new anchor.BN(500_000_000_000); // 500,000 tokens
    const milestonesRequired = 2;

    console.log("\nSending initialize_escrow...");

    const initSig = await program.methods
        .initializeEscrow(amount, milestonesRequired, new anchor.BN(unlockTimestamp))
        .accounts({
            payer: payer.publicKey,
            recipient: recipient.publicKey,
            arbiter: arbiter.publicKey,
            mint: mint,
            escrowState: escrowPda,
            vault: vaultAta,
            payerTokenAccount: payerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

    console.log("\n✓ initialize_escrow succeeded");
    console.log("Signature:", initSig);
    console.log("\n→ lykta inspect", initSig, "--cluster localnet");
    console.log("→ lykta diff   ", initSig, "--cluster localnet");

    // ─── Call complete_milestone ─────────────────────────────────────────────────

    console.log("\nSending complete_milestone (1/2)...");

    const m1Sig = await program.methods
        .completeMilestone()
        .accounts({
            recipient: recipient.publicKey,
            escrowState: escrowPda,
        })
        .signers([recipient])
        .rpc();

    console.log("✓ complete_milestone 1 succeeded");
    console.log("Signature:", m1Sig);
    console.log("\n→ lykta diff", m1Sig, "--cluster localnet");

    // ─── Call arbiter_approve ────────────────────────────────────────────────────

    console.log("\nSending arbiter_approve...");

    const approveSig = await program.methods
        .arbiterApprove()
        .accounts({
            arbiter: arbiter.publicKey,
            escrowState: escrowPda,
        })
        .signers([arbiter])
        .rpc();

    console.log("✓ arbiter_approve succeeded");
    console.log("Signature:", approveSig);
    console.log("\n→ lykta diff", approveSig, "--cluster localnet");

    // ─── Trigger a failure: wrong signer on complete_milestone ───────────────────

    console.log("\nTriggering failure: wrong signer on complete_milestone...");

    try {
        const badActor = Keypair.generate();
        await provider.sendAndConfirm(
            new anchor.web3.Transaction().add(
                await program.methods
                    .completeMilestone()
                    .accounts({
                        recipient: badActor.publicKey,
                        escrowState: escrowPda,
                    })
                    .instruction()
            ),
            [badActor]
        );
    } catch (e: any) {
        // Extract the transaction signature from the error
        const failedSig = e?.transactionMessage?.signatures?.[0]
            ?? e?.signature
            ?? "check your local validator logs";

        console.log("✓ Failed as expected:", e.message?.slice(0, 80));
        console.log("Failed tx signature:", failedSig);
        console.log("\n→ lykta error  ", failedSig, "--cluster localnet");
        console.log("→ lykta inspect", failedSig, "--cluster localnet");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});