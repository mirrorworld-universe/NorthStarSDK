use anchor_lang::prelude::*;

use crate::{
    errors::RouterError,
    events::EntryCommitted,
    state::{FeeVault, Outbox, Session},
    types::{MsgKind, OutboxEntry, SonicMsg},
};

#[derive(Accounts)]
pub struct InitOutbox<'info> {
    #[account(
        init,
        payer = owner,
        space = Outbox::LEN,
        seeds = [
            Outbox::SEED_PREFIX,
            owner.key().as_ref()
        ],
        bump
    )]
    pub outbox: Account<'info, Outbox>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> InitOutbox<'info> {
    pub fn init_outbox(&mut self) -> Result<()> {
        self.outbox.set_inner(Outbox {
            authority: self.owner.key(),
            entry_count: 0,
            merkle_root: [0u8; 32],
            bump: self.outbox.bump,
        });

        msg!("Outbox initialized for: {}", self.owner.key());

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(grid_id: u64, msg: SonicMsg)]
pub struct SendMessage<'info> {
    #[account(
        mut,
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
            fee_budget <= self.session.fee_cap,
            RouterError::FeeCapExceeded
        );

        // Check sufficient balance in fee vault
        require!(
            self.fee_vault.has_sufficient_balance(fee_budget),
            RouterError::InsufficientFees
        );

        // Validate allowed programs/opcodes based on message kind
        match msg.kind {
            MsgKind::Invoke => {
                if let Some(ref invoke) = msg.invoke {
                    require!(
                        self.session.is_program_allowed(&invoke.target_program),
                        RouterError::UnauthorizedProgram
                    );
                }
            }
            MsgKind::Embedded => {
                if let Some(ref opcode) = msg.opcode {
                    let opcode_byte = match opcode {
                        crate::types::EmbeddedOpcode::Swap => 0,
                    };
                    require!(
                        self.session.is_opcode_allowed(opcode_byte),
                        RouterError::UnauthorizedOpcode
                    );
                }
            }
        }

        // Create outbox entry
        let entry = OutboxEntry {
            owner: self.session.owner,
            session: self.session.key(),
            fee_budget,
            msg: msg.clone(),
            sig: [0u8; 64],
        };

        // Compute entry hash
        // XXX: store hashes once anchor upgrades to borsh v1
        // https://github.com/solana-foundation/anchor/pull/4012
        let entry_id = entry.hash().to_bytes();

        // Update outbox
        self.outbox.entry_count = self
            .outbox
            .entry_count
            .checked_add(1)
            .ok_or(RouterError::ArithmeticOverflow)?;

        // Update Merkle root
        self.outbox.merkle_root = entry_id;

        // Deduct fee from vault
        self.fee_vault.withdraw(fee_budget)?;

        // Increment session nonce
        self.session.nonce = self
            .session
            .nonce
            .checked_add(1)
            .ok_or(RouterError::ArithmeticOverflow)?;

        // Emit event
        emit!(EntryCommitted {
            entry_id,
            session: self.session.key(),
            msg: msg.clone(),
            fee_budget,
            entry_index: self.outbox.entry_count - 1,
        });

        msg!("Entry committed: {:?}", entry_id);
        msg!("Nonce incremented to: {}", self.session.nonce);

        Ok(())
    }
}
