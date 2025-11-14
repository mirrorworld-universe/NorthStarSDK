use std::num::NonZero;

use anchor_lang::prelude::*;

use crate::types::EmbeddedOpcode;

/// SessionPDA - Per-user session with access control and fee management
/// Controls which programs/opcodes can be executed and manages fee budget
#[account]
pub struct Session {
    /// Owner of this session
    pub owner: Pubkey,
    /// Target Sonic Grid ID
    pub grid_id: u64,
    /// Whitelisted programs that can be called
    pub allowed_programs: Vec<Pubkey>,
    /// Whitelisted embedded opcodes
    // XXX: this can be bitmap
    pub allowed_opcodes: Vec<EmbeddedOpcode>,
    /// Time-to-live in slots
    pub ttl_slots: NonZero<clock::Slot>,
    /// Maximum fee budget for this session
    pub fee_cap: NonZero<u64>,
    /// Current nonce (for replay protection)
    pub nonce: u128,
    /// Creation slot
    pub created_at: clock::Slot,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl Session {
    pub const MAX_ALLOWED_PROGRAMS: usize = 10;
    pub const MAX_ALLOWED_OPCODES: usize = 10;

    pub const LEN: usize = 8 + // discriminator
        32 + // owner
        8 + // grid_id
        4 + (32 * Self::MAX_ALLOWED_PROGRAMS) + // allowed_programs (Vec with max size)
        4 + (EmbeddedOpcode::SIZE * Self::MAX_ALLOWED_OPCODES) + // allowed_opcodes (Vec with max size)
        8 + // ttl_slots
        8 + // fee_cap
        16 + // nonce (u128)
        8 + // created_at
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = b"session";

    /// Check if session is expired
    pub fn is_expired(&self, current_slot: u64) -> bool {
        current_slot > self.created_at.saturating_add(self.ttl_slots.get())
    }
    /// Check if program is allowed
    pub fn is_program_allowed(&self, program: &Pubkey) -> bool {
        self.allowed_programs.is_empty() || self.allowed_programs.contains(program)
    }

    /// Check if opcode is allowed
    pub fn is_opcode_allowed(&self, opcode: EmbeddedOpcode) -> bool {
        self.allowed_opcodes.is_empty() || self.allowed_opcodes.contains(&opcode)
    }
}
