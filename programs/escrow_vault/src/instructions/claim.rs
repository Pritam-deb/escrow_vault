use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::{errors::EscrowError, state::EscrowState};

#[derive(Accounts)]
pub struct Claim<'info> {
    pub authority: Signer<'info>,

    /// CHECK: payer stored in escrow, only used for PDA seeds
    pub payer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"escrow", payer.key().as_ref(), escrow_state.mint.as_ref()],
        bump = escrow_state.bump,
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        associated_token::mint = escrow_state.mint,
        associated_token::authority = escrow_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = escrow_state.mint,
        associated_token::authority = authority,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let escrow = &ctx.accounts.escrow_state;

    // Check order matters — determines which error appears for each failure
    // Lykta will show whichever require! fires first

    // 1. Not cancelled
    require!(!escrow.cancelled, EscrowError::EscrowCancelled);

    // 2. Correct signer
    require!(
        escrow.recipient == ctx.accounts.authority.key(),
        EscrowError::NotRecipient
    );

    // 3. Milestones + time OR arbiter approval
    let clock = Clock::get()?;
    let milestones_done = escrow.milestones_completed >= escrow.milestones_required;
    let time_passed = clock.unix_timestamp >= escrow.unlock_timestamp;
    let early_approved = escrow.arbiter_approved;

    require!(
        (milestones_done && time_passed) || early_approved,
        if !milestones_done {
            EscrowError::MilestonesNotComplete
        } else {
            EscrowError::UnlockTimeNotReached
        }
    );

    // 4. Vault has tokens
    let vault_balance = ctx.accounts.vault.amount;
    require!(vault_balance > 0, EscrowError::VaultEmpty);

    // Transfer vault → recipient via invoke_signed (escrow PDA is the authority)
    let payer_key = escrow.payer;
    let mint_key = escrow.mint;
    let bump = escrow.bump;
    let seeds = &[
        b"escrow",
        payer_key.as_ref(),
        mint_key.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.escrow_state.to_account_info(),
            },
            signer_seeds,
        ),
        vault_balance,
    )?;

    msg!("Claim successful. {} tokens transferred to recipient.", vault_balance);
    Ok(())
}