use anchor_lang::prelude::*;
use solana_hash::Hash;

use crate::{
    errors::RouterError,
    events::EntryCommitted,
    state::{FeeVault, Outbox, Session},
    types::{SonicMsg, SonicMsgInner},
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
    pub fn send_message(&mut self, grid_id: u64, msg: SonicMsg, fee_budget: u64) -> Result<()> {
        let clock = Clock::get()?;

        // Validate grid_id matches session
        require!(grid_id == self.session.grid_id, RouterError::InvalidGridId);

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
            SonicMsgInner::MirrorL1Accounts { accounts: _ } => (),
        }

        // Compute entry hash
        let entry_id = Hash::default(); // TODO: add merkle root

        // Lazy initialize outbox if needed
        if self.outbox.authority == Pubkey::default() {
            self.outbox.set_inner(Outbox {
                authority: self.owner.key(),
                entry_count: 0,
                merkle_root: entry_id.to_bytes(),
                bump: self.outbox.bump,
            });
        } else {
            self.outbox.merkle_root = entry_id.to_bytes();
        }

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
            msg: msg.inner.clone(),
            fee_budget,
            entry_index: self.outbox.entry_count,
        });

        // Update outbox
        self.outbox.entry_count = self
            .outbox
            .entry_count
            .checked_add(1)
            .ok_or(RouterError::ArithmeticOverflow)?;

        msg!("Entry committed: {entry_id}");
        msg!("Nonce incremented to: {}", self.session.nonce);

        Ok(())
    }
}
