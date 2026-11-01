import { assertDevelopmentDeployment } from "./live-config";

describe("funded development deployment guard", () => {
  test("accepts the complete devnet identity and explicit sandbox-local deployments", () => {
    expect(() => assertDevelopmentDeployment("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "https://api.devnet.solana.com", false)).not.toThrow();
    expect(() => assertDevelopmentDeployment("local-genesis", "http://127.0.0.1:8899", true)).not.toThrow();
  });

  test("rejects mainnet even behind a loopback endpoint and rejects unbound public networks", () => {
    expect(() => assertDevelopmentDeployment("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "http://127.0.0.1:8899", true)).toThrow("never run on mainnet");
    expect(() => assertDevelopmentDeployment("unknown-genesis", "https://api.devnet.solana.com", true)).toThrow();
    expect(() => assertDevelopmentDeployment("local-genesis", "http://localhost:8899", false)).toThrow();
  });
});
