use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("9gsQ8cjSoVpK1mi8Shq8wDBTDSJB1rbofCch2pMeRdMv");


#[program]
pub mod escrow_vault {
    use super::*;

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        amount: u64,
        milestones_required: u8,
        unlock_timestamp: i64,
    ) -> Result<()> {
        initialize::handler(ctx, amount, milestones_required, unlock_timestamp)
    }

    // pub fn complete_milestone(ctx: Context<CompleteMilestone>) -> Result<()> {
    //     instructions::complete_milestone::handler(ctx)
    // }

    // pub fn claim(ctx: Context<Claim>) -> Result<()> {
    //     instructions::claim::handler(ctx)
    // }

    // pub fn arbiter_approve(ctx: Context<ArbiterApprove>) -> Result<()> {
    //     instructions::arbiter_approve::handler(ctx)
    // }

    // pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    //     instructions::cancel::handler(ctx)
    // }
}