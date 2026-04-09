import { PublicKey } from "@solana/web3.js";
import { PortalProgram } from "../programs/portal";

export interface Session {
  pda: PublicKey;
  gridId: number;
  owner: PublicKey;
  feeCap: bigint;
  ttlSlots: bigint;
  createdAt: number;
  status: "active" | "expired" | "closed";
}

export interface OpenSessionParamsSDK {
  owner: PublicKey;
  gridId: number;
  ttlSlots?: bigint;
  feeCap?: bigint;
}

export class SessionManager {
  private portalProgramId: PublicKey;
  private sessions: Map<string, Session> = new Map();

  constructor(portalProgramId: PublicKey) {
    this.portalProgramId = portalProgramId;
  }

  /**
   * Open a new session for Portal operations
   * Creates and tracks a session for delegated execution
   *
   * @param params - Session creation parameters
   * @returns Session address
   */
  async openSession(params: OpenSessionParamsSDK): Promise<PublicKey> {
    const {
      owner,
      gridId,
      feeCap = BigInt(1_000_000),
      ttlSlots = BigInt(2000),
    } = params;

    const sessionPDA = await PortalProgram.deriveSessionPDA(
      owner,
      gridId,
      this.portalProgramId,
    );

    const session: Session = {
      pda: sessionPDA,
      gridId,
      owner,
      feeCap,
      ttlSlots,
      createdAt: Date.now(),
      status: "active",
    };

    this.sessions.set(sessionPDA.toBase58(), session);

    console.log(`✓ Session opened: ${sessionPDA}`);
    console.log(`  Grid ID: ${gridId}`);
    console.log(`  Fee Cap: ${feeCap} lamports`);
    console.log(`  TTL: ${ttlSlots} slots`);

    return sessionPDA;
  }

  /**
   * Get session information
   */
  async getSession(sessionPDA: PublicKey): Promise<Session | null> {
    return this.sessions.get(sessionPDA.toBase58()) || null;
  }

  /**
   * Check if session is still valid
   */
  async isSessionValid(sessionPDA: PublicKey): Promise<boolean> {
    const session = await this.getSession(sessionPDA);
    if (!session) return false;

    const slotDuration = 400;
    const maxAge = Number(session.ttlSlots) * slotDuration;
    const age = Date.now() - session.createdAt;

    return session.status === "active" && age < maxAge;
  }

  /**
   * Close a session
   */
  async closeSession(sessionPDA: PublicKey): Promise<void> {
    const session = this.sessions.get(sessionPDA.toBase58());
    if (session) {
      session.status = "closed";
      console.log(`✓ Session closed: ${sessionPDA}`);
    }
  }

  /**
   * List all active sessions
   */
  getActiveSessions(): Session[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "active",
    );
  }
}
