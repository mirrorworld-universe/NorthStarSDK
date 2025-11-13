use anchor_lang::prelude::*;

declare_id!("J6YB6HFjFecHKRvgfWwqa6sAr2DhR2k7ArvAd6NG7mBo");

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod types;

use instructions::*;
use types::*;

#[program]
pub mod router {
    use super::*;

    /// Open a new session for Sonic Grid operations
    /// Creates SessionPDA and FeeVaultPDA for the user
    pub fn open_session(
        ctx: Context<OpenSession>,
        grid_id: u64,
        allowed_programs: Vec<Pubkey>,
        allowed_opcodes: Vec<EmbeddedOpcode>,
        ttl_slots: u64,
        fee_cap: u64,
    ) -> Result<()> {
        ctx.accounts.open_session(
            grid_id,
            allowed_programs,
            allowed_opcodes,
            ttl_slots,
            fee_cap,
        )
    }

    /// Initialize an outbox for the user
    pub fn init_outbox(ctx: Context<InitOutbox>) -> Result<()> {
        ctx.accounts.init_outbox()
    }

    /// Deposit fees into the fee vault
    pub fn deposit_fee(ctx: Context<DepositFee>, amount: u64) -> Result<()> {
        ctx.accounts.deposit_fee(amount)
    }

    /// Send a message to Sonic Grid
    /// Commits an intent to the OutboxPDA for relaying to Sonic
    pub fn send_message(
        ctx: Context<SendMessage>,
        grid_id: u64,
        msg: SonicMsg,
        fee_budget: u64,
    ) -> Result<()> {
        ctx.accounts.send_message(msg, fee_budget)
    }

    /// Close an expired session and refund unused fees
    pub fn close_expired(ctx: Context<CloseExpired>, grid_id: u64) -> Result<()> {
        ctx.accounts.close_expired()
    }
}
