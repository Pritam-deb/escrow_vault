use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use crate::state::EscrowState;

#[derive(Accounts)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: recipient is just stored, not validated here
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: arbiter is just stored, not validated here
    pub arbiter: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [b"escrow", payer.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = escrow_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeEscrow>,
    amount: u64,
    milestones_required: u8,
    unlock_timestamp: i64,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow_state;

    // Store all escrow parameters
    escrow.payer = ctx.accounts.payer.key();
    escrow.recipient = ctx.accounts.recipient.key();
    escrow.arbiter = ctx.accounts.arbiter.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.vault = ctx.accounts.vault.key();
    escrow.amount = amount;
    escrow.milestones_required = milestones_required;
    escrow.milestones_completed = 0;
    escrow.unlock_timestamp = unlock_timestamp;
    escrow.arbiter_approved = false;
    escrow.cancelled = false;
    escrow.bump = ctx.bumps.escrow_state;

    // Transfer tokens from payer → vault (CPI to SPL Token program)
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        amount,
    )?;

    msg!("Escrow initialized. Vault funded with {} tokens.", amount);
    Ok(())
}