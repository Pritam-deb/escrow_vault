use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Caller is not the designated recipient")]
    NotRecipient,                  // 6000

    #[msg("Caller is not the designated arbiter")]
    NotArbiter,                    // 6001

    #[msg("Caller is not authorized to cancel")]
    NotAuthorizedToCancel,         // 6002

    #[msg("Escrow has been cancelled")]
    EscrowCancelled,               // 6003

    #[msg("Required milestones not yet completed")]
    MilestonesNotComplete,         // 6004

    #[msg("Unlock time has not been reached")]
    UnlockTimeNotReached,          // 6005

    #[msg("Arbiter has not approved early release")]
    ArbiterNotApproved,            // 6006

    #[msg("Escrow is already cancelled")]
    AlreadyCancelled,              // 6007

    #[msg("All milestones are already complete")]
    MilestoneAlreadyComplete,      // 6008

    #[msg("Vault has no tokens to release")]
    VaultEmpty,                    // 6009
}