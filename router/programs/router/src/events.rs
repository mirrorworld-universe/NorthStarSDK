use std::num::NonZero;

use anchor_lang::prelude::*;

use crate::types::SonicMsgInner;

/// Event emitted when a new session is opened
#[event]
pub struct SessionOpened {
    /// Session PDA address
    pub session: Pubkey,
    /// Session owner
    pub owner: Pubkey,
    /// Target grid ID
    pub grid_id: u64,
    /// Time-to-live in slots
    pub ttl_slots: NonZero<u64>,
    /// Fee cap for the session
    pub fee_cap: NonZero<u64>,
}

/// Event emitted when an entry is committed to the outbox
#[event]
pub struct EntryCommitted {
    /// Unique entry identifier (hash)
    // XXX: once anchor upgrades to borsh v1 use `solana_hash::Hash`
    pub entry_id: [u8; 32],
    /// Associated session
    pub session: Pubkey,
    /// The Sonic message
    pub msg: SonicMsgInner,
    /// Fee budget allocated for this entry
    pub fee_budget: u64,
    /// Entry index in outbox
    pub entry_index: u64,
}

/// Event emitted when a session is closed
#[event]
pub struct SessionClosed {
    /// Session that was closed
    pub session: Pubkey,
    /// Owner that received the refund
    pub owner: Pubkey,
    /// Amount refunded
    pub refund_amount: u64,
}
