use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    pub payer:                Pubkey,   // 32 bytes
    pub recipient:            Pubkey,   // 32 bytes
    pub arbiter:              Pubkey,   // 32 bytes
    pub mint:                 Pubkey,   // 32 bytes
    pub vault:                Pubkey,   // 32 bytes — ATA address, stored for convenience
    pub amount:               u64,      // 8 bytes
    pub milestones_required:  u8,       // 1 byte
    pub milestones_completed: u8,       // 1 byte
    pub unlock_timestamp:     i64,      // 8 bytes
    pub arbiter_approved:     bool,     // 1 byte
    pub cancelled:            bool,     // 1 byte
    pub bump:                 u8,       // 1 byte
}