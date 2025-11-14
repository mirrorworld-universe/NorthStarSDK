use anchor_lang::prelude::*;

use crate::{
    errors::RouterError,
    events::EntryCommitted,
    state::{FeeVault, Outbox, Session},
    types::{OutboxEntry, SonicMsg, SonicMsgInner},
};

#[derive(Accounts)]
#[instruction(grid_id: u64, msg: SonicMsg)]
pub struct SendMessage<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = Outbox::LEN,
        seeds = [
            Outbox::SEED_PREFIX,
            owner.key().as_ref()
        ],
        bump
    )]
    pub outbox: Account<'info, Outbox>,

    #[account(
        mut,
        seeds = [
            Session::SEED_PREFIX,
            owner.key().as_ref(),
            &grid_id.to_le_bytes()
        ],
        bump
    )]
    pub session: Account<'info, Session>,

    #[account(
        mut,
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

impl<'info> SendMessage<'info> {
    pub fn send_message(&mut self, msg: SonicMsg, fee_budget: u64) -> Result<()> {
        if self.outbox.authority == Pubkey::default() {
            self.outbox.set_inner(Outbox {
                authority: self.owner.key(),
                entry_count: 0,
                merkle_root: [0u8; 32],
                bump: self.outbox.bump,
            });
        }

        require!(
            self.outbox.authority == self.owner.key(),
            RouterError::UnauthorizedProgram
        );

        let clock = Clock::get()?;

        // Validate grid_id matches session
        require!(
            msg.grid_id == self.session.grid_id,
            RouterError::InvalidGridId
        );

        // Validate session ownership
        require!(
            self.session.owner == self.owner.key(),
            RouterError::UnauthorizedProgram
        );

        // Check session hasn't expired
        require!(
            !self.session.is_expired(clock.slot),
            RouterError::SessionExpired
        );

        // Validate nonce matches message nonce
        require!(msg.nonce == self.session.nonce, RouterError::InvalidNonce);

        // Check fee budget doesn't exceed session fee cap
        require!(
            fee_budget <= self.session.fee_cap.get(),
            RouterError::FeeCapExceeded
        );

        // Check sufficient balance in fee vault
        require!(
            self.fee_vault.has_sufficient_balance(fee_budget),
            RouterError::InsufficientFees
        );

        // Validate allowed programs/opcodes based on message kind
        match msg.inner {
            SonicMsgInner::InvokeCall {
                target_program,
                accounts: _,
                data: _,
            } => require!(
                self.session.is_program_allowed(&target_program),
                RouterError::UnauthorizedProgram
            ),
            SonicMsgInner::EmbeddedOpcode { opcode, params: _ } => require!(
                self.session.is_opcode_allowed(opcode),
                RouterError::UnauthorizedOpcode
            ),
        }

        // Create outbox entry
        let entry = OutboxEntry {
            owner: self.session.owner,
            session: self.session.key(),
            fee_budget,
            msg: msg.clone(),
            // TODO: add signing
            sig: [0u8; 64],
        };

        // Compute entry hash
        let entry_id = entry.hash();
        
        // Update Merkle root using incremental hash chain
        // This implements: hash(prev_merkle_root || entry_hash)
        // This ensures the entire history of entries is cryptographically
        // committed in the root, allowing verification of all previous entries.
        self.outbox.update_merkle_root(entry_id);

        // Deduct fee from vault
        self.fee_vault.withdraw(fee_budget)?;

        // Increment session nonce
        self.session.nonce = self
            .session
            .nonce
            .checked_add(1)
            .expect("Realistically never overflows within realistic `ttl_slots`");

        // Emit event
        emit!(EntryCommitted {
            entry_id: entry_id.to_bytes(),
            session: self.session.key(),
            msg: msg.clone(),
            fee_budget,
            entry_index: self.outbox.entry_count,
        });

        // Update outbox
        self.outbox.entry_count = self
            .outbox
            .entry_count
            .checked_add(1)
            .ok_or(RouterError::ArithmeticOverflow)?;

        msg!("Entry committed: {}", entry_id);
        msg!("Nonce incremented to: {}", self.session.nonce);

        Ok(())
    }
}
