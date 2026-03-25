import { Address, address } from '@solana/addresses';
import {
  PortalProgram,
  OpenSessionParams,
  PORTAL_PROGRAM_ID,
} from '../programs/portal';

export interface Session {
  pda: Address;
  gridId: number;
  owner: Address;
  feeCap: bigint;
  ttlSlots: bigint;
  createdAt: number;
  status: 'active' | 'expired' | 'closed';
}

export interface OpenSessionParamsSDK {
  owner: Address;
  gridId: number;
  ttlSlots?: bigint;
  feeCap?: bigint;
}

export class SessionManager {
  private portalProgramId: Address;
  private sessions: Map<string, Session> = new Map();

  constructor(portalProgramId: Address = PORTAL_PROGRAM_ID) {
    this.portalProgramId = portalProgramId;
  }

  /**
   * Open a new session for Portal operations
   * Creates and tracks a session for delegated execution
   *
   * @param params - Session creation parameters
   * @returns Session address
   */
  async openSession(params: OpenSessionParamsSDK): Promise<Address> {
    const { owner, gridId, feeCap = BigInt(1_000_000), ttlSlots = BigInt(2000) } = params;

    const sessionPDA = await PortalProgram.deriveSessionPDA(owner, gridId, this.portalProgramId);

    const session: Session = {
      pda: sessionPDA,
      gridId,
      owner,
      feeCap,
      ttlSlots,
      createdAt: Date.now(),
      status: 'active',
    };

    this.sessions.set(sessionPDA, session);

    console.log(`✓ Session opened: ${sessionPDA}`);
    console.log(`  Grid ID: ${gridId}`);
    console.log(`  Fee Cap: ${feeCap} lamports`);
    console.log(`  TTL: ${ttlSlots} slots`);

    return sessionPDA;
  }

  /**
   * Get session information
   */
  async getSession(sessionPDA: Address): Promise<Session | null> {
    return this.sessions.get(sessionPDA) || null;
  }

  /**
   * Check if session is still valid
   */
  async isSessionValid(sessionPDA: Address): Promise<boolean> {
    const session = await this.getSession(sessionPDA);
    if (!session) return false;

    const slotDuration = 400;
    const maxAge = Number(session.ttlSlots) * slotDuration;
    const age = Date.now() - session.createdAt;

    return session.status === 'active' && age < maxAge;
  }

  /**
   * Close a session
   */
  async closeSession(sessionPDA: Address): Promise<void> {
    const session = this.sessions.get(sessionPDA);
    if (session) {
      session.status = 'closed';
      console.log(`✓ Session closed: ${sessionPDA}`);
    }
  }

  /**
   * List all active sessions
   */
  getActiveSessions(): Session[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === 'active'
    );
  }
}
