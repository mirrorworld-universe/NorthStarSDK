use anchor_lang::prelude::*;

use crate::{
    errors::RouterError,
    events::SessionClosed,
    state::{FeeVault, Session},
};

#[derive(Accounts)]
#[instruction(grid_id: u64)]
pub struct CloseExpired<'info> {
    #[account(
        mut,
        close = owner,
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
        close = owner,
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

impl<'info> CloseExpired<'info> {
    pub fn close_expired(&mut self) -> Result<()> {
        let clock = Clock::get()?;

        // Verify session has expired
        require!(
            self.session.is_expired(clock.slot),
            RouterError::SessionStillActive
        );

        // Verify ownership
        require!(
            self.session.owner == self.owner.key(),
            RouterError::UnauthorizedProgram
        );

        let refund_amount = self.fee_vault.balance;

        // Transfer SOL from fee vault to owner
        let transfer_ix =
            system_instruction::transfer(&self.fee_vault.key(), &self.owner.key(), refund_amount);
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                self.fee_vault.to_account_info(),
                self.owner.to_account_info(),
                self.system_program.to_account_info(),
            ],
        )?;

        // Emit event before closing
        emit!(SessionClosed {
            session: self.session.key(),
            owner: self.session.owner,
            refund_amount,
        });

        msg!("Session closed: {}", self.session.key());
        msg!(
            "Refunded {} lamports to {}",
            refund_amount,
            self.session.owner
        );
        Ok(())
    }
}
