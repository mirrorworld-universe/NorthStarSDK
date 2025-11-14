use anchor_lang::prelude::*;
use solana_hash::Hash;

/// OutboxPDA - Append-only ring buffer for routing intents to Sonic
/// Maintains a Merkle root over all entries for verification
/// 
/// The Merkle root is computed using an incremental hash chain:
/// - First entry: hash([0u8; 32] || entry_hash)
/// - Subsequent entries: hash(prev_merkle_root || entry_hash)
/// 
/// This ensures the entire history of entries is cryptographically
/// committed in the root, allowing verification of all previous entries.
#[account]
pub struct Outbox {
    /// Authority that can append to this outbox
    pub authority: Pubkey,
    /// Total number of entries committed
    pub entry_count: u64,
    /// Merkle root over all entries (for verification)
    /// This is an incremental hash chain: hash(prev_root || entry_hash)
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

    /// Update the Merkle root with a new entry hash.
    /// 
    /// Implements incremental hash chain: hash(prev_merkle_root || entry_hash)
    /// 
    /// # Arguments
    /// * `entry_hash` - Hash of the new outbox entry
    /// 
    /// # Returns
    /// The new Merkle root as a Hash
    pub fn update_merkle_root(&mut self, entry_hash: Hash) -> Hash {
        let mut hasher = solana_sha256_hasher::Hasher::default();
        
        // Hash previous merkle root concatenated with new entry hash
        // This creates an incremental hash chain that commits to all previous entries
        hasher.hashv(&[
            &self.merkle_root,        // Previous merkle root (or [0u8; 32] for first entry)
            entry_hash.as_ref(),      // New entry hash
        ]);
        
        let new_root = hasher.result();
        self.merkle_root = new_root.to_bytes();
        
        new_root
    }
}
