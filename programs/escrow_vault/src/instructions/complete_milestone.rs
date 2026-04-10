use anchor_lang::prelude::*;
use crate::{errors::EscrowError, state::EscrowState};

#[derive(Accounts)]
pub struct CompleteMilestone<'info> {
    pub recipient: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.payer.as_ref(), escrow_state.mint.as_ref()],
        bump = escrow_state.bump,
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

pub fn handler(ctx: Context<CompleteMilestone>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow_state;

    require!(!escrow.cancelled, EscrowError::EscrowCancelled);

    require!(
        escrow.recipient == ctx.accounts.recipient.key(),
        EscrowError::NotRecipient
    );

    require!(
        escrow.milestones_completed < escrow.milestones_required,
        EscrowError::MilestoneAlreadyComplete
    );

    escrow.milestones_completed += 1;

    msg!(
        "Milestone completed: {}/{}",
        escrow.milestones_completed,
        escrow.milestones_required
    );

    Ok(())
}