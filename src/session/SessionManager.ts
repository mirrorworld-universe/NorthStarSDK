import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { checkedHash, checkedInteger, Hash32 } from "../programs/continuity";
import { PortalProgram, Session } from "../programs/portal";

export interface SessionSnapshot {
  address: PublicKey;
  state: Session;
  context: Hash32;
  nextSequence: bigint;
  l1Slot: bigint;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class SessionManager {
  private readonly genesis: Hash32;
  private readonly profile: Hash32;

  constructor(
    private readonly rpc: Connection,
    private readonly portal: PortalProgram,
    private readonly l1GenesisHash: string,
    profile: Hash32,
  ) {
    this.genesis = checkedHash(bs58.decode(l1GenesisHash), "L1 genesis");
    this.profile = checkedHash(profile, "checkpoint profile");
  }

  async verifyNetwork(): Promise<void> {
    if (await this.rpc.getGenesisHash() !== this.l1GenesisHash) {
      throw new Error("L1 genesis differs from the configured network");
    }
  }

  async getSession(): Promise<SessionSnapshot> {
    await this.verifyNetwork();
    const address = await this.portal.deriveSessionPDA();
    const response = await this.rpc.getAccountInfoAndContext(address, "confirmed");
    const slot = checkedInteger(response.context.slot, 64, "L1 context slot");
    const account = response.value;
    if (!account || account.executable || !account.owner.equals(this.portal.getProgramId())) {
      throw new Error("Canonical Portal session is missing or has the wrong owner");
    }
    const state = this.portal.parseSession(account.data);
    if (!sameBytes(state.l1Genesis, this.genesis) || !sameBytes(state.profile, this.profile)) {
      throw new Error("Session network or checkpoint profile differs from configuration");
    }
    const bump = PublicKey.findProgramAddressSync([Buffer.from("session")], this.portal.getProgramId())[1];
    const expires = state.createdAt + state.ttlSlots;
    const lastSlot = expires > 0xffff_ffff_ffff_ffffn ? 0xffff_ffff_ffff_ffffn : expires;
    if (state.bump !== bump || slot < state.createdAt || slot > lastSlot) {
      throw new Error("Session binding is invalid or expired");
    }
    return {
      address,
      state,
      context: this.portal.sessionContext(address, state),
      nextSequence: checkedInteger(state.ingressCount + 1n, 64, "next input sequence"),
      l1Slot: slot,
    };
  }
}
