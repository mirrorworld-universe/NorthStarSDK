use std::num::NonZero;

use anchor_lang::prelude::*;

use crate::{
    errors::RouterError,
    events::SessionOpened,
    state::{FeeVault, Session},
    types::EmbeddedOpcode,
};

#[derive(Accounts)]
#[instruction(grid_id: u64)]
pub struct OpenSession<'info> {
    #[account(
        init,
        payer = owner,
        space = Session::LEN,
        seeds = [
            Session::SEED_PREFIX,
            owner.key().as_ref(),
            &grid_id.to_le_bytes()
        ],
        bump
    )]
    pub session: Account<'info, Session>,

    #[account(
        init,
        payer = owner,
        space = FeeVault::LEN,
        seeds = [
            FeeVault::SEED_PREFIX,
            owner.key().as_ref()
        ],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Open a new session for Sonic Grid operations
impl<'info> OpenSession<'info> {
    pub fn open_session(
        &mut self,
        grid_id: u64,
        allowed_programs: Vec<Pubkey>,
        allowed_opcodes: Vec<EmbeddedOpcode>,
        ttl_slots: NonZero<u64>,
        fee_cap: NonZero<u64>,
    ) -> Result<()> {
        // Validate input sizes
        require!(
            allowed_programs.len() <= Session::MAX_ALLOWED_PROGRAMS,
            RouterError::TooManyAllowedPrograms
        );
        require!(
            allowed_opcodes.len() <= Session::MAX_ALLOWED_OPCODES,
            RouterError::TooManyAllowedOpcodes
        );

        // Initialize session
        self.session.set_inner(Session {
            owner: self.owner.key(),
            grid_id,
            allowed_programs,
            allowed_opcodes,
            ttl_slots,
            fee_cap,
            nonce: 0,
            created_at: Clock::get()?.slot,
            bump: self.session.bump,
        });

        // Initialize fee vault
        self.fee_vault.set_inner(FeeVault {
            authority: self.owner.key(),
            balance: 0,
            bump: self.fee_vault.bump,
        });

        // Emit event
        emit!(SessionOpened {
            session: self.session.key(),
            owner: self.session.owner,
            grid_id: self.session.grid_id,
            ttl_slots: self.session.ttl_slots,
            fee_cap: self.session.fee_cap,
        });

        Ok(())
    }
}
