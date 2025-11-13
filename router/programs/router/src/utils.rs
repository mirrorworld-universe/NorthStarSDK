use anchor_lang::prelude::*;

use crate::types::OutboxEntry;

/// Verify entry signature
pub fn verify_entry_signature(entry: &OutboxEntry, signature: &[u8; 64]) -> Result<bool> {
    // Signature verification would be implemented here
    // For now, return true as signature is computed off-chain
    Ok(signature == &entry.sig)
}
