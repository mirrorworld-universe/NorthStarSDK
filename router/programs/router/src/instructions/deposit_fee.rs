use anchor_lang::{prelude::*, solana_program::system_instruction::transfer};

use crate::state::FeeVault;

#[derive(Accounts)]
pub struct DepositFee<'info> {
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

impl<'info> DepositFee<'info> {
    pub fn deposit_fee(&mut self, amount: u64) -> Result<()> {
        // Transfer SOL from owner to fee vault
        let transfer_ix = transfer(&self.owner.key(), &self.fee_vault.key(), amount);

        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                self.owner.to_account_info(),
                self.fee_vault.to_account_info(),
                self.system_program.to_account_info(),
            ],
        )?;

        // Update tracked balance
        self.fee_vault.deposit(amount)?;

        msg!("Deposited {} lamports to fee vault", amount);
        msg!("New balance: {} lamports", self.fee_vault.balance);

        Ok(())
    }
}
