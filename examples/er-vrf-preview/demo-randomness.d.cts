export interface DemoLabel {
  readonly source: 'northstar:devnet-demo-randomness:v1';
  readonly network: 'devnet';
  readonly verified: false;
  readonly erCertified: false;
  readonly l1Settled: false;
}

export interface DemoDelivery extends DemoLabel {
  readonly roundId: string;
  readonly outputHex: string;
}

export interface DemoRequest extends DemoLabel {
  readonly roundId: string;
  readonly status: 'demo-accepted';
  readonly delivered: Promise<DemoDelivery>;
}

export function initDemoStore(directory: string): Promise<void>;
export function openDevnetDemoRandomness(options: {
  network: 'devnet';
  directory: string;
  onDemoRandomness: (roundId: string, value: Uint8Array, metadata: DemoLabel) => void | Promise<void>;
}): Promise<{ readonly requestRandomness: (roundId: string) => DemoRequest }>;
