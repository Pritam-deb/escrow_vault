use anchor_lang::prelude::*;

declare_id!("9gsQ8cjSoVpK1mi8Shq8wDBTDSJB1rbofCch2pMeRdMv");

#[program]
pub mod escrow_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
