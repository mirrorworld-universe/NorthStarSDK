use anchor_lang::prelude::*;

/// OutboxPDA - Append-only ring buffer for routing intents to Sonic
/// Maintains a Merkle root over all entries for verification
#[account]
pub struct Outbox {
    /// Authority that can append to this outbox
    pub authority: Pubkey,
    /// Total number of entries committed
    pub entry_count: u64,
    /// Merkle root over all entries (for verification)
    // XXX: once anchor upgrades to borsh v1 use `solana_hash::Hash`
    pub merkle_root: [u8; 32],
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl Outbox {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        8 + // entry_count
        32 + // merkle_root
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = b"outbox";
}
