use anchor_lang::prelude::*;
use crate::{errors::EscrowError, state::EscrowState};

#[derive(Accounts)]
pub struct ArbiterApprove<'info> {
    pub arbiter: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.payer.as_ref(), escrow_state.mint.as_ref()],
        bump = escrow_state.bump,
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

pub fn handler(ctx: Context<ArbiterApprove>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow_state;

    require!(!escrow.cancelled, EscrowError::EscrowCancelled);

    require!(
        escrow.arbiter == ctx.accounts.arbiter.key(),
        EscrowError::NotArbiter
    );

    // Set the approval flag
    // NOTE: We deliberately do NOT reset unlock_timestamp here.
    // This means arbiter_approved = true alone is NOT enough to claim —
    // the time-lock still applies. This is failure mode #4.
    escrow.arbiter_approved = true;

    msg!("Arbiter approved early release.");
    Ok(())
}