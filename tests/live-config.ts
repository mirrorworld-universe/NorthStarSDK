const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function assertDevelopmentDeployment(
  genesis: string,
  endpoint: string,
  sandbox = process.env.NORTHSTAR_SANDBOX === "1",
): void {
  if (genesis === MAINNET_GENESIS) throw new Error("Funded integration tests never run on mainnet");
  const address = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname);
  const hostOptIn = process.env.NORTHSTAR_ALLOW_LOCAL_HOST_E2E === "1";
  if (genesis !== DEVNET_GENESIS && !(local && (sandbox || hostOptIn))) {
    throw new Error("Funded integration tests require devnet or an explicitly approved local deployment");
  }
}
