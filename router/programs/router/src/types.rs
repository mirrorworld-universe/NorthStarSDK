use anchor_lang::prelude::*;
use solana_hash::Hash;

/// Embedded operation opcodes
#[derive(
    Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, AnchorSerialize, AnchorDeserialize,
)]
// TODO: add
// #[borsh(use_discriminant = true)]
pub enum EmbeddedOpcode {
    /// Swap operation
    Swap,
    // Future: Route, AddLiquidity, etc.
}

impl EmbeddedOpcode {
    pub const SIZE: usize = 1;
}

/// Parameters for embedded swap operation
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EmbeddedParams {
    /// Input token mint
    pub in_mint: Pubkey,
    /// Output token mint
    pub out_mint: Pubkey,
    /// Amount to swap
    pub amount_in: u64,
    /// Slippage tolerance in basis points
    pub slippage_bps: u16,
    /// Deadline slot for execution
    pub deadline_slot: u64,
    /// Expected execution plan hash (0 = none)
    pub expected_plan_hash: [u8; 32],
}

/// Simplified account metadata that can be serialized
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
// TODO: this will be obsolete once anchor upgrades to borsh v1
pub struct SerializableAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl From<AccountMeta> for SerializableAccountMeta {
    fn from(meta: AccountMeta) -> Self {
        Self {
            pubkey: meta.pubkey,
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        }
    }
}

impl From<SerializableAccountMeta> for AccountMeta {
    fn from(val: SerializableAccountMeta) -> Self {
        AccountMeta {
            pubkey: val.pubkey,
            is_signer: val.is_signer,
            is_writable: val.is_writable,
        }
    }
}

/// Invoke mode parameters
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum SonicMsgInner {
    InvokeCall {
        /// Target program to invoke on Sonic
        target_program: Pubkey,
        /// Accounts required for the call
        accounts: Vec<SerializableAccountMeta>,
        /// Instruction data
        data: Vec<u8>,
    },
    EmbeddedOpcode {
        opcode: EmbeddedOpcode,
        params: EmbeddedParams,
    },
}

/// Sonic message structure
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SonicMsg {
    /// Target grid ID
    pub grid_id: u64,
    /// Nonce for replay protection
    pub nonce: u128,
    /// Time-to-live in slots
    pub ttl_slots: u64,
    /// Inner message
    pub inner: SonicMsgInner,
}

/// Outbox entry structure
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OutboxEntry {
    /// Entry owner
    pub owner: Pubkey,
    /// Associated session
    pub session: Pubkey,
    /// Fee budget for this entry
    pub fee_budget: u64,
    /// The Sonic message
    pub msg: SonicMsg,
    /// Signature over the entry
    // TODO: Make it proper signature
    pub sig: [u8; 64],
}

impl OutboxEntry {
    pub fn hash(&self) -> Hash {
        let mut hasher = solana_sha256_hasher::Hasher::default();
        hasher.hashv(&[
            self.owner.as_array(),
            self.session.as_array(),
            &self.fee_budget.to_le_bytes(),
            &self.msg.nonce.to_le_bytes(),
        ]);
        hasher.result()
    }
}
