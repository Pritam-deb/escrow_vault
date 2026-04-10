use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::{errors::EscrowError, state::EscrowState};

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub authority: Signer<'info>,

    /// CHECK: payer used for PDA seeds and receiving refund
    #[account(mut)]
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
        associated_token::authority = payer,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Cancel>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow_state;

    // Check order: already cancelled → not authorized → milestones started
    require!(!escrow.cancelled, EscrowError::AlreadyCancelled);

    let authority_key = ctx.accounts.authority.key();
    require!(
        authority_key == escrow.payer || authority_key == escrow.arbiter,
        EscrowError::NotAuthorizedToCancel
    );

    require!(
        escrow.milestones_completed == 0,
        EscrowError::MilestonesNotComplete
    );

    // Mark as cancelled BEFORE the CPI (prevents re-entrancy pattern)
    escrow.cancelled = true;

    let vault_balance = ctx.accounts.vault.amount;

    if vault_balance > 0 {
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
                    to: ctx.accounts.payer_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_state.to_account_info(),
                },
                signer_seeds,
            ),
            vault_balance,
        )?;
    }

    msg!("Escrow cancelled. {} tokens refunded to payer.", vault_balance);
    Ok(())
}